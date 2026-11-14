// '함께 타는 중' 탭(최종 시안 P17–P21)과 세 탭 틀. 무엇을 보일지는 서버가 준 값으로만 고르고 지어내지 않는다.
// - 여행 상태·기록 여부: GET /trips/{code}의 status·recording
// - 장소: 같은 문서의 places(차가 내비에서 읽어 기록, 묶음 A3). 없으면 '곧 도착'과 이동 중인 곳을 보이지 않는다.
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

// 서버의 장소 기록. 쌓인 순서(차가 보낸 순서)를 그대로 두고, 이름이 없는 것만 뺀다.
export const placesOf = (trip) => (Array.isArray(trip?.places) ? trip.places : []).filter((p) => p && typeof p.name === "string" && p.name.trim());

// 다음에 갈 곳: 아직 도착하지 않은 첫 경유지, 없으면 마지막 목적지(도착했으면 없음).
export function nextTarget(places) {
  const arrived = new Set(places.filter((p) => p.kind === "arrived").map((p) => key(p.name)));
  const open = (p) => !arrived.has(key(p.name));
  return places.find((p) => p.kind === "stop" && open(p))?.name ?? [...places].reverse().find((p) => p.kind === "destination" && open(p))?.name ?? "";
}

// 지금 보일 상태. arrival은 GET /todos의 도착(동의한 참가자만), seenArrival은 이 폰이 이번 세대에서 본 도착 장소,
// nearSeen은 '확인'을 누른 곧 도착 장소. kind: boarding | drive | paused | near | arrived | continue | parked | ended
export function driveState(trip, { arrival = null, seenArrival = "", nearSeen = "" } = {}) {
  const places = placesOf(trip);
  const last = places.at(-1);
  const target = nextTarget(places);
  const status = trip?.status;
  if (status === "boarding" || status === "ended") return { kind: status, target };
  if (status === "parked") {
    const place = arrival?.place || (last?.kind === "arrived" ? last.name : "");
    return place ? { kind: "arrived", place, target } : { kind: "parked", target };
  }
  if (last?.kind === "approaching" && key(last.name) !== key(nearSeen)) return { kind: "near", place: last.name, eta: Number.isFinite(last.etaSeconds) ? last.etaSeconds : null, target: last.name };
  if (!trip?.recording) return { kind: "paused", target };
  const arrived = [...places].reverse().find((p) => p.kind === "arrived")?.name || seenArrival;
  return arrived ? { kind: "continue", place: arrived, target } : { kind: "drive", target };
}

// 그 장소에서 챙길 미완료 할 일(서버와 같은 이름 포함 규칙).
export const asksAt = (items, place) => (place && Array.isArray(items) ? items.filter((t) => t.status === "pending" && placeMatches(t.place, place)) : []);

// 카드에 보일 부탁 글: 장소 카드 안이라 앞의 '○○에서'는 뺀다(서버 규칙이 뽑은 장소일 때만).
export function askLabel(todo) {
  const text = String(todo?.text ?? "").trim();
  for (const lead of ["는 ", "도 ", " "].map((tail) => `${todo?.place}에서${tail}`)) if (todo?.place && text.startsWith(lead) && text.length > lead.length) return text.slice(lead.length).trim();
  return text;
}

// 도착한 곳의 부탁을 말한 사람별로 묶는다. 이름은 서버가 확인한 화자(participantId)만 붙이고, 모르면 한 묶음으로 둔다.
// 묶음 순서는 그 사람이 처음 말한 시각, 모르는 화자는 맨 뒤.
export function arrivalAsks(items, place, participants = []) {
  const groups = new Map();
  for (const todo of asksAt(items, place)) {
    const sources = Array.isArray(todo.sources) ? todo.sources : [];
    const speaker = sources.find((s) => participants.some((p) => p.id === s.participantId))?.participantId;
    const person = participants.find((p) => p.id === speaker) ?? null;
    const id = person?.id ?? "";
    if (!groups.has(id)) groups.set(id, { person, name: person?.name ?? "말한 사람 미확인", items: [], first: Infinity });
    const group = groups.get(id);
    group.items.push(todo);
    group.first = Math.min(group.first, ...sources.map((s) => s.at).filter(Number.isFinite));
  }
  return [...groups.values()].sort((a, b) => !a.person - !b.person || a.first - b.first);
}

