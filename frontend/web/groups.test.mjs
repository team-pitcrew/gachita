import assert from "node:assert/strict";
import { test } from "node:test";
import { groupCode, memberHeading, readiness, swapSeats } from "./groups.js";

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
