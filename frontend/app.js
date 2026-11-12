// 같이타 모바일 화면. 빌드 없이 브라우저가 그대로 읽는다.
// 주소 끝의 #코드가 여행이고, 이 폰이 누구로 참가했는지는 localStorage에 둔다.
// 사용자가 쓴 글은 textContent로만 넣는다(innerHTML 금지).

const SEATS = [
  ["ROW_1_LEFT", "운전석"],
  ["ROW_1_RIGHT", "조수석"],
  ["ROW_2_LEFT", "뒤 왼쪽"],
  ["ROW_2_CENTER", "뒤 가운데"],
  ["ROW_2_RIGHT", "뒤 오른쪽"],
];
const SEAT = Object.fromEntries(SEATS);
const TRIP = { boarding: "탑승 중", driving: "주행 중", parked: "주차", ended: "여행 종료" };
const WHEN = { now: "다음에 쉴 때", return: "돌아가는 길에", before_arrival: "도착하기 전에", after_parking: "주차한 뒤에" };
const REQ = { held: "보관 중", proposed: "제안함", accepted: "수락", reflected: "경유 반영", done: "완료", cancelled: "취소" };
const LEVEL = ["끔", "1", "2", "3"];

const app = document.getElementById("app");
const code = () => location.hash.slice(1).toUpperCase();
const myId = () => localStorage.getItem(`gachita:${code()}`);

let trip = null;
let error = "";
let stale = false; // 입력 중에 온 변경은 입력이 끝난 뒤 그린다
const draft = { name: "", seat: "", tempC: 22, heat: 0, vent: 0, consent: false, text: "", when: "now", join: "" };

async function call(method, path, body) {
  const res = await fetch(`/api/trips${path}`, { method, body: body && JSON.stringify(body) });
  if (res.status === 304) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// 버튼과 폼이 부르는 동작. 실패하면 이유를 화면에 적는다.
async function act(fn) {
  try {
    error = "";
    await fn();
    await refresh(true);
  } catch (e) {
    error = e.message;
    render();
  }
}

const typing = () => app.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);

async function refresh(force) {
  if (code()) {
    try {
      const next = await call("GET", `/${code()}${trip && !force ? `?v=${trip.version}` : ""}`);
      if (!next) return;
      trip = next;
    } catch (e) {
      trip = null;
      error = e.message;
    }
  } else if (!force) return; // 첫 화면은 서버에서 바뀔 것이 없다
  if (typing() && !force) stale = true;
  else render();
}

// 작은 DOM 도우미: h("button", { onclick }, "글자")
function h(tag, props = {}, ...kids) {
  const el = Object.assign(document.createElement(tag), props);
  for (const [k, v] of Object.entries(props)) if (k.startsWith("aria-") || k === "for") el.setAttribute(k, v);
  el.append(...kids.flat().filter((k) => k || k === 0)); // 조건이 거짓인 자리(false, undefined)는 뺀다
  return el;
}
const button = (label, onclick, cls = "") => h("button", { type: "button", className: cls, onclick }, label);
const field = (label, control) => h("label", { className: "field" }, h("span", {}, label), control);
const bind = (key, props) => h("input", { ...props, value: draft[key], oninput: (e) => (draft[key] = e.target.value) });

// 여러 값 중 하나를 고르는 버튼 줄
const choice = (label, options, value, pick) =>
  h(
    "fieldset",
    {},
    h("legend", {}, label),
    h(
      "div",
      { className: "choice" },
      options.map(([v, text, disabled]) =>
        h("button", { type: "button", disabled: !!disabled, "aria-pressed": String(v === value), onclick: () => pick(v) }, text),
      ),
    ),
  );

function home() {
  return [
    h("h1", {}, "같이타"),
    h("p", { className: "lead" }, "차 안에서 웃었던 대화를 남기고, 부탁과 자리 설정을 함께 챙깁니다."),
    button("새 여행 만들기", () => act(async () => (location.hash = (await call("POST", "", {})).code)), "primary"),
    h(
      "form",
      { className: "card", onsubmit: (e) => (e.preventDefault(), (location.hash = draft.join.trim())) },
      field("받은 참가 코드", bind("join", { required: true, maxLength: 6, autocapitalize: "characters", placeholder: "예: K7M2QX" })),
      h("button", {}, "참가"),
    ),
  ];
}

