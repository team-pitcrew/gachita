// '함께 타는 중' 탭(최종 시안 P17–P21)과 세 탭 틀. 무엇을 보일지는 서버가 준 값으로만 고르고 지어내지 않는다.
// - 여행 상태·기록 여부: GET /trips/{code}의 status·recording
// - 장소: GET /trips/{code}/places와 전사 응답의 places(차가 내비에서 읽어 기록, #370). 녹음에 동의한 참가자만 읽는다.
//   여행 문서(trip.places)는 읽지 않는다. 못 읽으면 '곧 도착'과 장소 이름을 보이지 않는다.
// - 도착과 부탁: 기록에 동의한 참가자가 읽는 GET /todos의 arrival·items(T119·T120)
import { h, SEATS } from "./shared.js";
import { placeMatches } from "./todos.js";

export const hhmm = (at) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const monthDay = (at) => new Date(at).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
const key = (name) => String(name ?? "").replace(/\s/g, "");

// 받침이 있으면(ㄹ 받침 제외) '으로', 없으면 '로'. 한글이 아니면 '로'.
export function ro(word) {
  const code = String(word ?? "").trim().codePointAt(String(word ?? "").trim().length - 1) - 0xac00;
  if (!(code >= 0 && code < 11172)) return `${word}로`;
  const tail = code % 28;
  return `${word}${tail === 0 || tail === 8 ? "로" : "으로"}`;
}

// 서버의 장소 기록을 시각(at) 순으로. 늦게 도착한 옛 기록이 배열 뒤에 붙을 수 있어 배열 순서를 믿지 않는다(#370 계약:
// 지금 상태는 at이 가장 큰 기록). 같은 시각이면 배열 순서를 지키고, 시각이 없는 기록은 가장 오래된 것으로 둔다. 이름 없는 것은 뺀다.
const atOf = (p) => (Number.isFinite(p.at) ? p.at : -Infinity);
export const placesOf = (items) => (Array.isArray(items) ? items : []).filter((p) => p && typeof p.name === "string" && p.name.trim()).sort((a, b) => atOf(a) - atOf(b));

// 다음에 갈 곳: 아직 도착하지 않은 첫 경유지, 없으면 마지막 목적지(도착했으면 없음).
export function nextTarget(places) {
  const arrived = new Set(places.filter((p) => p.kind === "arrived").map((p) => key(p.name)));
  const open = (p) => !arrived.has(key(p.name));
  return places.find((p) => p.kind === "stop" && open(p))?.name ?? [...places].reverse().find((p) => p.kind === "destination" && open(p))?.name ?? "";
}

// 장소 기록 읽기(GET /trips/{code}/places, #370). 녹음에 동의하고 이 폰에서 연결한 참가자만 읽는다(아니면 서버가 403).
// 할 일(todos.js)과 같은 주기: 여행 판이 바뀔 때와 화면이 보이는 동안 6초마다. 동의가 꺼지거나 참가자·세대가 바뀌면 바로 비운다.
// 403·401·404(그 경로가 아직 없는 서버 포함)는 빈 목록 — 장소 이름 없이 그린다. 잠깐 끊기면 마지막 목록을 둔다.
export function createPlaces({ getTrip, getParticipant, getToken, request, onChange, every = 6000 }) {
  let state = null; // { key, items, json, seen(여행 판) }
  let loading = false, again = false;
  const keyOf = () => {
    const trip = getTrip(), me = getParticipant();
    return trip && me?.consent && getToken() ? `${trip.code}:${trip.generation ?? 1}:${me.id}` : "";
  };
  const set = (s, items) => {
    const json = JSON.stringify(items);
    if (json !== s.json) { Object.assign(s, { items, json }); onChange(); }
  };
  async function load() {
    const s = state;
    if (!s) return;
    if (loading) { again = true; return; }
    loading = true;
    try {
      const data = await request("GET", "/places");
      if (state === s) set(s, Array.isArray(data?.items) ? data.items : []);
    } catch (e) {
      if (state === s && [401, 403, 404].includes(e.status)) set(s, []);
    } finally {
      loading = false;
      if (again) { again = false; load(); }
    }
  }
  function sync() {
    const k = keyOf(), trip = getTrip();
    if (state?.key !== k) state = k ? { key: k, items: [], json: "[]", seen: "" } : null;
    if (!state) return;
    const version = `${trip.code}:${trip.version}`;
    if (version !== state.seen) { state.seen = version; load(); }
  }
  const timer = setInterval(() => { if (state && !globalThis.document?.hidden) load(); }, every);
  timer.unref?.();
  return { sync, items: () => (keyOf() && state?.key === keyOf() ? state.items : []), stop: () => clearInterval(timer) };
}

