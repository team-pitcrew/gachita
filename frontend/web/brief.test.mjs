import assert from "node:assert/strict";
import { test } from "node:test";
import { arrivalBrief, arrivalMove, briefGroups, emojiOf, nearBrief, nearLine, whoAsked } from "./brief.js";
import { askState, driveState, rideHeading } from "./ride.js";

// 서버 GET /todos(place-rules-v2, T141)가 주는 모양 — 디자인(P20·finalBrief)의 문장
const people = [{ id: "dad", name: "아빠" }, { id: "mom", name: "엄마" }, { id: "seojun", name: "서준" }, { id: "haeun", name: "하은" }];
const todo = (place, category, title, items, requestedBy) => ({ id: title, place, text: title, status: "pending", version: 0, sources: [], category, title, items, requestedBy, method: "place-rules-v2" });
const mart = [
  todo("하나로마트", "first", "화장실 먼저 다녀오기", [{ name: "화장실", qty: null }], ["haeun"]),
  todo("마트", "buy", "삼겹살 600g이랑 귤 한 봉지 사 가기", [{ name: "삼겹살", qty: "600g" }, { name: "귤", qty: "1봉지" }], ["mom"]),
  todo("마트", "buy", "젤리 한 봉지 사기", [{ name: "젤리", qty: "1봉지" }], ["seojun"]),
  todo("마트", "buy", "탄산수 2병 사기", [{ name: "탄산수", qty: "2병" }], ["dad"]),
];
const lodge = [
  todo("숙소", "first", "화장실 먼저 다녀오기", [{ name: "화장실", qty: null }], ["haeun"]),
  todo("숙소", "remember", "고기는 바로 냉장 보관", [{ name: "고기 냉장 보관", qty: null }], ["mom"]),
  todo("숙소", "bring", "체크인하고 가방 내리기", [{ name: "체크인", qty: null }, { name: "가방", qty: null }], ["dad"]),
];
const fresh = (items) => askState({ ready: true, items, error: "" });
const fakeDom = () => {
  const el = (tag) => ({ tag, kids: [], append(...k) { this.kids.push(...k); }, setAttribute() {} });
  globalThis.document = { createElement: el };
  const walk = (n, out = []) => { if (n == null || n === false) return out; if (Array.isArray(n)) n.forEach((k) => walk(k, out)); else if (typeof n !== "object") out.push(String(n)); else n.kids?.forEach((k) => walk(k, out)); return out; };
  return (node) => walk(node).join("|");
};

test("이모지는 이름 낱말로, 없으면 분류 기본(디자인의 Briefing / emoji 여덟 개)", () => {
  assert.deepEqual(["삼겹살", "귤", "젤리", "탄산수", "물", "화장실 먼저 다녀오기", "고기는 바로 냉장 보관", "가방"].map((n) => emojiOf(n)), ["🥩", "🍊", "🍬", "🥤", "🥤", "🚻", "🧊", "🧳"]);
  assert.equal(emojiOf("물티슈", "buy"), "🛒", "물로 시작하는 다른 물건은 음료가 아니다");
  assert.deepEqual(["first", "buy", "remember", "bring"].map((k) => emojiOf("체크인", k)), ["🚻", "🛒", "🧊", "🧳"]);
});

test("'{누구} 요청'은 서버가 확인한 화자만, 받침이면 '이'를 붙인다", () => {
  assert.equal(whoAsked(mart[0], people), "하은이 요청");
  assert.equal(whoAsked(mart[1], people), "엄마 요청");
  assert.equal(whoAsked({ requestedBy: ["mom", "seojun"] }, people), "엄마·서준이 요청");
  assert.equal(whoAsked({ requestedBy: [] }, people), "", "화자를 모르면 이름을 지어내지 않는다");
  assert.equal(whoAsked({ requestedBy: ["gone"] }, people), "");
});

