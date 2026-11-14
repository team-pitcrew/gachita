// 도착 전·도착 브리핑(최종 시안: P19·P20, 최종 목적지 finalBrief. 11/15 최신 복제본 Figma eZ2xsOXkrszqdP489kduCs).
// 사람별이 아니라 분류별 행동 항목: '먼저 할 일', '잊지 말고 살 것 N개'(이모지·이름·'{누구} 요청'·수량),
// 최종 목적지는 '먼저 할 일 / 잊지 말기 / 챙길 것'. 분류·물건·수량·요청한 사람은 서버 할 일(GET /todos,
// place-rules-v2, T141)이 준 값이고 여기서 지어내지 않는다. 옛 서버(분류 없음)면 그 할 일 글을 '잊지 말기'로 보인다.
// 이모지는 이름 낱말로 고른다(디자인의 'Briefing / emoji' 여덟 개). 이름은 서버가 확인한 화자만 붙인다.
import { h } from "./shared.js";
import { ASK_NOTE, askLabel, asksAt, staleNote } from "./ride.js";

const EMOJI = [
  [/화장실/, "🚻"],
  [/냉장|얼음|냉동/, "🧊"], // '고기는 바로 냉장 보관'은 고기보다 냉장(디자인 finalBrief)
  [/고기|삼겹살|소고기|돼지|목살|한우|갈비|닭/, "🥩"],
  [/귤|과일|사과|딸기|포도|바나나|수박|복숭아/, "🍊"],
  [/젤리|간식|과자|사탕|초콜릿|아이스크림/, "🍬"],
  [/음료|탄산수|^물$|생수|커피|주스|우유|맥주|콜라|사이다/, "🥤"],
  [/가방|짐|캐리어|트렁크/, "🧳"],
  [/장보기|장 보/, "🛒"],
  [/쓰레기|분리배출|휴지통/, "🗑"],
];
// 이모지 → 시안 'Briefing / emoji' 그림 파일(brief-icons/, Twemoji CC-BY 4.0). 그림이 없는 이모지는 글자 그대로 쓴다.
const ICON = { "🚻": "1f6bb", "🛒": "1f6d2", "🥩": "1f969", "🍊": "1f34a", "🍬": "1f36c", "🥤": "1f964", "🧊": "1f9ca", "🧳": "1f9f3", "🗑": "trash" };
export const emojiIcon = (emoji, className = "brief-emoji") => ICON[emoji]
  ? h("img", { className, src: `/brief-icons/${ICON[emoji]}.svg`, alt: "", "aria-hidden": "true" })
  : h("span", { className, "aria-hidden": "true" }, emoji);
const BY_KIND = { buy: "🛒", first: "🚻", remember: "🧊", bring: "🧳" };
export const emojiOf = (name, category) => EMOJI.find(([re]) => re.test(String(name ?? "")))?.[1] ?? BY_KIND[category] ?? "🛒";

const KINDS = ["first", "buy", "remember", "bring"];
export const kindOf = (todo) => (KINDS.includes(todo?.category) ? todo.category : "remember");
const titleOf = (todo) => todo.title || askLabel(todo);

const hangul = (ch) => ch >= "가" && ch <= "힣";
const batchim = (word) => { const ch = String(word ?? "").trim().at(-1) ?? ""; return hangul(ch) && (ch.charCodeAt(0) - 0xac00) % 28 !== 0; };
// '하은이 요청', '엄마 요청'(받침이 있으면 '이'). 여럿이면 '엄마·서준이 요청'. 확인된 화자가 없으면 빈 글.
export function whoAsked(todo, participants = []) {
  const names = (Array.isArray(todo?.requestedBy) ? todo.requestedBy : []).map((id) => participants.find((p) => p.id === id)?.name).filter(Boolean);
  if (!names.length) return "";
  const last = names.at(-1);
  return `${[...names.slice(0, -1), batchim(last) ? `${last}이` : last].join("·")} 요청`;
}
const firstName = (todo, participants) => participants.find((p) => p.id === todo?.requestedBy?.[0])?.name ?? "";
// '고기와 과일', '삼겹살과 귤', 셋이면 '고기, 과일과 음료'
const and = (names) => names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")}${batchim(names.at(-2)) ? "과" : "와"} ${names.at(-1)}`;

// 그 장소의 미완료 할 일을 분류별로. 살 것은 물건 하나가 한 줄(수량과 요청한 사람).
export function briefGroups(items, place, participants = []) {
  const todos = asksAt(items, place);
  const groups = Object.fromEntries(KINDS.map((k) => [k, []]));
  for (const todo of todos) {
    const kind = kindOf(todo), who = whoAsked(todo, participants);
    const goods = kind === "buy" && Array.isArray(todo.items) && todo.items.length ? todo.items : null;
    if (goods) for (const g of goods) groups.buy.push({ emoji: emojiOf(g.name, "buy"), name: g.name, qty: g.qty ?? "", who, todo });
    else groups[kind].push({ emoji: emojiOf(`${titleOf(todo)} ${todo.items?.[0]?.name ?? ""}`, kind), name: titleOf(todo), qty: "", who, todo });
  }
  return { todos, ...groups };
}

