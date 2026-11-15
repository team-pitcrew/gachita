import assert from "node:assert/strict";
import { test } from "node:test";
import { actionOf, arrivalBriefing, deriveTodos, mentions, todoOf, TODO_METHOD, TODO_METHOD_V2 } from "./todos.js";

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

// v2 도착 브리핑(T141): 디자인의 문장으로 분류·물건·수량·요청한 사람·제목을 본다.
const action = (text, ...speakers) => {
  const lines = (speakers.length ? speakers : [undefined]).map((participantId, i) => ({ device: "car", seq: i + 1, at: i + 1, text, ...(participantId ? { participantId } : {}) }));
  const [todo] = deriveTodos(lines);
  return todo && { place: todo.place, category: todo.category, title: todo.title, items: todo.items, requestedBy: todo.requestedBy, method: todo.method };
};

test("디자인의 부탁을 분류별 행동 항목으로: 물건을 나누고 수량을 600g·1봉지·2병으로 맞춥니다", () => {
  assert.deepEqual(action("마트에서 삼겹살 600g이랑 귤 한 봉지 사 가자", "mom"),
    { place: "마트", category: "buy", title: "삼겹살 600g이랑 귤 한 봉지 사 가기", items: [{ name: "삼겹살", qty: "600g" }, { name: "귤", qty: "1봉지" }], requestedBy: ["mom"], method: "place-rules-v2" });
  assert.deepEqual(action("하나로마트 가면 화장실 먼저 가야 돼", "haeun"),
    { place: "하나로마트", category: "first", title: "화장실 먼저 다녀오기", items: [{ name: "화장실", qty: null }], requestedBy: ["haeun"], method: "place-rules-v2" });
  assert.deepEqual(action("숙소에서 고기는 바로 냉장 보관해야 돼", "mom"),
    { place: "숙소", category: "remember", title: "고기는 바로 냉장 보관", items: [{ name: "고기 냉장 보관", qty: null }], requestedBy: ["mom"], method: "place-rules-v2" });
  assert.deepEqual(action("숙소 가서 가방 챙겨야지"),
    { place: "숙소", category: "bring", title: "가방 챙기기", items: [{ name: "가방", qty: null }], requestedBy: [], method: "place-rules-v2" });
  assert.deepEqual(action("숙소에서 체크인하고 가방 내려야 돼").title, "체크인하고 가방 내리기");
  assert.deepEqual(action("마트에서 젤리 한 봉지하고 탄산수 2병 사자").items, [{ name: "젤리", qty: "1봉지" }, { name: "탄산수", qty: "2병" }]);
  assert.deepEqual(action("마트에서 고기랑 과일도 사 가자").items, [{ name: "고기", qty: null }, { name: "과일", qty: null }]);
  assert.deepEqual(action("숙소에서는 아이 가방부터 꺼내야지").items, [{ name: "아이 가방", qty: null }]);
  assert.equal(action("휴게소에서 화장실 급해요").category, "first", "'급해'와 존댓말 끝도 받습니다");
  assert.equal(action("마트에서 물 먼저 사자").category, "first", "먼저 할 일이 살 것보다 앞섭니다");
});

test("수량·단위가 섞이거나 없거나 모르는 단위면 지어내지 않습니다", () => {
  assert.deepEqual(action("마트에서 사과 두 개, 그리고 우유 1리터 사 와야지").items, [{ name: "사과", qty: "2개" }, { name: "우유 1리터", qty: null }], "'사과'의 과는 이음 조사가 아니고, 리터는 모르는 단위라 이름에 남깁니다");
  assert.deepEqual(action("마트에서 소고기 1.5kg과 맥주 세 캔 그리고 오징어 두 마리 사자").items,
    [{ name: "소고기", qty: "1.5kg" }, { name: "맥주", qty: "3캔" }, { name: "오징어", qty: "2마리" }]);
  assert.deepEqual(action("마트에서 노랑 풍선 사자").items, [{ name: "노랑 풍선", qty: null }], "한 글자 + 랑은 이음 조사로 보지 않습니다");
  assert.deepEqual(action("마트에서 포도 사자").items, [{ name: "포도", qty: null }], "짧은 낱말 끝의 '도'는 떼지 않습니다");
  assert.deepEqual(action("마트에서 사자").items, [], "물건을 말하지 않으면 항목을 만들지 않습니다");
  assert.equal(action("숙소에서 내려야 돼").category, "remember", "짐 없이 '내리다'만이면 챙길 것이 아닙니다");
});

test("요청한 사람은 출처 발화의 확인된 화자를 중복 없이, 처음 말한 순서로 모읍니다", () => {
  assert.deepEqual(action("마트에서 우유 사자", "mom", undefined, "dad", "mom").requestedBy, ["mom", "dad"]);
  const [todo] = deriveTodos([{ device: "car", seq: 1, at: 1, text: "마트에서 우유 사자" }]);
  assert.deepEqual(actionOf(todo).requestedBy, []);
});

test("v1이 뽑던 문장의 장소·글·id는 그대로라 저장된 완료 상태를 잃지 않습니다", () => {
  for (const [text, place] of [["마트에서 우유랑 간식 사자", "마트"], ["집에서 나오기 전에 마트에서 물 사야 돼", "마트"], ["숙소에서는 아이 가방부터 꺼내야지", "숙소"], ["마트에서 장 보고 숙소 가서 쉬자", "마트"]])
    assert.equal(todoOf(text).place, place, text);
  assert.equal(todoOf("하나로마트 가면 화장실 먼저 가야 돼").place, "하나로마트");
  assert.equal(todoOf("숙소에 가서 가방 챙겨야지").place, "숙소");
  for (const text of ["어디 가면 좋을까", "마트 가면 뭐 살까", "마트 들러서 우유 사자"]) assert.equal(todoOf(text), null, text);
});

