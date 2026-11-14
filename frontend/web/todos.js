// 장소별 할 일과 도착 안내(T120). 서버가 전사에서 뽑은 목록(GET /todos)을 그대로 보이고 상태만 바꾼다(PATCH /todos/{id}).
// 폰은 내비의 장소를 모르므로 도착을 스스로 판정하지 않는다. 서버가 알려 준 arrival(T119)이 있을 때만 '도착했어요'라고 말한다.
import { h, toast } from "./shared.js";

const time = (at) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
const button = (text, onclick, className = "") => h("button", { type: "button", className, onclick }, text);
const STATUS = { done: ["완료", "ok"], cancelled: ["취소됨", ""] };

// 볼 수 없는 이유. 볼 수 있으면 "".
export function todoAccess(participant, token) {
  if (!participant?.consent) return "기록에 동의한 사람만 할 일을 볼 수 있어요.";
  if (!token) return "이 폰에서 연결한 사람만 할 일을 볼 수 있어요.";
  return "";
}

// 서버 도착 브리핑과 같은 이름 포함 규칙(backend/api/todos.js placeMatches).
export const placeMatches = (place, name) => String(name ?? "").replace(/\s/g, "").includes(place);

// 도착한 곳의 미완료 항목(here)과 나머지를 장소별로 묶는다. 장소는 처음 말한 순서, 안에서는 미완료가 먼저.
export function groupTodos(items, arrival) {
  const list = Array.isArray(items) ? items : [];
  const first = (t) => Math.min(...t.sources.map((s) => s.at));
  const here = arrival?.place ? list.filter((t) => t.status === "pending" && placeMatches(t.place, arrival.place)) : [];
  const places = new Map();
  for (const t of list.filter((t) => !here.includes(t)).sort((a, b) => first(a) - first(b))) places.set(t.place, [...(places.get(t.place) ?? []), t]);
  return {
    arrival: arrival?.place ? arrival : null,
    here,
    places: [...places].map(([place, group]) => ({ place, items: group.sort((a, b) => (a.status !== "pending") - (b.status !== "pending")) })),
    pending: list.filter((t) => t.status === "pending").length,
  };
}

// 확인된 화자만 이름을 붙인다. 모르면 지어내지 않는다.
export const speakerOf = (source, participants = []) => participants.find((p) => p.id === source.participantId)?.name ?? "말한 사람 미확인";

