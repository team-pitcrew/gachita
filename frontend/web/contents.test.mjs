// 콘텐츠 기록(F6) 화면이 서버 값으로 고르는 규칙. 실행: make check-fast
import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, contentGroups, headline, lineAt, pinLabel, placeChain, projector, styleLabel, tripLine } from "./contents.js";

const at = (h, m) => new Date(2026, 10, 14, h, m).getTime();
const places = [
  { kind: "start", name: "집", at: at(9, 20) },
  { kind: "destination", name: "강릉 숙소", at: at(9, 21) },
  { kind: "stop", name: "동해고속도로", at: at(9, 30) },
  { kind: "approaching", name: "하나로마트", at: at(9, 50) },
  { kind: "arrived", name: "하나로마트", at: at(9, 55) },
  { kind: "arrived", name: "숙소", at: at(10, 28) },
];

test("타임라인 머리는 출발 시각·들른 곳·마지막 도착 시각과 이름", () => {
  assert.equal(tripLine(places), "09:20 출발 → 동해고속도로 → 하나로마트 → 10:28 숙소");
  assert.equal(tripLine([]), "", "장소가 없으면(동의 전) 지어내지 않음");
  assert.equal(tripLine([{ kind: "start", name: "집", at: at(9, 20) }]), "09:20 출발");
});

test("지도 아래 장소 줄은 출발·곧 도착을 빼고 처음 나온 순서", () => {
  assert.equal(placeChain(places), "강릉 숙소 → 동해고속도로 → 하나로마트 → 숙소");
  assert.equal(placeChain(undefined), "");
});

test("갤러리는 콘텐츠가 있는 여행만 날짜·제목으로 묶고 여행 안은 시각 순", () => {
  const groups = contentGroups([
    { title: "빈 여행", createdAt: at(8, 0), contents: [] },
    { title: "강릉 가족 여행", createdAt: at(9, 0), startedAt: at(9, 20), contents: [{ id: "b", at: at(10, 22) }, { id: "a", at: at(9, 32) }] },
  ]);
  assert.deepEqual(groups.map((g) => [g.title, g.items.map((i) => i.id)]), [["11월 14일  강릉 가족 여행", ["a", "b"]]]);
});

test("플레이어 자막은 장면 구간 시작부터 지난 시간의 줄, 모르는 화자는 이름 없이", () => {
  const content = { from: 1000, lines: [{ at: 1000, name: "민준", text: "바다 언제 보여?" }, { at: 3000, name: "서준", text: "아빠, 아까부터 바다 보이는데?" }, { at: 5000, name: null, text: "와" }] };
  assert.equal(lineAt(content, 0).text, "바다 언제 보여?");
  assert.equal(lineAt(content, 2.5).name, "서준");
  assert.equal(lineAt(content, 9).name, null);
  assert.equal(lineAt({ lines: [] }, 3), null);
});

test("목업 글(머리글·형식 이름)과 핀 글, 시각", () => {
  assert.equal(headline({ cast: [{ name: "민준" }, { name: "서준" }] }), "민준과 서준의 이야기");
  assert.equal(headline({ cast: [{ name: "아빠" }, { name: "서준" }] }), "아빠와 서준의 이야기");
  assert.equal(headline({ title: "제목", cast: [] }), "제목");
  assert.deepEqual([styleLabel({ kind: "device" }), styleLabel({ kind: "generated" })], ["캐릭터 자막형", "가족 대화형"]);
  assert.equal(pinLabel("아빠보다 빠른 서준의 정답"), "아빠보다 빠른 서…");
  assert.equal(pinLabel("내일도 같이 타?"), "내일도 같이 타?");
  assert.equal(clock(72.4), "01:12");
});

test("좌표 투영은 상자 안, 북쪽이 위, 좌표가 없으면 null", () => {
  const p = projector([[37.5, 128.9], [37.8, 129.1]], 318, 204, 24);
  const [a, b] = [p([37.5, 128.9]), p([37.8, 129.1])];
  for (const [x, y] of [a, b]) assert.ok(x >= 0 && x <= 318 && y >= 0 && y <= 204);
  assert.ok(b[1] < a[1], "북쪽(위도 큰 쪽)이 위");
  assert.ok(b[0] > a[0], "동쪽이 오른쪽");
  assert.equal(projector([], 318, 204), null);
});