// v3 문맥 규칙(T167, D# 실흐름): 장소 없이 의무형으로 끝나는 말은 앞 30초 안에 나온 여행 장소의 할 일. 대사는 시연 대화의 두 줄(이름 없음).
const T0 = 1_700_000_000_000;
const pick = (todos) => todos.map(({ place, text, category, title, items, method }) => ({ place, text, category, title, items, method }));
test("v3: 앞 30초 안에 여행 장소가 나왔으면 장소 없는 의무형도 그 장소의 할 일이다(교정본·차 받아쓰기 둘 다)", () => {
  const gold = [
    { device: "car", seq: 1, at: T0 + 515_700, text: "어머, 정자동 카페거리 집에서 가까워요?", participantId: "p1" },
    { device: "car", seq: 2, at: T0 + 520_600, text: "근데 하나 더 생각하셔야 될 게, 제가 주차할 공간도 생각하셔야 돼요.", participantId: "p2" },
  ];
  const want = { place: "정자카페거리", category: "remember", title: "주차할 공간 생각하기", items: [{ name: "주차할 공간", qty: null }], method: TODO_METHOD };
  const [todo, ...more] = deriveTodos(gold, [], ["정자 카페거리"]);
  assert.deepEqual(more, []);
  assert.deepEqual(pick([todo])[0], { ...want, text: "근데 하나 더 생각하셔야 될 게, 제가 주차할 공간도 생각하셔야 돼요" });
  assert.deepEqual(todo.requestedBy, ["p2"], "요청한 사람은 의무형을 말한 사람");
  // 차가 실제로 받아 적은 글: 물음표 없이 순서가 바뀌고 '될될 게'처럼 받아쓰기 반복이 있어도 끝(END)으로 잡는다
  const car = [
    { device: "car", seq: 1, at: T0 + 90_000, text: "정자동 카페거리 가까워요 집에서?" },
    { device: "car", seq: 2, at: T0 + 93_000, text: "어 뭐 그렇죠? 근데 하나 더 생각하셔야 될될 게 제가 주차할 공간도 생각하셔야 돼요" },
  ];
  assert.deepEqual(pick(deriveTodos(car, [], ["정자 카페거리"])), [{ ...want, text: car[1].text }]);
  // 도착 브리핑은 내비 이름(띄어쓰기 있음)으로 맞춘다
  const p = { lat: 37.36, lng: 127.11 };
  const brief = arrivalBriefing({ place: { name: "정자 카페거리", ...p }, position: p, parked: true, observedAt: T0, source: "car" }, deriveTodos(car, [], ["정자 카페거리"]), T0);
  assert.deepEqual([brief.eligible, brief.items.map((t) => t.title), brief.method], [true, ["주차할 공간 생각하기"], TODO_METHOD]);
});

test("v3: 장소 언급이 없거나, 30초가 지났거나, 여행 장소가 없으면 붙이지 않는다", () => {
  const ask = (at) => ({ device: "car", seq: 2, at, text: "제가 주차할 공간도 생각하셔야 돼요" });
  const near = { device: "car", seq: 1, at: T0, text: "정자동 카페거리 가까워요?" };
  assert.deepEqual(deriveTodos([{ ...near, text: "오늘 날씨 좋다" }, ask(T0 + 3000)], [], ["정자 카페거리"]), [], "장소 언급 없는 의무형은 그대로 무시");
  assert.deepEqual(deriveTodos([near, ask(T0 + 30_001)], [], ["정자 카페거리"]), [], "30초가 지나면 붙지 않음");
  assert.equal(deriveTodos([near, ask(T0 + 30_000)], [], ["정자 카페거리"]).length, 1, "30초까지는 붙음");
  assert.deepEqual(deriveTodos([near, ask(T0 + 3000)]), [], "여행 장소를 모르면(v2와 같음) 붙이지 않음");
  assert.deepEqual(deriveTodos([near, { ...ask(T0 + 3000), text: "정자동 카페거리 좋네" }], [], ["정자 카페거리"]), [], "의무형이 아니면 할 일이 아님");
});

test("v3: 장소 맞추기 — 행정동 '동'을 떼거나 세 글자 이상 낱말이 겹치면 같은 장소, 다른 곳은 아님", () => {
  assert.ok(mentions("정자동 카페거리 가까워요 집에서?", "정자 카페거리"));
  assert.ok(mentions("카페거리 쪽으로 가요", "정자 카페거리"));
  assert.ok(mentions("하나로마트 들르자", "하나로마트 강릉점"));
  for (const text of ["정자역 가자", "카페 가자", "정자에서 쉬자"]) assert.equal(mentions(text, "정자 카페거리"), false, text);
});

test("v3: v2가 뽑던 문장은 여행 장소를 줘도 id·method가 그대로다", () => {
  const lines = [
    { device: "car", seq: 1, at: T0, text: "하나로마트 가면 고기랑 과일 사야 돼" },
    { device: "car", seq: 2, at: T0 + 1000, text: "숙소에서 아이 가방부터 꺼내야지" },
  ];
  const before = deriveTodos(lines), after = deriveTodos(lines, [], ["하나로마트", "강릉 숙소"]);
  assert.deepEqual(after.map((t) => [t.id, t.place, t.method]), before.map((t) => [t.id, t.place, t.method]));
  assert.ok(after.every((t) => t.method === TODO_METHOD_V2));
});