// 곧 도착 기록 하나를 가리키는 값. 같은 곳에 두 번째로 다가가면(다른 기록) '확인'한 것과 다르다.
export const placeId = (p) => (p ? `${p.id ?? ""}|${Number.isFinite(p.at) ? p.at : ""}|${key(p.name)}` : "");

// 지금 보일 상태. places는 GET /places의 목록(못 읽으면 null·[]), arrival은 GET /todos의 도착(동의한 참가자만),
// seenArrival은 이 폰이 이번 세대에서 본 도착 { place, at }(장소 기록의 도착처럼 다룬다), nearSeen은 '확인'을 누른 곧 도착 기록(placeId).
// kind: boarding | drive | paused | near | arrived | continue | parked | ended
export function driveState(trip, { places: items = [], arrival = null, seenArrival = null, nearSeen = "" } = {}) {
  const seen = seenArrival?.place ? [{ kind: "arrived", name: seenArrival.place, at: seenArrival.at }] : [];
  const places = placesOf([...(Array.isArray(items) ? items : []), ...seen]);
  const last = places.at(-1);
  const target = nextTarget(places);
  const status = trip?.status;
  if (status === "boarding" || status === "ended") return { kind: status, target };
  if (status === "parked") {
    const place = arrival?.place || (last?.kind === "arrived" ? last.name : "");
    // 최종 목적지(finalBrief)인지: 차가 남긴 목적지 기록과 이름이 같을 때(v2 도착 브리핑, T141)
    const final = Boolean(place) && places.some((p) => p.kind === "destination" && key(p.name) === key(place));
    return place ? { kind: "arrived", place, target, final } : { kind: "parked", target };
  }
  if (last?.kind === "approaching" && placeId(last) !== nearSeen) return { kind: "near", place: last.name, eta: Number.isFinite(last.etaSeconds) ? last.etaSeconds : null, target: last.name, id: placeId(last) };
  if (!trip?.recording) return { kind: "paused", target };
  // 다시 출발(P21)은 마지막 도착 뒤에 새 곧 도착이 없을 때만. 다음 곳에 다가가기 시작했으면('확인' 뒤 포함) 운전 화면.
  const lastArrived = places.findLastIndex((p) => p.kind === "arrived");
  const approachedSince = places.findLastIndex((p) => p.kind === "approaching") > lastArrived;
  return lastArrived >= 0 && !approachedSince ? { kind: "continue", place: places[lastArrived].name, target } : { kind: "drive", target };
}

// 부탁 목록을 어디까지 믿을지(todos.snapshot()의 값). 마지막 읽기가 실패했으면 받은 목록을 보이되 'stale'이라
// 완료·남은 수를 단정하지 않는다. kind: denied(동의 전·권한 없음) | loading | failed(받은 적 없음) | stale | fresh
export function askState(list) {
  if (!list) return { kind: "denied", items: [] };
  if (!list.ready) return { kind: list.error ? "failed" : "loading", items: [] };
  return { kind: list.error ? "stale" : "fresh", items: Array.isArray(list.items) ? list.items : [], at: list.at ?? null };
}
export const ASK_NOTE = {
  denied: "기록에 동의하고 이 폰에서 연결한 사람만 부탁을 볼 수 있어요.",
  loading: "부탁을 불러오고 있어요.",
  failed: "연결이 끊겨 부탁을 불러오지 못했어요. 다시 이어지면 보여 드려요.",
};
export const staleNote = (asks) => `연결이 끊겨 ${asks.at ? `${hhmm(asks.at)}에 ` : ""}받은 부탁이에요. 그 뒤에 바뀐 것은 아직 보이지 않아요.`;

// 그 장소에서 챙길 미완료 할 일(서버와 같은 이름 포함 규칙).
export const asksAt = (items, place) => (place && Array.isArray(items) ? items.filter((t) => t.status === "pending" && placeMatches(t.place, place)) : []);

