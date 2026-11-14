import assert from "node:assert/strict";
import { test } from "node:test";
import { arrivalAsks, arrivalCards, askKeys, askLabel, askState, CONTINUE_ASK, createPlaces, dateRange, driveState, END_ASK, nextTarget, nearCard, placeAt, placeId, placesOf, recordingLine, rideHeading, ro, statusMoves, transcriptSections } from "./ride.js";

// 시각은 이 컴퓨터의 시간대로 만든다(표시도 같은 시간대라 어디서 돌려도 같다).
const at = (h, m, day = 14) => new Date(2026, 10, day, h, m).getTime();
const people = [
  { id: "dad", name: "아빠", seat: "ROW_1_LEFT" },
  { id: "mom", name: "엄마", seat: "ROW_1_RIGHT" },
  { id: "kid", name: "하은", seat: "ROW_2_RIGHT" },
];
const route = [
  { name: "우리 집", kind: "start", at: at(9, 20) },
  { name: "하나로마트", kind: "stop", at: at(9, 21) },
  { name: "강릉 숙소", kind: "destination", at: at(9, 21) },
];
const todo = (id, place, by, when, status = "pending") => ({ id, place, text: `${place}에서 ${id} 사자`, status, version: 0, sources: [{ device: "car", seq: when, at: at(9, when), text: id, displayText: id, ...(by ? { participantId: by } : {}) }] });

test("주행 상태는 서버의 여행 상태·기록 설정·장소 기록으로만 고른다", () => {
  assert.deepEqual(driveState({ status: "boarding" }, { places: route }), { kind: "boarding", target: "하나로마트" });
  assert.equal(driveState({ status: "driving", recording: true }, { places: route }).kind, "drive", "P17");
  assert.equal(driveState({ status: "driving", recording: false }, { places: route }).kind, "paused", "P18");
  assert.equal(driveState({ status: "driving", recording: true }).target, "", "장소 기록이 없으면 갈 곳을 지어내지 않는다");
  assert.equal(driveState({ status: "driving", recording: true, places: route }).target, "", "여행 문서의 places는 읽지 않는다(#370: 동의한 참가자만 GET /places)");
  assert.equal(driveState({ status: "ended" }, { places: route }).kind, "ended");
  assert.equal(driveState({ status: "parked" }).kind, "parked", "도착 장소를 모르면 도착했다고 말하지 않는다");
});

test("곧 도착은 마지막 장소 기록이 approaching일 때만, 확인을 누르면 다시 주행 화면", () => {
  const trip = { status: "driving", recording: true };
  const near = { id: "p4", name: "하나로마트", kind: "approaching", at: at(10, 2), etaSeconds: 170 };
  const places = [...route, near];
  assert.deepEqual(driveState(trip, { places }), { kind: "near", place: "하나로마트", eta: 170, target: "하나로마트", id: placeId(near) });
  assert.equal(driveState(trip, { places, nearSeen: placeId(near) }).kind, "drive", "확인한 곧 도착 기록은 다시 띄우지 않는다");
  assert.equal(driveState({ ...trip, recording: false }, { places }).kind, "near", "곧 도착은 기록을 멈춰도 먼저 보인다");
  assert.equal(driveState(trip, { places: [...places, { name: "하나로마트", kind: "arrived", at: at(10, 5) }] }).kind, "continue", "도착 뒤에는 곧 도착이 아니다");
});

test("주차와 도착: 서버 arrival 또는 마지막 arrived 장소가 있을 때만 P20, 다시 달리면 P21", () => {
  assert.deepEqual(driveState({ status: "parked" }, { places: route, arrival: { place: "하나로마트 강릉점" } }), { kind: "arrived", place: "하나로마트 강릉점", target: "하나로마트", final: false });
  const arrived = [...route, { name: "하나로마트", kind: "arrived", at: at(10, 5) }];
  assert.equal(driveState({ status: "parked" }, { places: arrived }).place, "하나로마트");
  assert.deepEqual(driveState({ status: "driving", recording: true }, { places: arrived }), { kind: "continue", place: "하나로마트", target: "강릉 숙소" });
  assert.equal(driveState({ status: "driving", recording: true }, { seenArrival: { place: "이마트", at: at(10, 5) } }).place, "이마트", "장소 기록이 없어도 이 폰이 본 도착이면 다시 출발");
  assert.equal(driveState({ status: "driving", recording: false }, { places: arrived }).kind, "paused", "멈춤이 다시 출발보다 먼저");
});

