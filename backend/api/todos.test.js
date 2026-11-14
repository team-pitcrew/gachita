import assert from "node:assert/strict";
import { test } from "node:test";
import { arrivalBriefing, deriveTodos, todoOf } from "./todos.js";

test("차량의 장소·권유 규칙으로만 뽑고 물건 이름·일반 대화는 할 일로 만들지 않습니다", () => {
  for (const text of ["마트에서 우유랑 간식 사자", "숙소에서는 아이 가방부터 꺼내야지", "집에서 나오기 전에 마트에서 물 사야 돼."]) assert.ok(todoOf(text));
  assert.equal(todoOf("집에서 나오기 전에 마트에서 물 사야 돼.").place, "마트");
  for (const text of ["마트에서 피자", "숙소에서 과자", "화장실 가고 싶어", "마트에서 샀어", "마트 들러서 우유 사자"]) assert.equal(todoOf(text), null);
});

test("교정본과 원발화를 같이 보존하고 반복된 같은 할 일은 완료 상태를 되살리지 않습니다", () => {
  const line = { device: "car", seq: 1, at: 1, text: "마토에서 물 사자", displayText: "마트에서 물 사자" };
  const first = deriveTodos([line])[0];
  const repeated = deriveTodos([line, { ...line, seq: 2, at: 2 }], [{ id: first.id, status: "done", version: 3 }]);
  assert.equal(repeated.length, 1); assert.equal(repeated[0].status, "done");
  assert.equal(repeated[0].version, 3); assert.equal(repeated[0].sources.length, 2);
  assert.deepEqual(repeated[0].sources[0], { device: "car", seq: 1, at: 1, text: line.text, displayText: line.displayText });
  assert.notEqual(deriveTodos([{ ...line, displayText: "숙소에서 물 마시자" }])[0].id, first.id);
  assert.deepEqual(deriveTodos([{ ...line, text: "" }], [{ ...first }]), [], "지운 원문을 교정본으로 되살리지 않습니다");
});

test("최신 위치·주차·거리 근거가 모두 있을 때 해당 장소의 미완료 항목만 브리핑합니다", () => {
  const at = Date.now(), p = { lat: 37.75, lng: 128.9 };
  const input = { place: { name: "이마트 강릉점", ...p }, position: p, parked: true, observedAt: at, source: "browser" };
  const items = [{ place: "마트", status: "pending" }, { place: "숙소", status: "pending" }, { place: "마트", status: "done" }];
  assert.deepEqual(arrivalBriefing(input, items, at).items, [items[0]]);
  for (const [change, reason] of [[{ parked: false }, "not_parked"], [{ observedAt: at - 60001 }, "stale_position"], [{ position: { ...p, lat: p.lat + .02 } }, "outside_place"]]) {
    const result = arrivalBriefing({ ...input, ...change }, items, at);
    assert.equal(result.eligible, false); assert.equal(result.reason, reason); assert.deepEqual(result.items, []);
  }
  const justOutside = { ...input, position: { ...p, lat: p.lat + 250.4 / 6_371_000 * 180 / Math.PI } };
  assert.equal(arrivalBriefing(justOutside, items, at).reason, "outside_place", "표시용 반올림 때문에 250m 밖을 도착으로 처리하지 않습니다");
});