export function createTodos({ getTrip, getParticipant, getToken, request, onChange }) {
  let state = null; // { key, items, arrival, generation, at(받은 시각), error, denied, ready }
  let seen = ""; // 마지막으로 읽은 여행 버전
  let loading = false;
  let again = false; // 조회 중에 또 읽으라는 요청이 왔다: 끝나면 한 번 더 읽는다
  const busy = new Set(); // 수정 요청이 가 있는 항목. 그 줄의 단추만 잠근다
  const open = new Set(); // 펼쳐 둔 원발화(다시 그려도 유지)
  const key = () => {
    const trip = getTrip(), me = getParticipant();
    return trip && me && !todoAccess(me, getToken()) ? `${trip.code}:${trip.generation ?? 1}:${me.id}` : "";
  };

  // 권한이 없어졌으면 받은 글(목록·도착·펼친 원발화)을 화면에 남기지 않는다. 먼저 떠난 조회가 늦게 돌아와 되살리지 못하게 판을 올린다.
  const DENIED = "지금은 할 일을 볼 수 없어요. 기록 동의와 동승 연결을 확인해 주세요.";
  const deny = (s) => { Object.assign(s, { items: [], arrival: null, error: "", denied: DENIED, ready: true, epoch: s.epoch + 1, gone: s.gone + 1 }); open.clear(); onChange(); };

  async function load() {
    const k = key();
    if (!k) return;
    if (loading) { again = true; return; }
    loading = true;
    const s = state, epoch = s.epoch;
    const current = () => key() === k && state === s && s.epoch === epoch;
    try {
      const data = await request("GET", "/todos");
      if (!current()) return;
      const before = JSON.stringify([s.items, s.arrival, s.error, s.denied, s.ready]);
      Object.assign(s, { items: data.items, arrival: data.arrival ?? null, generation: data.generation, at: Date.now(), error: "", denied: "", ready: true });
      if (JSON.stringify([s.items, s.arrival, s.error, s.denied, s.ready]) !== before) onChange();
    } catch (e) {
      if (!current()) return;
      // 연결만 끊겼으면 마지막 목록을 두고 고치지 못하게 한다(이미 접근 불가면 그대로 둔다).
      if ([401, 403, 404].includes(e.status)) return deny(s);
      s.error = e.status === 0 ? "연결이 끊겼어요." : "할 일을 불러오지 못했어요.";
      onChange();
    } finally {
      loading = false;
      if (again) { again = false; load(); }
    }
  }

  // 화면을 그릴 때마다 부른다. 여행·동의 세대·참가자가 바뀌면 받은 목록을 버리고, 여행이 바뀌었으면(도착 포함) 다시 읽는다.
  function sync() {
    const k = key(), trip = getTrip();
    if (state?.key !== k) { state = k ? { key: k, items: [], arrival: null, error: "", denied: "", ready: false, epoch: 0, gone: 0 } : null; open.clear(); seen = ""; }
    if (!state) return;
    const version = `${trip.code}:${trip.version}`;
    if (version !== seen) { seen = version; load(); }
  }
  // 받아 적은 말은 여행 버전을 올리지 않으므로 보이는 동안 따로 묻는다. ponytail: 6초 폴링, 지연이 문제면 SSE로.
  setInterval(() => { if (state && !document.hidden) load(); }, 6000).unref?.();

  async function set(todo, status) {
    const s = state;
    if (!s || busy.has(todo.id)) return;
    busy.add(todo.id);
    onChange();
    const gone = s.gone;
    try {
      const { item } = await request("PATCH", `/todos/${todo.id}`, { generation: s.generation, expectedVersion: todo.version, status });
      if (state !== s || s.gone !== gone) return;
      // 이 수정보다 먼저 떠난 조회는 옛 상태를 들고 온다. 버리고 새로 읽어 완료한 것을 되돌리지 않게 한다.
      s.epoch++;
      s.items = s.items.map((t) => (t.id === item.id ? item : t));
      load();
    } catch (e) {
      if (state !== s || s.gone !== gone) return;
      if (e.status === 401 || e.status === 403) return deny(s); // 동의가 꺼졌거나 토큰을 잃었다: 다시 읽기를 기다리지 않고 바로 지운다
      // 다른 사람이 먼저 바꿨거나 원문이 바뀌었으면 덮어쓰지 않고 최신 목록을 다시 보인다.
      toast(e.status === 409 || e.status === 404 ? "그사이 바뀌었어요. 최신 목록을 다시 읽었어요." : e.status === 0 ? "연결이 끊겨서 바꾸지 못했어요." : e.message);
      s.epoch++;
      await load();
    } finally {
      busy.delete(todo.id);
      onChange();
    }
  }

  const row = (t, participants, locked) => {
    const closed = t.status !== "pending";
    const last = t.sources.at(-1);
    const act = (label, status, className = "") => h("button", { type: "button", className, disabled: locked || busy.has(t.id), onclick: () => set(t, status) }, label);
    return h("li", { className: closed ? "closed" : "" },
      h("div", { className: "between" }, h("span", { className: "what grow" }, t.text), closed && h("span", { className: `pill ${STATUS[t.status][1]}` }, STATUS[t.status][0])),
      h("details", { className: "todo-source", open: open.has(t.id), ontoggle: (e) => (e.target.open ? open.add(t.id) : open.delete(t.id)) },
        h("summary", { className: "meta" }, `${speakerOf(last, participants)} · ${time(last.at)}${t.sources.length > 1 ? ` 외 ${t.sources.length - 1}번` : ""} · 원래 한 말`),
        h("ul", {}, t.sources.map((src) => h("li", {},
          h("p", { className: "meta" }, `${speakerOf(src, participants)} · ${time(src.at)}`),
          h("p", {}, `“${src.displayText}”`),
          src.text !== src.displayText && h("p", { className: "meta" }, `처음 받아 적은 말: ${src.text}`),
        ))),
      ),
      h("div", { className: "row" }, closed
        ? act("다시 열기", "pending", "plain")
        : [act("완료", "done"), act("취소", "cancelled", "plain")]),
    );
  };

  // 여행 화면에 넣을 카드. 볼 수 없으면 이유만 보인다.
  function card() {
    const trip = getTrip(), me = getParticipant();
    if (!trip || !me) return null;
    const reason = todoAccess(me, getToken()) || state?.denied;
    const title = (n) => h("h2", {}, n ? `도착해서 할 일 ${n}건` : "도착해서 할 일");
    if (reason || !state) return h("section", { className: "card todos" }, title(0), h("p", { className: "empty" }, reason || "할 일을 불러오고 있어요."));
    const g = groupTodos(state.items, state.arrival);
    const people = trip.participants;
    const locked = !!state.error;
    const list = (items) => h("ul", {}, items.map((t) => row(t, people, locked)));
    return h("section", { className: "card todos" },
      title(g.pending),
      state.error && h("p", { className: "meta", role: "status" }, state.at ? `${state.error} ${time(state.at)}에 받은 목록이에요.` : state.error, " ", button("다시 불러오기", load, "plain")),
      g.arrival && h("div", { className: "todo-here" },
        h("span", { className: "pill accent" }, "도착"),
        h("p", { className: "what" }, `${g.arrival.place}에 도착했어요`),
        h("p", { className: "meta" }, g.here.length ? `여기서 할 일 ${g.here.length}건 · 오는 길에 나온 말로 모았어요` : "여기서 할 일은 없어요."),
        g.here.length > 0 && list(g.here),
      ),
      g.places.map(({ place, items }) => h("div", { className: "todo-place" }, h("h3", {}, place), list(items))),
      !state.ready && !state.error && h("p", { className: "empty" }, "할 일을 불러오고 있어요."),
      state.ready && !state.items.length && h("p", { className: "empty" }, "아직 장소별 할 일이 없어요. ‘마트에서 우유 사자’처럼 장소와 함께 말하면 여기에 모여요."),
    );
  }
  // 주행 화면(ride.js)이 읽는 지금 목록. 볼 수 없으면(동의 전·권한 거부) null이라 부탁을 지어내지 않는다.
  const snapshot = () => {
    const me = getParticipant();
    if (!state || todoAccess(me, getToken()) || state.denied) return null;
    return { ready: state.ready, items: state.items, arrival: state.arrival, error: state.error, at: state.at ?? null };
  };
  return { card, sync, snapshot };
}