// 카드에 보일 부탁 글: 장소 카드 안이라 앞의 '○○에서'는 뺀다(서버 규칙이 뽑은 장소일 때만).
export function askLabel(todo) {
  const text = String(todo?.text ?? "").trim();
  for (const lead of ["는 ", "도 ", " "].map((tail) => `${todo?.place}에서${tail}`)) if (todo?.place && text.startsWith(lead) && text.length > lead.length) return text.slice(lead.length).trim();
  return text;
}

// 도착한 곳의 부탁을 말한 사람별로 묶는다. 이름은 서버가 확인한 화자(participantId)만 붙이고, 모르면 한 묶음으로 둔다.
// 같은 부탁을 여럿이 말했으면(서버가 원발화를 한 항목으로 합침) 확인된 화자마다 그 사람 카드에 넣는다(중복 없이).
// 확인된 화자가 하나도 없을 때만 '말한 사람 미확인'에 넣는다. said는 그 사람이 그 부탁을 처음 말한 시각(items와 같은 순서).
// 묶음 순서는 그 사람이 처음 말한 시각, 모르는 화자는 맨 뒤.
export function arrivalAsks(items, place, participants = []) {
  const groups = new Map();
  const add = (person, todo, sources) => {
    const id = person?.id ?? "";
    if (!groups.has(id)) groups.set(id, { person, name: person?.name ?? "말한 사람 미확인", items: [], said: [], first: Infinity });
    const group = groups.get(id), at = Math.min(...sources.map((s) => s.at).filter(Number.isFinite));
    group.items.push(todo);
    group.said.push(Number.isFinite(at) ? at : null);
    group.first = Math.min(group.first, at);
  };
  for (const todo of asksAt(items, place)) {
    const sources = Array.isArray(todo.sources) ? todo.sources : [];
    const speakers = participants.filter((p) => sources.some((s) => s.participantId === p.id));
    if (!speakers.length) add(null, todo, sources);
    for (const person of speakers) add(person, todo, sources.filter((s) => s.participantId === person.id));
  }
  return [...groups.values()].sort((a, b) => !a.person - !b.person || a.first - b.first);
}

// 제목과 부제. asks는 askState(). 마지막 읽기가 성공한 목록(fresh)일 때만 부탁을 완료했다거나 몇 건 남았다고 말하고,
// 동의 전·불러오는 중·읽기 실패(받은 목록이 있어도)에는 중립 문구를 쓴다.
export function rideHeading(state, { title, waiting = [], asks = null } = {}) {
  const todos = asks?.kind === "fresh" ? asks.items : null;
  const trip = title || "함께 탄 여행";
  const going = state.target ? `${ro(state.target)} 이동 중` : "";
  switch (state.kind) {
    case "drive": return { title: "지금은 운전에 집중하세요", sub: [trip, going].filter(Boolean).join(" / ") };
    case "paused": return { title: "기록을 잠시 멈췄어요", sub: waiting.length ? `${waiting.join(", ")} 님의 기록 동의를 기다리고 있어요.` : "대화가 더 이상 기록되지 않아요." };
    case "near": return { title: `곧 ${state.place}에 도착해요`, sub: [state.eta != null && `도착 약 ${Math.max(1, Math.round(state.eta / 60))}분 전`, "가족이 말한 부탁"].filter(Boolean).join(" / ") };
    // v2 도착 브리핑(P20·finalBrief, T141): 경유지는 먼저 할 일과 살 것, 최종 목적지는 세 가지
    case "arrived": return { title: `${state.place} 도착`, sub: state.final ? "내리기 전, 이 세 가지만 기억하세요" : "먼저 할 일과 살 것을 모았어요" };
    case "continue": {
      const left = todos && asksAt(todos, state.place).length;
      const done = todos == null ? `${state.place}에서 다시 출발` : left ? `${state.place}의 부탁 ${left}건 남음` : `${state.place}의 부탁은 완료`;
      return { title: "다시, 우리 가족의 여행", sub: [done, state.target && `${ro(state.target)} 이동`].filter(Boolean).join(" / ") };
    }
    case "parked": return { title: "주차했어요", sub: "이번 주행의 기록을 마감했어요." };
    case "ended": return { title: "여행을 마쳤어요", sub: "함께한 대화와 남긴 장면을 다시 볼 수 있어요." };
    default: return { title: trip, sub: "모두 타면 운전자가 출발을 눌러요." };
  }
}

