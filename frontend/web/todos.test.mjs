import assert from "node:assert/strict";
import { test } from "node:test";
import { groupTodos, placeMatches, speakerOf, todoAccess } from "./todos.js";

const todo = (id, place, status, at) => ({ id, place, text: `${place}에서 ${id}`, status, version: 0, sources: [{ device: "car", seq: at, at, text: id, displayText: id }] });
const items = [todo("가방", "숙소", "pending", 3000), todo("우유", "마트", "pending", 1000), todo("간식", "마트", "done", 500), todo("물", "마트", "pending", 2000)];

test("할 일은 기록에 동의하고 이 폰에서 연결한 참가자에게만 보인다", () => {
  assert.equal(todoAccess({ id: "p", consent: true }, "token"), "");
  assert.match(todoAccess({ id: "p", consent: false }, "token"), /동의/);
  assert.match(todoAccess({ id: "p", consent: true }, null), /이 폰/);
  assert.match(todoAccess(undefined, "token"), /동의/);
});

test("도착 장소가 없으면 도착했다고 말하지 않고 장소별로만 묶는다", () => {
  const g = groupTodos(items, null);
  assert.equal(g.arrival, null);
  assert.deepEqual(g.here, []);
  assert.deepEqual(g.places.map((p) => p.place), ["마트", "숙소"], "처음 말한 순서");
  assert.deepEqual(g.places[0].items.map((t) => t.id), ["우유", "물", "간식"], "미완료가 먼저");
  assert.equal(g.pending, 3);
});

test("서버가 알려 준 도착 장소의 미완료 항목만 맨 위로 올리고 아래에서 다시 보이지 않는다", () => {
  const g = groupTodos(items, { place: "이마트 강릉점", at: 1, source: "vehicle" });
  assert.deepEqual(g.here.map((t) => t.id), ["우유", "물"]);
  assert.deepEqual(g.places.map((p) => [p.place, p.items.map((t) => t.id)]), [["마트", ["간식"]], ["숙소", ["가방"]]]);
  assert.deepEqual(groupTodos(items, { place: "강릉 중앙 시장" }).here, [], "다른 장소에 도착하면 올리지 않는다");
  assert.equal(placeMatches("중앙시장", "강릉 중앙 시장"), true, "서버와 같은 이름 포함 규칙(공백 무시)");
  assert.deepEqual(groupTodos(undefined, null).places, []);
});

test("확인된 화자만 이름을 붙이고 모르면 지어내지 않는다", () => {
  const people = [{ id: "mom", name: "엄마" }];
  assert.equal(speakerOf({ participantId: "mom" }, people), "엄마");
  assert.equal(speakerOf({}, people), "말한 사람 미확인");
  assert.equal(speakerOf({ participantId: "gone" }, people), "말한 사람 미확인");
});