test("다음에 갈 곳은 도착하지 않은 첫 경유지, 다음은 목적지", () => {
  assert.equal(nextTarget(route), "하나로마트");
  assert.equal(nextTarget([...route, { name: "하나로마트", kind: "arrived" }]), "강릉 숙소");
  assert.equal(nextTarget([...route, { name: "하나로마트", kind: "arrived" }, { name: "강릉 숙소", kind: "arrived" }]), "");
});

test("제목과 부제는 시안 문구를 따르되 모르는 값은 빼고 조사를 맞춘다", () => {
  assert.equal(ro("하나로마트"), "하나로마트로");
  assert.equal(ro("강릉 숙소"), "강릉 숙소로");
  assert.equal(ro("우리 집"), "우리 집으로");
  assert.equal(ro("서울"), "서울로", "ㄹ 받침은 '로'");
  assert.equal(ro("Costco"), "Costco로");
  assert.deepEqual(rideHeading({ kind: "drive", target: "하나로마트" }, { title: "강릉 가족 여행" }), { title: "지금은 운전에 집중하세요", sub: "강릉 가족 여행 / 하나로마트로 이동 중" });
  assert.equal(rideHeading({ kind: "drive", target: "" }, { title: "강릉 가족 여행" }).sub, "강릉 가족 여행");
  assert.equal(rideHeading({ kind: "paused" }, { waiting: ["하은"] }).sub, "하은 님의 기록 동의를 기다리고 있어요.");
  assert.deepEqual(rideHeading({ kind: "near", place: "하나로마트", eta: 170 }), { title: "곧 하나로마트 도착", sub: "도착까지 약 3분" }); // 시안 P19(eZ2xs, T153)
  assert.equal(rideHeading({ kind: "near", place: "하나로마트", eta: null }).sub, "");
  const items = [todo("고기", "마트", "mom", 30)];
  const fresh = (list) => askState({ ready: true, items: list, error: "" });
  assert.equal(rideHeading({ kind: "continue", place: "하나로마트", target: "강릉 숙소" }, { asks: fresh(items) }).sub, "하나로마트의 부탁 1건 남음 / 강릉 숙소로 이동");
  assert.equal(rideHeading({ kind: "continue", place: "하나로마트", target: "강릉 숙소" }, { asks: fresh([]) }).sub, "하나로마트의 부탁은 완료 / 강릉 숙소로 이동");
  assert.equal(rideHeading({ kind: "continue", place: "하나로마트", target: "강릉 숙소" }, { asks: fresh([]) }).title, "다시, 우리 가족의 여행", "P21 실제 글");
  assert.equal(rideHeading({ kind: "continue", place: "하나로마트", target: "" }, { asks: askState(null) }).sub, "하나로마트에서 다시 출발", "할 일을 볼 수 없으면 완료했다고 말하지 않는다");
});

test("도착한 곳의 부탁을 확인된 화자별로 묶고 모르는 화자는 맨 뒤 한 묶음", () => {
  const items = [
    todo("과일", "마트", "mom", 40),
    todo("고기", "마트", "mom", 30),
    todo("물", "마트", null, 10),
    todo("간식", "마트", "kid", 35),
    todo("젤리", "마트", "kid", 36, "done"),
    todo("가방", "숙소", "dad", 5),
  ];
  const groups = arrivalAsks(items, "하나로마트 강릉점", people);
  assert.deepEqual(groups.map((g) => [g.name, g.items.map((t) => t.id)]), [["엄마", ["과일", "고기"]], ["하은", ["간식"]], ["말한 사람 미확인", ["물"]]]);
  assert.equal(groups[0].person.id, "mom");
  assert.equal(groups.at(-1).person, null);
  assert.deepEqual(arrivalAsks(items, "강릉 중앙시장", people), [], "다른 장소의 부탁은 올리지 않는다");
  assert.deepEqual(arrivalAsks(undefined, "마트", people), []);
  assert.equal(askLabel({ place: "마트", text: "마트에서 고기랑 과일도 사 가자" }), "고기랑 과일도 사 가자", "장소 카드 안에서는 '○○에서'를 뺀다");
  assert.equal(askLabel({ place: "마트", text: "마트에서도 물 사자" }), "물 사자");
  assert.equal(askLabel({ place: "숙소", text: "이따 숙소에서 쉬자" }), "이따 숙소에서 쉬자", "앞에 있지 않으면 그대로");
  assert.deepEqual(arrivalAsks([todo("물", "마트", "gone", 1)], "마트", people).map((g) => g.name), ["말한 사람 미확인"], "떠난 참가자 이름을 지어내지 않는다");
});