// 아래 기록 상태 띠: [글, 켜짐 여부]. 실제 녹음은 차가 하므로 서버의 기록 설정을 그대로 말한다.
export function recordingLine(trip, waiting = []) {
  if (trip?.status === "driving") return trip.recording ? ["차량에서 대화 기록 중", true] : [waiting.length ? "기록 동의를 기다리는 중" : "차량 기록 멈춤", false];
  return [{ boarding: "출발 전이라 기록하지 않아요", parked: "주차해서 기록을 마감했어요", ended: "여행을 마쳐 기록하지 않아요" }[trip?.status] ?? "차량 기록 멈춤", false];
}

// 운전석에서 바꿀 수 있는 여행 상태: [글자, 다음 상태, 누르기 전에 물을 말(없으면 바로)]. 첫째가 주 단추 자리다.
// 주차 중에는 도착을 읽었는지와 관계없이 같은 순서다(도착이 몇 초 늦게 와도 단추가 자리를 바꾸지 않게).
export const CONTINUE_ASK = "다시 출발할까요? 함께 탄 모두의 화면에서 지금 도착 안내가 사라지고, 모두 기록에 동의해 있으면 차가 아직 주차 중이어도 대화 기록이 다시 켜져요.";
export const END_ASK = "여행을 끝낼까요? 휴대폰에서는 다시 열 수 없어요.";
export function statusMoves(trip) {
  if (trip?.status === "boarding") return [["출발", "driving"]];
  if (trip?.status === "driving") return [["주차", "parked"]];
  if (trip?.status === "parked") return [["여행 계속", "driving", CONTINUE_ASK], ["여행 끝내기", "ended", END_ASK]];
  return [];
}

// 대화 기록 날짜 칩: '11월 14일 / 09:20–10:28'. 날을 넘기면 양쪽에 날짜를 붙인다.
export function dateRange(from, to) {
  if (!Number.isFinite(from)) return "";
  if (!Number.isFinite(to) || to < from) to = from;
  if (monthDay(from) !== monthDay(to) || to - from >= 86400_000) return `${monthDay(from)} ${hhmm(from)} – ${monthDay(to)} ${hhmm(to)}`;
  return `${monthDay(from)} / ${hhmm(from)}${to > from && hhmm(to) !== hhmm(from) ? `–${hhmm(to)}` : ""}`;
}

// 그 시각에 차가 있던 곳: 그 시각 이전의 마지막 출발·곧 도착·도착 기록. 경유지·목적지는 갈 곳이라 쓰지 않는다.
export function placeAt(places, at) {
  let found = ""; // places는 at 순(placesOf)이어야 한다
  for (const p of places) if (["start", "approaching", "arrived"].includes(p.kind) && Number.isFinite(p.at) && p.at <= at) found = p.kind === "approaching" ? `${p.name} 근처` : p.name;
  return found;
}

// 받아 적은 글을 'HH:MM / 장소' 머리로 묶는다. 같은 장소에서 gap 안에 이어진 말은 한 묶음이고,
// 할 일의 원발화(asks: 'device:seq')는 따로 '부탁' 카드가 된다. lines는 transcriptLines()의 시간순 결과.
export function transcriptSections(lines, { places = [], asks = new Set(), gap = 5 * 60_000 } = {}) {
  const log = placesOf(places).filter((p) => Number.isFinite(p.at));
  const out = [];
  for (const line of lines) {
    const place = placeAt(log, line.at);
    if (asks.has(`${line.device}:${line.seq}`)) { out.push({ kind: "ask", at: line.at, place, line }); continue; }
    const last = out.at(-1);
    if (last?.kind === "group" && last.place === place && line.at - last.lines.at(-1).at <= gap) last.lines.push(line);
    else out.push({ kind: "group", at: line.at, place, lines: [line] });
  }
  return out;
}

// 할 일의 원발화 표시('device:seq'). 전사 응답의 todos(서버 deriveTodos)에서 읽는다.
export const askKeys = (todos) => new Set((Array.isArray(todos) ? todos : []).flatMap((t) => (Array.isArray(t.sources) ? t.sources : []).map((s) => `${s.device}:${s.seq}`)));

// ---- 화면 조각 ----

const button = (text, onclick, className = "") => h("button", { type: "button", className, onclick }, text);

// 머리: 가치타(누르면 처음 화면)와 서버 연결 상태.
export const appBar = ({ online, onHome }) => h("div", { className: "top app-bar" },
  h("button", { type: "button", className: "brand brand-home", "aria-label": "가치타 처음 화면으로", onclick: onHome }, "가치타"),
  h("span", { className: `link-state${online ? "" : " is-offline"}` }, online ? "연결됨" : "연결 끊김"),
);

