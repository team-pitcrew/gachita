import { createHash } from "node:crypto";

// 명시적 규칙입니다. LLM 추출이나 장소 검색 결과가 아닙니다.
// v1(차량 Todos.kt와 같음): '마트에서 … 사자'처럼 장소 뒤 '에서'와 권유·의무형 끝.
// v2(T141, v2 도착 브리핑): '하나로마트 가면 …', '숙소 가서 …'도 장소로 읽고, 끝에 '요'와 '급해'를 받고,
// 분류(first·buy·remember·bring)·물건(이름·수량)·요청한 사람·제목을 더한다. v1이 뽑던 문장의 장소·글은 그대로라 id가 같다.
// v3(T167, D# 실흐름): 장소 없이 의무형으로 끝나는 말도, 같은 여행의 바로 앞 30초 안(그 말 포함)에 여행 장소(내비 목적지·경유지)가
// 나왔으면 그 장소의 할 일로 본다 — '정자동 카페거리 가까워요?' 뒤의 '…주차할 공간도 생각하셔야 돼요'. v2가 뽑던 문장은 그대로(id·method 같음).
const AT = /([가-힣A-Za-z0-9]{1,10})에서(?:는|도)?\s*/g;
const GO = /(?:^|\s)([가-힣A-Za-z0-9]{1,10}?)(?:에)?\s+(?:가면|가서|도착하면)\s+/g;
const END = /(자|야지|야 ?[돼되해]요?|급해요?)$/;
const NOT_VERB = new Set(["피자", "과자", "의자", "모자", "상자", "여자", "남자", "부자"]);
export const TODO_METHOD = "place-rules-v3";
export const TODO_METHOD_V2 = "place-rules-v2"; // v2 규칙으로 뽑은 항목의 method(차와 함께 쓰는 todo-vectors.json)
const CONTEXT_MS = 30_000;

// 장소와 그 뒤의 글(rest). v1의 '에서'가 있으면 그것만 본다 — v1이 뽑던 문장은 장소가 바뀌지 않게.
function placeOf(text) {
  const at = [...text.matchAll(AT)].at(-1) ?? [...text.matchAll(GO)].at(-1);
  return at ? { place: at[1], rest: text.slice(at.index + at[0].length) } : null;
}

export function todoOf(value) {
  const text = value.trim().replace(/[.!? ]+$/, "");
  const found = placeOf(text);
  if (!found || !END.test(text) || NOT_VERB.has(text.split(" ").at(-1))) return null;
  return { place: found.place, text };
}

// ---- 문맥 할 일(v3) ----
// 발화 속 장소 언급. 띄어쓰기·문장부호를 빼고, 낱말 끝 행정동 '동'(세 글자 이상)을 뗀 뒤 비교한다:
// 이름 전체가 들어 있거나('정자동 카페거리' ↔ '정자 카페거리'), 이름의 세 글자 이상 낱말이 들어 있으면('카페거리') 같은 장소다.
const spokenWords = (s) => String(s).split(/\s+/).map((w) => w.replace(/[^가-힣A-Za-z0-9]/g, "")).filter(Boolean).map((w) => (w.length >= 3 && w.endsWith("동") ? w.slice(0, -1) : w));
export function mentions(text, name) {
  const said = spokenWords(text).join(""), words = spokenWords(name);
  const whole = words.join("");
  return (whole.length >= 2 && said.includes(whole)) || words.some((w) => w.length >= 3 && said.includes(w));
}
// 장소 없이 의무형으로 끝나는 말 → 앞 30초 안에 가장 최근에 나온 여행 장소의 할 일. 장소는 띄어쓰기를 뺀 이름(차는 내비 이름에 포함되는지로 맞춘다).
function contextTodo(line, text, recent, names) {
  if (!names.length || !Number.isFinite(line.at) || placeOf(text) || !END.test(text) || NOT_VERB.has(text.split(" ").at(-1))) return null;
  const said = recent.filter((l) => l.at <= line.at && line.at - l.at <= CONTEXT_MS).sort((a, b) => b.at - a.at);
  for (const l of said) {
    const name = names.find((n) => mentions(l.displayText, n));
    if (name) return { place: name.replace(/\s/g, ""), text, context: true };
  }
  return null;
}
// 문맥 할 일의 제목·물건: 대화체라 마지막 구절만(쉼표·'근데'·'…할 게' 뒤), 앞말('제가' 등)을 떼고 높임 '하셔'를 '하기'로.
const LEAD = new Set(["제가", "저는", "저도", "내가", "나는", "나도", "우리", "우리가", "저희", "저희가", "그럼", "그러면", "근데", "그런데", "아", "어", "음", "뭐"]);
function clauseWords(text) {
  const words = text.split(/,|\s(?:근데|그런데|그리고|그럼)\s|\s게\s/).at(-1).replace(END, "").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEAD.has(words[0])) words.shift();
  return words;
}
function contextAction(text) {
  const words = clauseWords(text);
  const last = words.at(-1) ?? "";
  const verb = /하(?:셔|세요|시)$/.test(last) ? last.replace(/하(?:셔|세요|시)$/, "하기") : STEM[last] ?? (last.length >= 3 && last.endsWith("해") ? last.slice(0, -1) : last);
  const name = clean(words.slice(0, -1));
  return { title: [...words.slice(0, -1).map(bare), verb].filter(Boolean).join(" "), items: name ? [{ name, qty: null }] : [] };
}