test("대화 기록은 'HH:MM / 장소' 머리로 묶고 부탁이 나온 줄은 따로 카드로 뺀다", () => {
  const places = [
    { name: "우리 집", kind: "start", at: at(9, 20) },
    { name: "강릉 숙소", kind: "destination", at: at(9, 20) },
    { name: "하나로마트", kind: "approaching", at: at(10, 2) },
  ];
  const line = (seq, h, m, participantId) => ({ device: "car", seq, at: at(h, m), shown: `말 ${seq}`, participantId });
  const lines = [line(1, 9, 32, "kid"), line(2, 9, 33, "dad"), line(3, 9, 34, "kid"), line(4, 9, 50, "mom"), line(5, 10, 5, "mom"), line(6, 10, 6, "kid")];
  const sections = transcriptSections(lines, { places, asks: askKeys([{ sources: [{ device: "car", seq: 5 }] }]) });
  assert.deepEqual(sections.map((s) => [s.kind, s.place, s.kind === "group" ? s.lines.map((l) => l.seq) : s.line.seq]), [
    ["group", "우리 집", [1, 2, 3]],
    ["group", "우리 집", [4]], // 5분 넘게 쉬면 새 머리
    ["ask", "하나로마트 근처", 5],
    ["group", "하나로마트 근처", [6]], // 부탁 카드 뒤에는 새 머리
  ]);
  assert.equal(placeAt(places, at(9, 0)), "", "첫 장소 기록 전에는 시각만");
  assert.equal(placeAt([{ name: "강릉 숙소", kind: "destination", at: at(9, 0) }], at(10, 0)), "", "목적지는 그 시각에 있던 곳이 아니다");
  assert.deepEqual(transcriptSections(lines.slice(0, 2)).map((s) => s.place), [""], "장소 기록이 없으면 시각만");
  assert.deepEqual(transcriptSections([]), []);
});

test("날짜 칩은 '11월 14일 / 09:20–10:28', 날을 넘기면 양쪽에 날짜", () => {
  assert.equal(dateRange(at(9, 20), at(10, 28)), "11월 14일 / 09:20–10:28");
  assert.equal(dateRange(at(9, 20), at(9, 20)), "11월 14일 / 09:20");
  assert.equal(dateRange(at(23, 50), at(0, 10, 15)), "11월 14일 23:50 – 11월 15일 00:10");
  assert.equal(dateRange(undefined, at(9, 0)), "");
});

test("기록 상태 띠와 운전석 단추는 여행 상태를 따른다", () => {
  assert.deepEqual(recordingLine({ status: "driving", recording: true }), ["차량에서 대화 기록 중", true]);
  assert.deepEqual(recordingLine({ status: "driving", recording: false }), ["차량 기록 멈춤", false]);
  assert.deepEqual(recordingLine({ status: "driving", recording: false }, ["하은"]), ["기록 동의를 기다리는 중", false]);
  assert.equal(recordingLine({ status: "parked" })[1], false);
  assert.deepEqual(statusMoves({ status: "boarding" }), [["출발", "driving"]]);
  assert.deepEqual(statusMoves({ status: "driving" }), [["주차", "parked"]]);
  assert.deepEqual(statusMoves({ status: "ended" }), []);
});