// 세 탭. 지금 탭은 단추가 아닌 표시로 둔다.
export const journeyTabs = (current, go) => h("nav", { className: "journey-tabs", "aria-label": "여행 메뉴" },
  [["ride", "함께 타는 중"], ["talk", "대화 기록"], ["contents", "콘텐츠 기록"]].map(([id, label]) => id === current
    ? h("button", { type: "button", className: "selected", "aria-current": "page", onclick: () => go[id]?.() }, label)
    : button(label, () => go[id]())),
);

// 좌석 지도: 위가 차 앞쪽. 뒤 가운데는 누가 앉았을 때만 칸을 만든다.
export function seatMap(trip, me, avatar) {
  const seated = Object.fromEntries(trip.participants.map((p) => [p.seat, p]));
  const seat = ([id, label]) => {
    const p = seated[id];
    return h("div", { className: `seat${p ? "" : " empty"}${p && p.id === me?.id ? " me" : ""}` },
      p ? avatar(p) : h("span", { className: "seat-blank", "aria-hidden": "true" }),
      h("strong", {}, p ? p.name : "빈자리"), h("small", {}, label));
  };
  const rear = SEATS.slice(2).filter(([id]) => id !== "ROW_2_CENTER" || seated[id]);
  return h("section", { className: "seat-map", "aria-label": `좌석 · 일행 ${trip.participants.length}명` },
    h("p", { className: "seat-front" }, "차량 앞쪽 ↑"),
    h("div", { className: "seat-row" }, SEATS.slice(0, 2).map(seat)),
    h("div", { className: `seat-row${rear.length > 2 ? " three" : ""}` }, rear.map(seat)),
  );
}

// 곧 도착(P19): 그 장소에서 챙길 부탁. asks는 askState(). 목록을 못 믿으면 수를 말하지 않는다.
export function nearCard(state, asks) {
  const list = asksAt(asks.items, state.place);
  const note = ASK_NOTE[asks.kind];
  return h("section", { className: "ride-card near-card", role: "status" },
    h("h2", {}, note ? "내리기 전에 기억할 부탁" : asks.kind === "stale" ? (list.length ? "내리기 전에 기억할 부탁" : "받은 목록에는 이곳 부탁이 없어요") : list.length ? `내리기 전에 기억할 ${list.length}가지` : "이곳에서 챙길 부탁은 아직 없어요"),
    note ? h("p", {}, note) : list.length > 0 && h("ul", { className: "near-asks" }, list.map((t) => h("li", {}, askLabel(t)))),
    asks.kind === "stale" && h("p", { className: "meta" }, staleNote(asks)),
    h("p", { className: "meta" }, "주차하면 가족별로 자세히 보여드릴게요."),
  );
}

// 도착(P20): 사람별 부탁 카드. asks는 askState(). 읽기가 실패한 목록이면 받은 시각을 밝힌다.
export function arrivalCards(state, asks, participants, avatar) {
  const groups = arrivalAsks(asks.items, state.place, participants);
  const note = ASK_NOTE[asks.kind];
  const footer = h("p", { className: "ride-note" }, asks.kind === "stale" ? staleNote(asks) : "방금까지의 대화에서 이 장소에 필요한 내용만 모았어요.");
  if (note || !groups.length) return [h("section", { className: "ride-card ask-person" }, h("p", { className: "ask-title" }, note ? "내리기 전, 일행이 말한 부탁" : asks.kind === "stale" ? "받은 목록에는 이곳 부탁이 없어요" : "여기서 챙길 부탁은 없어요"), note && h("p", { className: "ask-detail" }, note)), !note && asks.kind === "stale" && footer];
  return [
    ...groups.map((g) => {
      const first = g.items[0];
      const said = g.said[0];
      return h("section", { className: "ride-card ask-person" },
        avatar(g.person ?? {}),
        h("div", { className: "ask-copy" },
          h("p", { className: "ask-title" }, h("span", { className: "ask-name" }, g.name), "  ", askLabel(first)),
          h("p", { className: "ask-detail" }, g.items.length > 1 ? g.items.slice(1).map(askLabel).join(" / ") : said ? `${hhmm(said)}에 한 말` : ""),
        ),
      );
    }),
    footer,
  ];
}

