import assert from "node:assert/strict";
import { test } from "node:test";
import { arrivalAsks, askKeys, askLabel, dateRange, driveState, nextTarget, placeAt, recordingLine, rideHeading, ro, statusMoves, transcriptSections } from "./ride.js";

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
  assert.deepEqual(driveState({ status: "boarding", places: route }), { kind: "boarding", target: "하나로마트" });
  assert.equal(driveState({ status: "driving", recording: true, places: route }).kind, "drive", "P17");
  assert.equal(driveState({ status: "driving", recording: false, places: route }).kind, "paused", "P18");
  assert.equal(driveState({ status: "driving", recording: true }).target, "", "장소 기록이 없으면 갈 곳을 지어내지 않는다");
  assert.equal(driveState({ status: "ended", places: route }).kind, "ended");
  assert.equal(driveState({ status: "parked" }).kind, "parked", "도착 장소를 모르면 도착했다고 말하지 않는다");
});

test("곧 도착은 마지막 장소 기록이 approaching일 때만, 확인을 누르면 다시 주행 화면", () => {
  const trip = { status: "driving", recording: true, places: [...route, { name: "하나로마트", kind: "approaching", at: at(10, 2), etaSeconds: 170 }] };
  assert.deepEqual(driveState(trip), { kind: "near", place: "하나로마트", eta: 170, target: "하나로마트" });
  assert.equal(driveState(trip, { nearSeen: "하나로 마트" }).kind, "drive", "확인한 장소(공백 무시)는 다시 띄우지 않는다");
  assert.equal(driveState({ ...trip, recording: false }).kind, "near", "곧 도착은 기록을 멈춰도 먼저 보인다");
  assert.equal(driveState({ ...trip, places: [...trip.places, { name: "하나로마트", kind: "arrived", at: at(10, 5) }] }).kind, "continue", "도착 뒤에는 곧 도착이 아니다");
});

test("주차와 도착: 서버 arrival 또는 마지막 arrived 장소가 있을 때만 P20, 다시 달리면 P21", () => {
  assert.deepEqual(driveState({ status: "parked", places: route }, { arrival: { place: "하나로마트 강릉점" } }), { kind: "arrived", place: "하나로마트 강릉점", target: "하나로마트" });
  const arrived = [...route, { name: "하나로마트", kind: "arrived", at: at(10, 5) }];
  assert.equal(driveState({ status: "parked", places: arrived }).place, "하나로마트");
  assert.deepEqual(driveState({ status: "driving", recording: true, places: arrived }), { kind: "continue", place: "하나로마트", target: "강릉 숙소" });
  assert.equal(driveState({ status: "driving", recording: true }, { seenArrival: "이마트" }).place, "이마트", "장소 기록이 없어도 이 폰이 본 도착이면 다시 출발");
  assert.equal(driveState({ status: "driving", recording: false, places: arrived }).kind, "paused", "멈춤이 다시 출발보다 먼저");
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
  assert.equal(rideHeading({ kind: "near", place: "하나로마트", eta: 170 }).sub, "도착 약 3분 전 / 일행이 말한 부탁");
  assert.equal(rideHeading({ kind: "near", place: "하나로마트", eta: null }).sub, "일행이 말한 부탁");
  const items = [todo("고기", "마트", "mom", 30)];
  assert.equal(rideHeading({ kind: "continue", place: "하나로마트", target: "강릉 숙소" }, { todos: items }).sub, "하나로마트의 부탁 1건 남음 / 강릉 숙소로 이동");
  assert.equal(rideHeading({ kind: "continue", place: "하나로마트", target: "강릉 숙소" }, { todos: [] }).sub, "하나로마트의 부탁은 완료 / 강릉 숙소로 이동");
  assert.equal(rideHeading({ kind: "continue", place: "하나로마트", target: "" }, { todos: null }).sub, "하나로마트에서 다시 출발", "할 일을 볼 수 없으면 완료했다고 말하지 않는다");
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
  assert.deepEqual(statusMoves({ status: "boarding" }, { kind: "boarding" }), [["출발", "driving"]]);
  assert.deepEqual(statusMoves({ status: "driving" }, { kind: "drive" }), [["주차", "parked"]]);
  assert.deepEqual(statusMoves({ status: "parked" }, { kind: "arrived" }).map(([, s]) => s), ["driving", "ended"], "도착하면 여행 계속이 먼저");
  assert.deepEqual(statusMoves({ status: "parked" }, { kind: "parked" }).map(([, s]) => s), ["ended", "driving"]);
  assert.deepEqual(statusMoves({ status: "ended" }, { kind: "ended" }), []);
});
