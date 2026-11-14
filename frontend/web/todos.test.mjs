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

// 카드가 실제로 그리는 글을 본다. h()가 쓰는 만큼만 흉내 낸 DOM.
const fakeDom = () => {
  const el = () => ({ kids: [], append(...k) { this.kids.push(...k); }, setAttribute() {}, querySelectorAll: () => [] });
  globalThis.document = { createElement: el, hidden: false };
  const walk = (n, out = []) => { if (n == null) return out; if (typeof n !== "object") out.push(String(n)); else { out.push(n); n.kids?.forEach((k) => walk(k, out)); } return out; };
  return { text: (card) => walk(card).filter((x) => typeof x === "string").join("\n"), press: (card, label) => walk(card).find((x) => x.onclick && x.kids?.[0] === label).onclick() };
};
const tick = () => new Promise((ok) => setImmediate(ok));

test("수정이 권한 거부를 받으면 다시 읽기가 실패해도, 먼저 떠난 조회가 늦게 와도 받은 글을 되살리지 않는다", async () => {
  const dom = fakeDom();
  const { createTodos } = await import("./todos.js");
  const trip = { code: "TRIP01", generation: 1, version: 1, participants: [{ id: "me", name: "나", consent: true }] };
  const list = { generation: 1, items: [todo("우유", "마트", "pending", 1000)], arrival: { place: "이마트", at: 1, source: "vehicle" } };
  const calls = [];
  const request = (method, path) => new Promise((resolve, reject) => calls.push({ method, path, resolve, reject }));
  let painted = 0;
  const todos = createTodos({ getTrip: () => trip, getParticipant: () => trip.participants[0], getToken: () => "token", request, onChange: () => painted++ });
  const shown = () => dom.text(todos.card());

  todos.sync(); calls.shift().resolve(list); await tick();
  assert.match(shown(), /마트에서 우유/); assert.match(shown(), /이마트에 도착했어요/);

  // GET 성공 → PATCH 403 → GET 연결 오류
  dom.press(todos.card(), "완료");
  trip.version = 2; todos.sync(); // 그사이 떠난 조회(늦게 돌아온다)
  const [patch, slow] = calls.splice(0);
  assert.equal(patch.method, "PATCH"); assert.equal(slow.method, "GET");
  patch.reject(Object.assign(new Error("거절"), { status: 403 })); await tick();
  assert.doesNotMatch(shown(), /우유|이마트/); assert.match(shown(), /볼 수 없어요/);
  slow.resolve(list); await tick();
  assert.doesNotMatch(shown(), /우유|이마트/, "권한 거부 전에 떠난 조회는 내용을 되살리지 못한다");
  trip.version = 3; todos.sync(); calls.shift().reject(Object.assign(new Error("끊김"), { status: 0 })); await tick();
  assert.doesNotMatch(shown(), /우유|이마트/, "다시 읽기가 연결 오류여도 지운 채로 둔다");
  assert.match(shown(), /볼 수 없어요/);

  // 다시 읽기가 성공하면(권한 회복) 그때 보인다. 조회의 403도 같은 길로 지운다.
  trip.version = 4; todos.sync(); calls.shift().resolve(list); await tick();
  assert.match(shown(), /마트에서 우유/);
  trip.version = 5; todos.sync(); calls.shift().reject(Object.assign(new Error("거절"), { status: 403 })); await tick();
  assert.doesNotMatch(shown(), /우유|이마트/);
  assert.ok(painted >= 4);
  delete globalThis.document;
});