function joinForm() {
  const taken = Object.fromEntries(trip.participants.map((p) => [p.seat, p.name]));
  const set = (key) => (v) => ((draft[key] = v), render());
  const temp = h("output", {}, `${draft.tempC}℃`);
  return [
    h("h1", {}, "여행 참가"),
    h("p", { className: "lead" }, `코드 ${trip.code} · ${trip.participants.length}명 참가 중`),
    h(
      "form",
      {
        className: "card",
        onsubmit: (e) => {
          e.preventDefault();
          if (!draft.seat) return ((error = "자리를 골라 주세요."), render());
          const body = { name: draft.name, seat: draft.seat, consent: draft.consent, prefs: { tempC: +draft.tempC, heat: draft.heat, vent: draft.vent } };
          act(async () => localStorage.setItem(`gachita:${trip.code}`, (await call("POST", `/${trip.code}/participants`, body)).id));
        },
      },
      field("이름", bind("name", { required: true, maxLength: 20, autocomplete: "nickname" })),
      choice("이번 자리", SEATS.map(([id, label]) => [id, taken[id] ? `${label} · ${taken[id]}` : label, taken[id]]), draft.seat, set("seat")),
      field(
        ["온도 ", temp],
        h("input", { type: "range", min: 17, max: 27, step: 0.5, value: draft.tempC, oninput: (e) => (temp.textContent = `${(draft.tempC = +e.target.value)}℃`) }),
      ),
      choice("시트 열선", LEVEL.map((l, i) => [i, l]), draft.heat, set("heat")),
      choice("시트 통풍", LEVEL.map((l, i) => [i, l]), draft.vent, set("vent")),
      h(
        "label",
        { className: "check" },
        h("input", { type: "checkbox", checked: draft.consent, onchange: (e) => (draft.consent = e.target.checked) }),
        "이동 중 대화를 자동으로 기록하는 데 동의합니다. 한 명이라도 동의하지 않으면 기록하지 않습니다.",
      ),
      h("button", { className: "primary" }, "참가하기"),
    ),
  ];
}