// ---- 행동 항목(v2) ----
// 분류: 먼저 할 일(화장실·먼저·급해) → 살 것(사다) → 챙길 것(챙기다·가져가다·내리다·꺼내다) → 잊지 말 것(나머지).
const FIRST = /화장실|먼저|급해/;
const BUY = /(?:^|\s)사(?:\s?(?:가|오|와|다|두|둬|놓))?\s?(?:자|야지|야 ?[돼되해]요?)$/;
const BRING = /(?:^|\s)(?:챙기|챙겨|가져가|가져와|가지고\s?가|가지고\s?와|내리|내려|꺼내)/g;
const FILLER = new Set(["먼저", "바로", "꼭", "좀", "빨리", "일단", "같이", "우리", "다", "또", "잊지", "말고", "까먹지", "제발"]);
const NATIVE = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };
const UNIT = { kg: "kg", 킬로그램: "kg", 킬로: "kg", g: "g", 그램: "g", 개: "개", 병: "병", 봉지: "봉지", 팩: "팩", 캔: "캔", 마리: "마리" };
const QTY = new RegExp(`(?:^|\\s)(\\d+(?:\\.\\d+)?|${Object.keys(NATIVE).join("|")})\\s?(${Object.keys(UNIT).join("|")})(?=$|\\s|[은는을를도씩])`);

const hangul = (ch) => ch >= "가" && ch <= "힣";
const batchim = (ch) => hangul(ch) && (ch.charCodeAt(0) - 0xac00) % 28 !== 0;
// 낱말 끝의 이음 조사(랑·이랑·하고·와·과)를 떼어 낸 낱말, 이음 조사가 아니면 null.
// 받침으로 가린다: '사과'(사+과는 받침 없는 뒤라 조사가 아님), '노랑'·'사랑'(한 글자 + 랑)은 그대로.
function joined(word) {
  const base = (n) => word.slice(0, -n), prev = (n) => word.at(-n - 1);
  if (word.endsWith("하고") && word.length > 2) return base(2);
  if (word.endsWith("이랑") && word.length > 2 && (batchim(prev(2)) || !hangul(prev(2)))) return base(2);
  if (word.endsWith("랑") && word.length >= 3 && !batchim(prev(1))) return base(1);
  if (word.endsWith("와") && word.length >= 3 && hangul(prev(1)) && !batchim(prev(1))) return base(1);
  if (word.endsWith("과") && word.length >= 2 && (batchim(prev(1)) || !hangul(prev(1)))) return base(1);
  return null;
}
// 낱말 끝 조사를 뗀다. 짧은 낱말은 그대로('포도'의 도, '물'). 
const bare = (word) =>
  word.length >= 3 && /(부터|까지)$/.test(word) ? word.slice(0, -2)
  : word.length >= 2 && /[은는을를]$/.test(word) ? word.slice(0, -1)
  : word.length >= 3 && word.endsWith("도") ? word.slice(0, -1)
  : word;
const clean = (words) => words.filter((w) => !FILLER.has(w)).map(bare).filter(Boolean).join(" ");