test("마지막 할 일 읽기가 실패하면 받아 둔 목록으로 완료·남은 수를 단정하지 않는다(P21)", () => {
  const continuing = { kind: "continue", place: "하나로마트", target: "강릉 숙소" };
  // 마트에서 빈 목록을 받은 뒤, 다시 달리는 중 다음 읽기가 503: 목록은 남아 있지만 error가 붙는다(todos.js)
  const stale = askState({ ready: true, items: [], error: "할 일을 불러오지 못했어요.", at: at(10, 20) });
  assert.equal(stale.kind, "stale");
  assert.equal(rideHeading(continuing, { asks: stale }).sub, "하나로마트에서 다시 출발 / 강릉 숙소로 이동", "실패 중에는 '부탁은 완료'라고 말하지 않는다");
  assert.equal(rideHeading(continuing, { asks: askState({ ready: true, items: [todo("물", "마트", "mom", 1)], error: "연결이 끊겼어요." }) }).sub, "하나로마트에서 다시 출발 / 강릉 숙소로 이동", "남은 수도 말하지 않는다");
  assert.deepEqual(askState({ ready: false, items: [], error: "연결이 끊겼어요." }), { kind: "failed", items: [] });
  assert.deepEqual(askState({ ready: false, items: [], error: "" }), { kind: "loading", items: [] });
  assert.equal(rideHeading(continuing, { asks: askState({ ready: false, items: [], error: "" }) }).sub, "하나로마트에서 다시 출발 / 강릉 숙소로 이동", "불러오는 중에도 단정하지 않는다");
  assert.equal(askState({ ready: true, items: [], error: "" }).kind, "fresh", "다시 읽기에 성공하면 그때 완료를 말한다");
});

// 카드가 실제로 그리는 글. h()가 쓰는 만큼만 흉내 낸 DOM(todos.test.mjs와 같은 방식).
const fakeDom = () => {
  const el = (tag) => ({ tag, kids: [], append(...k) { this.kids.push(...k); }, setAttribute() {} });
  globalThis.document = { createElement: el };
  const walk = (n, out = []) => { if (n == null || n === false) return out; if (Array.isArray(n)) n.forEach((k) => walk(k, out)); else if (typeof n !== "object") out.push(String(n)); else n.kids?.forEach((k) => walk(k, out)); return out; };
  return (node) => walk(node).join("\n");
};

test("곧 도착·도착 카드도 실패한 목록이면 수를 말하지 않고 받은 시각을 밝힌다", () => {
  const text = fakeDom();
  const items = [todo("고기", "마트", "mom", 30), todo("간식", "마트", "kid", 35)];
  const near = { kind: "near", place: "하나로마트" };
  assert.match(text(nearCard(near, askState({ ready: true, items, error: "" }))), /내리기 전에 기억할 2가지/);
  const stale = text(nearCard(near, askState({ ready: true, items, error: "연결이 끊겼어요.", at: at(10, 20) })));
  assert.doesNotMatch(stale, /2가지/);
  assert.match(stale, /10:20에 받은 부탁이에요/);
  assert.match(text(nearCard(near, askState({ ready: true, items: [], error: "연결이 끊겼어요." }))), /받은 목록에는 이곳 부탁이 없어요/, "실패 중 빈 목록을 '없어요'로 단정하지 않는다");
  assert.match(text(nearCard(near, askState({ ready: false, items: [], error: "" }))), /불러오고 있어요/, "불러오는 중을 '없어요'로 말하지 않는다");
  const avatar = () => "얼굴";
  const arrived = { kind: "arrived", place: "하나로마트" };
  assert.match(text(arrivalCards(arrived, askState({ ready: true, items, error: "" }), people, avatar)), /필요한 내용만 모았어요/);
  const failing = text(arrivalCards(arrived, askState({ ready: true, items, error: "연결이 끊겼어요.", at: at(10, 20) }), people, avatar));
  assert.match(failing, /엄마/); assert.match(failing, /10:20에 받은 부탁이에요/);
  assert.match(text(arrivalCards(arrived, askState({ ready: true, items: [], error: "연결이 끊겼어요." }), people, avatar)), /받은 목록에는 이곳 부탁이 없어요/);
  assert.match(text(arrivalCards(arrived, askState(null), people, avatar)), /동의하고 이 폰에서 연결한 사람만/);
  delete globalThis.document;
});