function tripView(me) {
  const t = `/${trip.code}`;
  const driver = me.seat === "ROW_1_LEFT";
  const name = (id) => trip.participants.find((p) => p.id === id)?.name ?? "?";
  const waiting = trip.participants.filter((p) => !p.consent).map((p) => p.name);
  const patch = (path, body) => () => act(() => call("PATCH", t + path, body));
  const recording = trip.recording ? "기록 중" : trip.status !== "driving" ? "기록 안 함" : waiting.length ? `동의 대기: ${waiting.join(", ")}` : "기록 일시정지";
  const nextTrip = { boarding: ["출발", "driving"], driving: ["주차", "parked"], parked: ["여행 종료", "ended"] }[trip.status];

  // 부탁마다 지금 누를 수 있는 것. 운전자가 제안·수락을 하고, 반영 확인은 차량 앱이 내비 결과를 받은 뒤 한다.
  const requestActions = (r) => {
    const go = (label, status) => button(label, patch(`/requests/${r.id}`, { status }));
    const open = !["done", "cancelled"].includes(r.status);
    return [
      driver && r.status === "held" && go("제안", "proposed"),
      driver && r.status === "proposed" && go("수락", "accepted"),
      driver && r.status === "proposed" && go("보류", "held"),
      driver && r.status === "accepted" && go("경유 반영됨", "reflected"),
      driver && r.status === "reflected" && go("완료", "done"),
      open && (driver || r.by === me.id) && go("취소", "cancelled"),
    ];
  };

  return [
    h(
      "header",
      {},
      h("h1", {}, trip.title || "같이타"),
      button(`코드 ${trip.code} 공유`, () => {
        const url = `${location.origin}/#${trip.code}`;
        const done = () => ((error = "참가 주소를 복사했습니다."), render());
        if (navigator.share) navigator.share({ title: "같이타 여행 참가", url }).catch(() => {});
        else navigator.clipboard.writeText(url).then(done, () => ((error = url), render()));
      }),
    ),
    h(
      "section",
      { className: "card" },
      h("p", { className: "status" }, h("strong", {}, TRIP[trip.status]), h("span", { className: trip.recording ? "rec on" : "rec" }, recording)),
      h(
        "div",
        { className: "row" },
        trip.status === "driving" && button(trip.recording ? "기록 일시정지" : "다시 기록", patch("", { recording: !trip.recording })),
        driver && nextTrip && button(nextTrip[0], patch("", { status: nextTrip[1] }), "primary"),
      ),
    ),
    h(
      "section",
      { className: "card" },
      h("h2", {}, `일행 ${trip.participants.length}명`),
      h(
        "ul",
        {},
        trip.participants.map((p) =>
          h(
            "li",
            {},
            h("div", {}, h("strong", {}, p.name + (p.id === me.id ? " (나)" : "")), h("small", {}, SEAT[p.seat])),
            h("small", {}, `${p.prefs.tempC}℃ · 열선 ${LEVEL[p.prefs.heat]} · 통풍 ${LEVEL[p.prefs.vent]} · ${p.consent ? "기록 동의" : "기록 동의 안 함"}`),
          ),
        ),
      ),
      button(me.consent ? "내 기록 동의 끄기" : "내 기록 동의 켜기", patch(`/participants/${me.id}`, { consent: !me.consent })),
    ),
    h(
      "section",
      { className: "card" },
      h("h2", {}, `부탁 ${trip.requests.filter((r) => !["done", "cancelled"].includes(r.status)).length}건 보관`),
      h(
        "ul",
        {},
        trip.requests.map((r) =>
          h(
            "li",
            { className: ["done", "cancelled"].includes(r.status) ? "closed" : "" },
            h("div", {}, h("strong", {}, r.text), h("small", {}, `${name(r.by)} · ${WHEN[r.when]} · ${REQ[r.status]}`)),
            h("div", { className: "row" }, requestActions(r)),
          ),
        ),
      ),
      h(
        "form",
        {
          onsubmit: (e) => {
            e.preventDefault();
            const body = { by: me.id, text: draft.text, when: draft.when };
            act(async () => (await call("POST", `${t}/requests`, body), (draft.text = "")));
          },
        },
        field("부탁 남기기", bind("text", { required: true, maxLength: 200, placeholder: "예: 화장실 가고 싶어" })),
        field(
          "언제",
          h(
            "select",
            { onchange: (e) => (draft.when = e.target.value) },
            Object.entries(WHEN).map(([v, label]) => h("option", { value: v, selected: v === draft.when }, label)),
          ),
        ),
        h("button", {}, "남기기"),
      ),
    ),
    trip.moments.length > 0 &&
      h(
        "section",
        { className: "card" },
        h("h2", {}, `남긴 장면 ${trip.moments.length}개`),
        h("ul", {}, trip.moments.map((m) => h("li", {}, h("strong", {}, m.label || "이름 없는 장면"), h("small", {}, new Date(m.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }))))),
      ),
  ];
}

function render() {
  stale = false;
  const me = trip?.participants.find((p) => p.id === myId());
  const view = !code() ? home() : !trip ? [h("h1", {}, "같이타"), button("처음으로", () => (location.hash = ""))] : me ? tripView(me) : joinForm();
  app.replaceChildren(...view.filter(Boolean), error ? h("p", { className: "notice", role: "status" }, error) : "");
}

addEventListener("hashchange", () => ((trip = null), (error = ""), refresh(true)));
app.addEventListener("focusout", () => setTimeout(() => stale && !typing() && render())); // 입력이 끝나면 밀린 변경을 그린다
setInterval(refresh, 2000); // ponytail: 2초마다 묻는다(바뀐 게 없으면 304). 지연이 문제가 되면 SSE로 바꾼다.
refresh(true);
