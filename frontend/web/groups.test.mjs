import assert from "node:assert/strict";
import { test } from "node:test";
import { fillSeats, groupCode, groupLine, lostSeats, memberHeading, readiness, seatPick, seatRows, seatTo, swapSeats } from "./groups.js";

const O = "https://gachita.mangowhois.ai";

test("초대 링크는 같은 출처의 /?group=코드만 읽는다(코드 입력·QR·링크가 같은 초대)", () => {
  assert.equal(groupCode(`${O}/?group=FAMILY-2714`, O), "FAMILY-2714");
  assert.equal(groupCode(`${O}/?group=trip-5812`, O), "TRIP-5812", "소문자도 같은 코드");
  assert.equal(groupCode("/?group=FAMILY-2714", O), "FAMILY-2714", "서버가 준 상대 주소");
  for (const bad of ["https://evil.example/?group=FAMILY-2714", `${O}/demo?group=FAMILY-2714`, `${O}/?group=FAMILY-27`, `${O}/?group=HOME-1234`, `${O}/`, "::"])
    assert.equal(groupCode(bad, O), null, bad);
});

test("좌석 바꾸기(P14)는 두 사람의 자리만 맞바꾼다", () => {
  const members = [
    { profileId: "dad", name: "아빠", seat: "ROW_1_LEFT" },
    { profileId: "son", name: "서준", seat: "ROW_2_LEFT" },
    { profileId: "girl", name: "하은", seat: "ROW_2_RIGHT" },
    { profileId: "aunt", name: "이모", seat: null },
  ];
  assert.deepEqual(swapSeats(members, "son", "girl").map((m) => m.seat), ["ROW_1_LEFT", "ROW_2_RIGHT", "ROW_2_LEFT", null]);
  assert.deepEqual(swapSeats(members, "aunt", "dad").map((m) => m.seat), [null, "ROW_2_LEFT", "ROW_2_RIGHT", "ROW_1_LEFT"], "자리 없는 사람과 바꾸면 자리를 넘겨받음");
});

test("우리 가족(P13) 아래 줄과 가족 추가(P09·P39·P40)의 제목", () => {
  const all = [{ consent: true, hasVoice: true }, { consent: true, hasVoice: true }];
  assert.equal(readiness(all), "동의와 목소리 등록 완료 / 다음 탑승부터 자동 기록 켜짐");
  assert.equal(readiness([...all, { consent: false, hasVoice: true }]), "녹음 동의 2/3명 / 목소리 등록 3/3명");
  const me = { id: "dad", name: "민준" };
  const g = (members) => ({ members: [{ profileId: "dad", name: "민준", role: "owner" }, ...members] });
  assert.deepEqual(memberHeading(g([]), me), ["우리 가족 추가", "기존 계정 연결 또는 아이 프로필 직접 만들기"]);
  assert.deepEqual(memberHeading(g([{ profileId: "mom", name: "엄마", role: "adult" }]), me), ["엄마가 함께해요", "엄마 계정 연결 완료 / 이제 아이를 추가해 주세요."]);
  assert.equal(memberHeading(g([{ profileId: "x", name: "지환", role: "adult" }]), me)[0], "지환이 함께해요");
  assert.deepEqual(memberHeading(g([{ profileId: "mom", name: "엄마", role: "adult" }, { profileId: "son", name: "서준", role: "child" }]), me), ["서준까지 준비됐어요", "민준, 엄마, 서준 준비 완료 / 다음 아이를 추가해 주세요."]);
});

test("자리 없는 사람을 빈자리에 앉히고, 남의 자리에 앉히면 그 사람은 옮긴 사람의 원래 자리로 간다", () => {
  const m = [{ profileId: "dad", seat: "ROW_1_LEFT" }, { profileId: "kid", seat: null }, { profileId: "mom", seat: "ROW_1_RIGHT" }];
  assert.deepEqual(seatTo(m, "kid", "ROW_2_LEFT").map((x) => x.seat), ["ROW_1_LEFT", "ROW_2_LEFT", "ROW_1_RIGHT"]);
  assert.deepEqual(seatTo(m, "kid", "ROW_1_RIGHT").map((x) => x.seat), ["ROW_1_LEFT", "ROW_1_RIGHT", null]);
  assert.deepEqual(seatTo(m, "dad", "ROW_2_RIGHT").map((x) => x.seat), ["ROW_2_RIGHT", null, "ROW_1_RIGHT"]);
});