test("여럿이 같은 부탁을 말했으면 확인된 화자마다 그 사람 카드에 넣는다(P20)", () => {
  // 서버 deriveTodos는 엄마와 하은이 같은 문장을 말하면 원발화를 한 항목으로 합친다
  const milk = { id: "우유", place: "마트", text: "마트에서 우유 사자", status: "pending", version: 0, sources: [
    { device: "car", seq: 1, at: at(9, 40), participantId: "mom" },
    { device: "car", seq: 2, at: at(9, 41), participantId: "kid" },
    { device: "car", seq: 3, at: at(9, 42), participantId: "mom" },
    { device: "car", seq: 4, at: at(9, 43) },
  ] };
  const groups = arrivalAsks([milk, todo("간식", "마트", "kid", 50)], "하나로마트", people);
  assert.deepEqual(groups.map((g) => [g.name, g.items.map((t) => t.id), g.said.map((t) => new Date(t).getMinutes())]), [
    ["엄마", ["우유"], [40]],
    ["하은", ["우유", "간식"], [41, 50]],
  ], "엄마 카드와 하은 카드에 모두, 한 사람 안에서는 한 번만, 시각은 그 사람이 말한 때");
  assert.equal(groups.some((g) => g.person === null), false, "확인된 화자가 있으면 모르는 화자 묶음을 따로 만들지 않는다");
  assert.deepEqual(arrivalAsks([{ ...milk, sources: [{ device: "car", seq: 1, at: at(9, 40), participantId: "gone" }] }], "마트", people).map((g) => g.name), ["말한 사람 미확인"]);
});

test("장소 기록은 배열 순서가 아니라 at이 가장 큰 것을 지금 상태로 본다(#370)", () => {
  // 늦게 도착한 옛 'approaching'이 배열 맨 뒤에 붙은 경우
  const late = [
    { name: "우리 집", kind: "start", at: at(9, 20) },
    { name: "강릉 숙소", kind: "destination", at: at(9, 20) },
    { name: "하나로마트", kind: "approaching", at: at(10, 2), etaSeconds: 170 },
    { name: "하나로마트", kind: "arrived", at: at(10, 5) },
    { name: "하나로마트", kind: "approaching", at: at(10, 1), etaSeconds: 240 },
  ];
  assert.deepEqual(placesOf(late).map((p) => p.at), [at(9, 20), at(9, 20), at(10, 1), at(10, 2), at(10, 5)]);
  assert.equal(driveState({ status: "driving", recording: true }, { places: late }).kind, "continue", "P21: 뒤에 붙은 옛 approaching으로 곧 도착(P19)을 다시 띄우지 않는다");
  assert.equal(driveState({ status: "parked" }, { places: late }).place, "하나로마트", "P20: 가장 늦은 arrived");
  const nearLate = [{ name: "하나로마트", kind: "approaching", at: at(10, 2), etaSeconds: 170 }, { name: "우리 집", kind: "start", at: at(9, 20) }];
  assert.equal(driveState({ status: "driving", recording: true }, { places: nearLate }).kind, "near", "P19: 옛 출발 기록이 뒤에 붙어도 곧 도착");
  assert.equal(driveState({ status: "parked" }, { places: [{ name: "하나로마트", kind: "arrived", at: at(10, 5) }, { name: "하나로마트", kind: "approaching", at: at(10, 2) }] }).kind, "arrived");
  const line = (seq, h, m) => ({ device: "car", seq, at: at(h, m), shown: `말 ${seq}` });
  assert.deepEqual(transcriptSections([line(1, 9, 30), line(2, 10, 3), line(3, 10, 30)], { places: late }).map((s) => s.place), ["우리 집", "하나로마트 근처", "하나로마트"], "대화 머리도 시각 순으로");
  assert.equal(placeAt(placesOf(late), at(10, 3)), "하나로마트 근처");
});

test("주차 중 운전석 단추는 도착을 읽었는지와 관계없이 같은 순서이고, 둘 다 누르기 전에 묻는다", () => {
  const parked = statusMoves({ status: "parked" });
  assert.deepEqual(parked.map(([label, status]) => [label, status]), [["여행 계속", "driving"], ["여행 끝내기", "ended"]], "주 단추는 여행 계속, 카드에 여행 끝내기");
  assert.deepEqual(statusMoves({ status: "parked", places: [] }), parked, "여행 문서나 도착 여부로 바뀌지 않는다");
  assert.equal(parked[0][2], CONTINUE_ASK);
  assert.match(CONTINUE_ASK, /도착 안내가 사라지/);
  assert.match(CONTINUE_ASK, /주차 중이어도 대화 기록이 다시 켜/);
  assert.equal(parked[1][2], END_ASK);
  assert.match(END_ASK, /다시 열 수 없어요/);
  assert.equal(statusMoves({ status: "driving" })[0][2], undefined, "주차는 묻지 않는다(지금처럼)");
});