test("경유지 도착(P20): 먼저 할 일 하나, 잊지 말고 살 것은 물건마다 한 줄(4개)과 수량", () => {
  const g = briefGroups(mart, "하나로마트 강릉점", people);
  assert.deepEqual(g.first.map((r) => [r.emoji, r.name, r.who]), [["🚻", "화장실 먼저 다녀오기", "하은이 요청"]]);
  assert.deepEqual(g.buy.map((r) => [r.emoji, r.name, r.who, r.qty]), [["🥩", "삼겹살", "엄마 요청", "600g"], ["🍊", "귤", "엄마 요청", "1봉지"], ["🍬", "젤리", "서준이 요청", "1봉지"], ["🥤", "탄산수", "아빠 요청", "2병"]]);
  const text = fakeDom();
  const shown = text(arrivalBrief({ kind: "arrived", place: "하나로마트 강릉점" }, fresh(mart), people));
  assert.match(shown, /먼저 할 일\|🚻\|화장실 먼저 다녀오기\|하은이 요청/);
  assert.match(shown, /🛒\|잊지 말고 살 것\|4개\|🥩\|삼겹살\|엄마 요청\|600g/);
  assert.deepEqual(arrivalMove({ final: false }), ["장보고 여행 계속", "driving"]);
  delete globalThis.document;
});

test("최종 목적지(finalBrief): 먼저 할 일 / 잊지 말기 / 챙길 것 순서와 '여행 마치고 기록 보기'", () => {
  const text = fakeDom();
  const shown = text(arrivalBrief({ kind: "arrived", place: "강릉 숙소", final: true }, fresh(lodge), people));
  assert.ok(shown.indexOf("먼저 할 일") < shown.indexOf("잊지 말기") && shown.indexOf("잊지 말기") < shown.indexOf("챙길 것"), shown);
  assert.match(shown, /🧊\|고기는 바로 냉장 보관\|엄마 요청/);
  assert.match(shown, /🧳\|체크인하고 가방 내리기\|아빠 요청/);
  assert.deepEqual(arrivalMove({ final: true }), ["여행 마치고 기록 보기", "ended"]);
  delete globalThis.document;
});

test("최종 목적지인지는 차가 남긴 목적지 기록과 이름이 같을 때, 제목·부제는 시안대로", () => {
  const places = [{ name: "하나로마트", kind: "stop", at: 1 }, { name: "강릉 숙소", kind: "destination", at: 2 }];
  const atMart = driveState({ status: "parked" }, { places, arrival: { place: "하나로마트" } });
  const atLodge = driveState({ status: "parked" }, { places, arrival: { place: "강릉 숙소" } });
  assert.deepEqual([atMart.final, atLodge.final], [false, true]);
  assert.deepEqual(rideHeading(atMart), { title: "하나로마트 도착", sub: "먼저 할 일과 살 것을 모았어요" });
  assert.deepEqual(rideHeading(atLodge), { title: "강릉 숙소 도착", sub: "내리기 전, 이 세 가지만 기억하세요" });
});

test("곧 도착(P19): '내리기 전에 기억할 N가지'와 한 줄 요약, 못 읽으면 수를 말하지 않는다", () => {
  const items = [mart[0], todo("마트", "buy", "고기랑 과일도 사 가기", [{ name: "고기", qty: null }, { name: "과일", qty: null }], ["mom"]), todo("마트", "buy", "간식하고 음료 사자", [{ name: "간식", qty: null }, { name: "음료", qty: null }], ["seojun"])];
  assert.deepEqual(items.map((t) => nearLine(t, people)), ["하은 화장실", "고기와 과일", "간식과 음료"]);
  const text = fakeDom();
  const shown = text(nearBrief({ kind: "near", place: "하나로마트" }, fresh(items), people));
  assert.match(shown, /내리기 전에 기억할 3가지\|하은 화장실 \/ 고기와 과일 \/ 간식과 음료\|주차하면 가족별로 자세히 보여드릴게요/);
  assert.doesNotMatch(text(nearBrief({ kind: "near", place: "하나로마트" }, askState({ ready: true, items, error: "연결이 끊겼어요." }), people)), /3가지/);
  assert.match(text(nearBrief({ kind: "near", place: "하나로마트" }, askState(null), people)), /동의하고 이 폰에서 연결한 사람만/);
  delete globalThis.document;
});

test("옛 서버(분류 없음)의 할 일은 그 글을 '잊지 말기'로 보인다", () => {
  const old = { id: "x", place: "마트", text: "마트에서 우유 사자", status: "pending", version: 0, sources: [] };
  const g = briefGroups([old], "마트");
  assert.deepEqual(g.remember.map((r) => r.name), ["우유 사자"]);
});