// 제목과 부제. todos가 null이면 할 일을 볼 수 없는 사람(동의 전)이라 부탁 수를 말하지 않는다.
export function rideHeading(state, { title, waiting = [], todos = null } = {}) {
  const trip = title || "함께 탄 여행";
  const going = state.target ? `${ro(state.target)} 이동 중` : "";
  switch (state.kind) {
    case "drive": return { title: "지금은 운전에 집중하세요", sub: [trip, going].filter(Boolean).join(" / ") };
    case "paused": return { title: "기록을 잠시 멈췄어요", sub: waiting.length ? `${waiting.join(", ")} 님의 기록 동의를 기다리고 있어요.` : "대화가 더 이상 기록되지 않아요." };
    case "near": return { title: `곧 ${state.place}에 도착해요`, sub: [state.eta != null && `도착 약 ${Math.max(1, Math.round(state.eta / 60))}분 전`, "일행이 말한 부탁"].filter(Boolean).join(" / ") };
    case "arrived": return { title: `${state.place}에 도착했어요`, sub: "내리기 전, 일행이 말한 부탁을 한눈에" };
    case "continue": {
      const left = todos && asksAt(todos, state.place).length;
      const done = todos == null ? `${state.place}에서 다시 출발` : left ? `${state.place}의 부탁 ${left}건 남음` : `${state.place}의 부탁은 완료`;
      return { title: "다시, 우리의 여행", sub: [done, state.target && `${ro(state.target)} 이동`].filter(Boolean).join(" / ") };
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

// 운전석에서 바꿀 수 있는 여행 상태: [글자, 다음 상태]. 첫째가 주 단추 자리다.
export function statusMoves(trip, state) {
  if (trip?.status === "boarding") return [["출발", "driving"]];
  if (trip?.status === "driving") return [["주차", "parked"]];
  if (trip?.status === "parked") return state.kind === "arrived" ? [["볼일 보고 여행 계속", "driving"], ["여행 끝내기", "ended"]] : [["여행 끝내기", "ended"], ["다시 출발", "driving"]];
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
  let found = "";
  for (const p of places) if (["start", "approaching", "arrived"].includes(p.kind) && Number.isFinite(p.at) && p.at <= at) found = p.kind === "approaching" ? `${p.name} 근처` : p.name;
  return found;
}

// 받아 적은 글을 'HH:MM / 장소' 머리로 묶는다. 같은 장소에서 gap 안에 이어진 말은 한 묶음이고,
// 할 일의 원발화(asks: 'device:seq')는 따로 '부탁' 카드가 된다. lines는 transcriptLines()의 시간순 결과.
export function transcriptSections(lines, { places = [], asks = new Set(), gap = 5 * 60_000 } = {}) {
  const log = [...places].filter((p) => Number.isFinite(p?.at)).sort((a, b) => a.at - b.at);
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

// 곧 도착(P19): 그 장소에서 챙길 부탁. todos가 null이면 볼 수 없는 이유를 말한다.
export function nearCard(state, todos, reason) {
  const asks = asksAt(todos, state.place);
  return h("section", { className: "ride-card near-card", role: "status" },
    h("h2", {}, reason ? "부탁은 기록에 동의한 사람만 봐요" : asks.length ? `내리기 전에 기억할 ${asks.length}가지` : "이곳에서 챙길 부탁은 아직 없어요"),
    reason ? h("p", {}, reason) : asks.length > 0 && h("ul", { className: "near-asks" }, asks.map((t) => h("li", {}, askLabel(t)))),
    h("p", { className: "meta" }, "주차하면 사람별로 자세히 보여드릴게요."),
  );
}

// 도착(P20): 사람별 부탁 카드.
export function arrivalCards(state, todos, participants, avatar, reason) {
  const groups = arrivalAsks(todos, state.place, participants);
  if (reason || !groups.length) return [h("section", { className: "ride-card ask-person" }, h("p", { className: "ask-title" }, reason ? "부탁은 기록에 동의한 사람만 봐요" : "여기서 챙길 부탁은 없어요"), reason && h("p", { className: "ask-detail" }, reason))];
  return [
    ...groups.map((g) => {
      const first = g.items[0];
      const said = first.sources?.find((s) => Number.isFinite(s.at))?.at;
      return h("section", { className: "ride-card ask-person" },
        avatar(g.person ?? {}),
        h("div", { className: "ask-copy" },
          h("p", { className: "ask-title" }, h("span", { className: "ask-name" }, g.name), "  ", askLabel(first)),
          h("p", { className: "ask-detail" }, g.items.length > 1 ? g.items.slice(1).map(askLabel).join(" / ") : said ? `${hhmm(said)}에 한 말` : ""),
        ),
      );
    }),
    h("p", { className: "ride-note" }, "방금까지의 대화에서 이 장소에 필요한 내용만 모았어요."),
  ];
}

