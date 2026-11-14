// 도착 브리핑 선정 규칙의 공유 시험 벡터(T125 voice-vectors.json 방식). 차량 앱이 같은 규칙(todos.js arrivalBriefing)으로
// 차 안에서 고르므로, 이 시험은 todos.js가 파일과 같은 판정을 내는지, 차량 단위 시험은 Kotlin 구현이 같은 파일의 판정을 내는지 본다.
// 규칙을 고쳤으면 `UPDATE_ARRIVAL_VECTORS=1 node --test arrival-vectors.test.js`로 파일을 다시 만들고 차량 구현도 같이 고친다.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { arrivalBriefing } from "./todos.js";

const FILE = new URL("arrival-vectors.json", import.meta.url);
const NOW = 1_763_000_000_000;
const MART = { name: "이마트 강릉점", lat: 37.7519, lng: 128.8761 };
const ITEMS = [
  { id: "a", place: "마트", status: "pending" },
  { id: "b", place: "마트", status: "done" },
  { id: "c", place: "숙소", status: "pending" },
  { id: "d", place: "강릉점", status: "cancelled" },
];
const near = { lat: 37.7527, lng: 128.8766 }; // 약 100 m
const far = { lat: 37.7555, lng: 128.8761 }; // 약 400 m
const at = (input) => ({ source: "vehicle", parked: true, observedAt: NOW - 5_000, place: MART, position: near, ...input });

const INPUTS = [
  { name: "주차·60초 안·250 m 안: 그 장소의 대기 할 일만", input: at({}), items: ITEMS, now: NOW },
  { name: "주차가 아님", input: at({ parked: false }), items: ITEMS, now: NOW },
  { name: "위치가 60초보다 오래됨", input: at({ observedAt: NOW - 60_001 }), items: ITEMS, now: NOW },
  { name: "딱 60초는 받음", input: at({ observedAt: NOW - 60_000 }), items: ITEMS, now: NOW },
  { name: "250 m 밖", input: at({ position: far }), items: ITEMS, now: NOW },
  { name: "띄어쓰기를 보지 않는 장소 낱말", input: at({ place: { ...MART, name: "숙 소 앞" } }), items: ITEMS, now: NOW },
  { name: "할 일 없음", input: at({}), items: [], now: NOW },
];

const shape = (r) => ({ eligible: r.eligible, reason: r.reason, distanceMeters: r.distanceMeters, items: r.items.map((t) => t.id) });

if (process.env.UPDATE_ARRIVAL_VECTORS) {
  writeFileSync(FILE, JSON.stringify({
    rule: "todos.js arrivalBriefing: 주차가 아니면 not_parked, 위치가 60초보다 오래면 stale_position, 장소에서 250 m 밖이면 outside_place, 아니면 그 장소 낱말(띄어쓰기 무시)의 대기 할 일. distanceMeters는 하버사인(지구 반지름 6,371 km) 반올림",
    cases: INPUTS.map((c) => ({ ...c, expected: shape(arrivalBriefing(c.input, c.items, c.now)) })),
  }, null, 1) + "\n");
}

test("도착 브리핑: todos.js가 시험 벡터 파일과 같은 판정을 낸다", () => {
  const { cases } = JSON.parse(readFileSync(FILE, "utf8"));
  assert.equal(cases.length, INPUTS.length);
  for (const c of cases) assert.deepEqual(shape(arrivalBriefing(c.input, c.items, c.now)), c.expected, c.name);
  assert.deepEqual(cases.map((c) => c.expected.reason), [null, "not_parked", "stale_position", null, "outside_place", null, null]);
});