test("앉은 사람을 고른 뒤 자리 없는 사람을 누르면 고른 사람만 바뀌고, 누구도 자리를 잃지 않는다(#413 재점검)", () => {
  const members = [
    { profileId: "mom", name: "엄마", seat: "ROW_1_LEFT" },
    { profileId: "son", name: "서준", seat: null },
    { profileId: "girl", name: "하은", seat: "ROW_2_RIGHT" },
  ];
  // 엄마(앉음)를 고른 뒤 '자리 없음' 줄의 서준을 누름 → 맞바꾸지 않고 서준을 고름
  const a = seatPick(members, "mom", { member: "son" });
  assert.deepEqual(a, { picked: "son" });
  // 서준(자리 없음) → 엄마의 자리: 앉은 사람이 있어 막음, 엄마는 그대로
  const b = seatPick(members, "son", { member: "mom", seat: "ROW_1_LEFT" });
  assert.equal(b.members, undefined);
  assert.equal(b.picked, "son");
  assert.match(b.note, /빈자리를 눌러/);
  // 서준 → 빈자리: 앉힘
  const c = seatPick(members, "son", { seat: "ROW_2_LEFT" });
  assert.deepEqual(c.members.map((m) => m.seat), ["ROW_1_LEFT", "ROW_2_LEFT", "ROW_2_RIGHT"]);
  // 앉은 사람끼리는 맞바꿈
  assert.deepEqual(seatPick(members, "mom", { member: "girl", seat: "ROW_2_RIGHT" }).members.map((m) => m.seat), ["ROW_2_RIGHT", null, "ROW_1_LEFT"]);
  // 고른 사람이 없을 때 빈자리를 누르면 안내만, 같은 사람을 다시 누르면 해제
  assert.equal(seatPick(members, null, { seat: "ROW_2_LEFT" }).note, "먼저 앉힐 사람을 눌러 주세요.");
  assert.deepEqual(seatPick(members, "son", { member: "son" }), { picked: null });
  // 어떤 순서로 눌러도 앉아 있던 사람이 자리를 잃지 않는다
  for (const first of ["mom", "son", "girl"]) for (const target of [{ member: "son" }, { seat: "ROW_1_LEFT", member: "mom" }, { seat: "ROW_2_RIGHT", member: "girl" }, { seat: "ROW_2_LEFT" }]) {
    const r = seatPick(members, first, target);
    if (r.members) assert.deepEqual(lostSeats(members, r.members), [], `${first} → ${JSON.stringify(target)}`);
  }
  // 막는 장치: 저장한 그룹에서 앉아 있던 사람이 자리 없음이 되면 알아낸다
  assert.deepEqual(lostSeats(members, swapSeats(members, "mom", "son")).map((m) => m.name), ["엄마"]);
});

test("그룹 한 줄과 구성원·저장된 좌석(P16A·P16L)", () => {
  const family = { kind: "family", members: [
    { name: "하은", seat: "ROW_2_RIGHT" }, { name: "아빠", seat: "ROW_1_LEFT" }, { name: "이모", seat: null }, { name: "엄마", seat: "ROW_1_RIGHT" },
  ] };
  assert.equal(groupLine(family), "4명  |  기본 그룹");
  assert.deepEqual(seatRows(family.members), [["운전석", "아빠"], ["조수석", "엄마"], ["뒤 오른쪽", "하은"], ["자리 없음", "이모"]], "자리 순서, 자리 없는 사람은 마지막 한 줄");
  const solo = { kind: "guest", members: [{ name: "민준", seat: "ROW_1_LEFT" }], invite: { code: "TRIP-5812" } };
  assert.equal(groupLine(solo), "1명  |  초대 대기");
  assert.equal(groupLine({ ...solo, invite: null }), "1명  |  동승 그룹");
  assert.equal(groupLine({ ...solo, members: [...solo.members, { name: "지우" }] }), "2명  |  동승 그룹");
});

test("출발 전에 자리 없는 구성원(초대·QR 참여)을 빈자리에 앞줄부터 앉힌다(P43 '자리 없음'으로 혼자 출발하던 것)", () => {
  const m = (profileId, seat = null) => ({ profileId, name: profileId, seat });
  assert.deepEqual(fillSeats([m("jm", "ROW_1_LEFT"), m("ji"), m("jh"), m("mj")]), { ji: "ROW_1_RIGHT", jh: "ROW_2_LEFT", mj: "ROW_2_RIGHT" });
  assert.deepEqual(fillSeats([m("a", "ROW_1_LEFT"), m("b", "ROW_1_RIGHT")]), {}, "모두 앉았으면 바꾸지 않는다");
  const five = fillSeats([m("a", "ROW_1_LEFT"), m("b", "ROW_1_RIGHT"), m("c", "ROW_2_LEFT"), m("d", "ROW_2_RIGHT"), m("e"), m("f")]);
  assert.deepEqual(five, { e: "ROW_2_CENTER" }, "뒤 가운데는 마지막, 빈자리가 모자라면 남는 사람은 그대로");
});