// 곧 도착(P19) 카드의 한 줄 요약: '하은 화장실 / 고기와 과일 / 간식과 음료'.
export function nearLine(todo, participants = []) {
  const kind = kindOf(todo), names = (Array.isArray(todo.items) ? todo.items : []).map((g) => g.name).filter(Boolean);
  if (kind === "first") return [firstName(todo, participants), names[0] ?? titleOf(todo)].filter(Boolean).join(" ");
  if (kind === "buy" && names.length) return and(names);
  return titleOf(todo);
}

const row = (r) => h("li", { className: "brief-row" },
  emojiIcon(r.emoji),
  h("span", { className: "brief-copy" }, h("strong", {}, r.name), r.who && h("small", {}, r.who)),
  r.qty && h("span", { className: "brief-qty" }, r.qty),
);
const card = (label, rows, className = "") => rows.length > 0 && h("section", { className: `ride-card brief-card ${className}` },
  h("p", { className: "brief-label" }, label), h("ul", { className: "brief-rows" }, rows.map((r) => row(r))));

// 곧 도착(P19): '도착하면 할 일' 목록 — 먼저 할 일·잊지 말기·챙길 것은 할 일마다 한 줄, 살 것은 모아 '장보기' 한 줄
// (이모지 30 + 22/30 굵게, 시안 'Briefing / action item / Phone'). asks는 askState(). 못 믿는 목록이면 받은 시각을 밝힌다.
export function nearBrief(state, asks, participants = []) {
  const note = ASK_NOTE[asks.kind];
  const g = briefGroups(asks.items, state.place, participants);
  const rows = [...g.first, ...(g.buy.length ? [{ emoji: emojiOf("장보기", "buy"), name: "장보기" }] : []), ...g.remember, ...g.bring];
  return h("section", { className: "ride-card near-card", role: "status" },
    h("p", { className: "brief-label" }, note ? "내리기 전, 가족이 말한 부탁" : rows.length ? "도착하면 할 일" : asks.kind === "stale" ? "받은 목록에는 이곳 부탁이 없어요" : "이곳에서 챙길 부탁은 아직 없어요"),
    note ? h("p", {}, note) : rows.length > 0 && h("ul", { className: "near-rows" }, rows.map((r) => h("li", {}, emojiIcon(r.emoji), h("strong", {}, r.name)))),
    asks.kind === "stale" && h("p", { className: "meta" }, staleNote(asks)),
    h("p", { className: "near-foot" }, "정차하면 자세히 보여드릴게요"),
  );
}

// 도착(P20): 경유지는 '먼저 할 일' + '잊지 말고 살 것 N개'(+ 있으면 잊지 말기·챙길 것),
// 최종 목적지(state.final)는 '먼저 할 일 / 잊지 말기 / 챙길 것'(+ 있으면 살 것).
export function arrivalBrief(state, asks, participants = []) {
  const note = ASK_NOTE[asks.kind];
  const g = briefGroups(asks.items, state.place, participants);
  const footer = asks.kind === "stale" && h("p", { className: "ride-note" }, staleNote(asks));
  if (note || !g.todos.length)
    return [h("section", { className: "ride-card brief-card" }, h("p", { className: "brief-label" }, note ? "내리기 전, 가족이 말한 부탁" : asks.kind === "stale" ? "받은 목록에는 이곳 부탁이 없어요" : "여기서 챙길 부탁은 없어요"), note && h("p", { className: "ride-note" }, note)), footer];
  const buy = g.buy.length > 0 && h("section", { className: "ride-card brief-card" },
    h("div", { className: "brief-head" }, emojiIcon("🛒", "brief-emoji small"), h("strong", {}, "잊지 말고 살 것"), h("span", { className: "brief-count" }, `${g.buy.length}개`)),
    h("ul", { className: "brief-rows" }, g.buy.map((r) => row({ ...r, who: "" })))); // 시안 P20: 살 것 줄은 이름·수량만(요청한 사람은 빼고)
  const first = card("먼저 할 일", g.first, "brief-first");
  const remember = card("잊지 말기", g.remember), bring = card("챙길 것", g.bring);
  return [...(state.final ? [first, remember, bring, buy] : [first, buy, remember, bring]), footer];
}

// 도착 화면의 주 단추(운전석): 경유지는 '계속'(시안 P20), 최종 목적지는 '여행 마치고 기록 보기'.
export const arrivalMove = (state) => (state.final ? ["여행 마치고 기록 보기", "ended"] : ["계속", "driving"]);