// 물건 하나: 수량(있으면 '600g'·'1봉지'·'2병')을 떼고 남은 것이 이름.
function goodOf(phrase) {
  const m = QTY.exec(phrase);
  const qty = m ? `${NATIVE[m[1]] ?? Number(m[1])}${UNIT[m[2]]}` : null;
  const name = clean((m ? phrase.slice(0, m.index) + " " + phrase.slice(m.index + m[0].length) : phrase).split(/\s+/).filter(Boolean));
  return name ? { name, qty } : null;
}
// 한 부탁 안의 여러 물건: 쉼표·'그리고'와 낱말 끝 이음 조사로 나눈다.
function goodsOf(phrase) {
  const parts = [];
  for (const piece of phrase.split(/,|\s그리고\s/)) {
    let cur = [];
    const words = piece.trim().split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      const cut = i < words.length - 1 ? joined(w) : null;
      cur.push(cut ?? w);
      if (cut !== null) (parts.push(cur.join(" ")), (cur = []));
    });
    if (cur.length) parts.push(cur.join(" "));
  }
  return parts.map(goodOf).filter(Boolean);
}
// 끝(자·야지·야 돼…)을 떼고 마지막 동사를 '…하기'꼴로: '화장실 먼저 가야 돼' → '화장실 먼저 다녀오기', '냉장 보관해야 돼' → '냉장 보관'.
const STEM = { 가: "가기", 와: "오기", 사: "사기", 해: "하기", 봐: "보기", 챙겨: "챙기기", 챙기: "챙기기", 내려: "내리기", 내리: "내리기", 꺼내: "꺼내기", 가져가: "가져가기", 가져와: "가져오기" };
const wordsOf = (rest) => rest.replace(END, "").trim().split(/\s+/).filter(Boolean);
function titleOf(rest) {
  const words = wordsOf(rest);
  const last = words.at(-1);
  if (last === undefined) return "";
  if (last === "가" && words.includes("화장실")) words[words.length - 1] = "다녀오기"; // 디자인의 '화장실 먼저 다녀오기'
  else if (STEM[last]) words[words.length - 1] = STEM[last];
  else if (last.length >= 3 && last.endsWith("해")) words[words.length - 1] = last.slice(0, -1); // '보관해' → '보관'
  else if (last.length === 1) words[words.length - 1] = `${last}기`; // 한 글자 동사 줄기: '쉬' → '쉬기'
  return words.join(" ");
}
// 물건이 따로 없는 할 일(먼저·잊지 말 것)은 동사를 뺀 말 하나를 항목으로: '화장실 먼저 가야 돼' → '화장실'.
function subjectOf(rest) {
  const words = wordsOf(rest);
  const last = words.at(-1);
  if (last !== undefined && (STEM[last] || last.length === 1)) words.pop();
  else if (last?.length >= 3 && last.endsWith("해")) words[words.length - 1] = last.slice(0, -1);
  const name = clean(words);
  return name ? [{ name, qty: null }] : [];
}

// 할 일 하나의 행동 항목. sources의 확인된 화자를 요청한 사람으로(중복 없이, 처음 말한 순서).
export function actionOf(todo) {
  const requested = [...new Set((todo.sources ?? []).map((s) => s.participantId).filter(Boolean))];
  if (todo.context) return { category: FIRST.test(todo.text) ? "first" : "remember", ...contextAction(todo.text), requestedBy: requested, method: TODO_METHOD };
  const rest = placeOf(todo.text)?.rest ?? todo.text;
  const buy = BUY.exec(rest);
  const bring = [...rest.matchAll(BRING)].at(-1);
  const category = FIRST.test(todo.text) ? "first" : buy ? "buy" : bring && bring.index > 0 ? "bring" : "remember";
  const object = buy ? rest.slice(0, buy.index) : bring && bring.index > 0 ? rest.slice(0, bring.index) : null;
  const items = object !== null ? goodsOf(object) : subjectOf(rest);
  const requestedBy = [...new Set(todo.sources.map((s) => s.participantId).filter(Boolean))];
  return { category, title: titleOf(rest), items, requestedBy, method: TODO_METHOD_V2 };
}

// 현재 살아 있는 발화만 입력받습니다. 교정본을 우선하되 원문·출처를 함께 돌려줍니다.
// places는 그 여행의 장소 이름(내비 목적지·경유지, v3 문맥 규칙). 없으면 v2와 같다.
export function deriveTodos(lines, states = [], places = []) {
  const found = new Map(), saved = new Map(states.map((s) => [s.id, s]));
  const names = [...new Set(places.filter((n) => typeof n === "string" && n.trim()))];
  const said = lines.map((line) => ({ ...line, displayText: line.displayText ?? line.editedText ?? line.asrText ?? line.text }))
    .filter((l) => l.text && typeof l.displayText === "string");
  for (const line of said) {
    const { displayText } = line;
    const todo = todoOf(displayText) ?? contextTodo(line, displayText.trim().replace(/[.!? ]+$/, ""), said, names);
    if (!todo) continue;
    const id = createHash("sha256").update(JSON.stringify([todo.place, todo.text])).digest("hex").slice(0, 32);
    if (!found.has(id)) {
      const state = saved.get(id);
      found.set(id, { id, ...todo, status: state?.status ?? "pending", version: Number(state?.version ?? 0), sources: [] });
    }
    found.get(id).sources.push({ device: line.device, seq: line.seq, at: line.at, text: line.text, displayText,
      ...(line.participantId ? { participantId: line.participantId } : {}) });
  }
  return [...found.values()].map((t) => ({ ...t, ...actionOf(t) }));
}

export const placeMatches = (place, name) => name.replace(/\s/g, "").includes(place);

function meters(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

// 호출자가 보낸 관측 근거에 대한 판정입니다. 서버가 차량 기어·내비를 직접 관측한 뜻은 아닙니다.
export function arrivalBriefing(input, items, now = Date.now()) {
  const distance = meters(input.position, input.place), distanceMeters = Math.round(distance);
  const reason = !input.parked ? "not_parked" : now - input.observedAt > 60_000 ? "stale_position" : distance > 250 ? "outside_place" : null;
  return { eligible: reason === null, reason, source: input.source, observedAt: input.observedAt,
    place: input.place, distanceMeters, method: TODO_METHOD,
    items: reason === null ? items.filter((t) => t.status === "pending" && placeMatches(t.place, input.place.name)) : [] };
}