test("곧 도착 '확인'은 그 기록 하나에만, 확인 뒤에는 '다시 출발'이 아니라 운전 화면", () => {
  const trip = { status: "driving", recording: true };
  const mart = { name: "하나로마트", kind: "arrived", at: at(10, 5) };
  const first = { id: "a1", name: "하나로마트", kind: "approaching", at: at(10, 2) };
  const second = { id: "a2", name: "하나로마트", kind: "approaching", at: at(11, 30) };
  assert.equal(driveState(trip, { places: [first, mart, second], nearSeen: placeId(first) }).kind, "near", "같은 곳에 두 번째로 다가가면 다시 보인다");
  assert.equal(placeId({ name: "하나로마트", kind: "approaching", at: at(11, 30) }) === placeId({ name: "하나로마트", kind: "approaching", at: at(10, 2) }), false, "id가 없어도 시각으로 가린다");
  const lodge = { id: "a3", name: "강릉 숙소", kind: "approaching", at: at(11, 40) };
  assert.equal(driveState(trip, { places: [mart, lodge], nearSeen: placeId(lodge) }).kind, "drive", "도착 뒤 다음 곳의 곧 도착을 확인하면 다시 출발 문구가 남지 않는다");
  assert.equal(driveState(trip, { places: [lodge], seenArrival: { place: "하나로마트", at: at(10, 5) }, nearSeen: placeId(lodge) }).kind, "drive", "이 폰이 본 도착도 같은 규칙");
  assert.equal(driveState(trip, { places: [first], seenArrival: { place: "하나로마트", at: at(10, 5) } }).kind, "continue", "도착 전의 곧 도착 기록은 다시 출발을 막지 않는다");
});

test("장소는 동의한 참가자만 GET /places로 읽고, 403·404면 장소 없이, 동의가 꺼지면 바로 비운다", async () => {
  const tick = () => new Promise((ok) => setImmediate(ok));
  const trip = { code: "TRIP01", generation: 1, version: 1 };
  const me = { id: "me", consent: true };
  let token = "token", painted = 0;
  const calls = [];
  const request = (method, path) => new Promise((resolve, reject) => calls.push({ method, path, resolve, reject }));
  const places = createPlaces({ getTrip: () => trip, getParticipant: () => me, getToken: () => token, request, onChange: () => painted++, every: 60_000 });
  const list = [{ id: "p2", name: "하나로마트", kind: "approaching", at: at(10, 2) }, { id: "p1", name: "우리 집", kind: "start", at: at(9, 20) }];
  try {
    places.sync();
    assert.deepEqual(calls.map((c) => [c.method, c.path]), [["GET", "/places"]]);
    calls.shift().resolve({ items: list }); await tick();
    assert.deepEqual(places.items(), list); assert.equal(painted, 1);
    assert.equal(driveState({ status: "driving", recording: true }, { places: places.items() }).kind, "near", "at이 가장 큰 기록으로 고른다");
    places.sync(); assert.equal(calls.length, 0, "여행 판이 그대로면 다시 읽지 않는다");

    trip.version = 2; places.sync(); calls.shift().reject(Object.assign(new Error("끊김"), { status: 0 })); await tick();
    assert.deepEqual(places.items(), list, "잠깐 끊기면 마지막 목록을 둔다");
    trip.version = 3; places.sync(); calls.shift().reject(Object.assign(new Error("거절"), { status: 403 })); await tick();
    assert.deepEqual(places.items(), [], "403이면 장소 이름 없이");
    trip.version = 4; places.sync(); calls.shift().reject(Object.assign(new Error("없는 경로"), { status: 404 })); await tick();
    assert.deepEqual(places.items(), [], "경로가 아직 없는 서버도 장소 없이");

    trip.version = 5; places.sync(); const slow = calls.shift();
    me.consent = false; places.sync();
    assert.deepEqual(places.items(), [], "동의가 꺼지면 묻지 않고 바로 비운다");
    slow.resolve({ items: list }); await tick();
    assert.deepEqual(places.items(), [], "꺼지기 전에 떠난 읽기가 늦게 와도 되살리지 않는다");
    assert.equal(calls.length, 0, "동의하지 않으면 읽지 않는다");
    me.consent = true; token = null; places.sync();
    assert.equal(calls.length, 0, "이 폰의 참가자 토큰이 없어도 읽지 않는다");
  } finally { places.stop(); }
});
