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
const TRIP = {
  boarding: ["탑승 중", "모두 타면 운전자가 출발을 눌러요."],
  driving: ["주행 중", "부탁은 아래 단추로 언제든 남길 수 있어요."],
  parked: ["주차 완료", "이번 주행의 기록을 마감했어요."],
  ended: ["여행 종료", "이 여행은 만든 뒤 48시간까지 볼 수 있어요."],
};
const NEXT_TRIP = { boarding: ["출발", "driving"], driving: ["주차", "parked"], parked: ["여행 끝내기", "ended"] };
const WHEN = { now: "다음에 쉴 때", return: "돌아가는 길에", before_arrival: "도착하기 전에", after_parking: "주차한 뒤에" };
const REQ = {
  held: ["보관", ""],
  proposed: ["제안 중", "accent"],
  accepted: ["수락됨", "accent"],
  reflected: ["경유 반영", "ok"],
  done: ["완료", "ok"],
  cancelled: ["취소됨", ""],
};
const CLOSED = ["done", "cancelled"];
const LEVEL = ["끔", "1", "2", "3"];
// 한 번 눌러 채우는 부탁: [단추 글자, 채울 문장, 언제]
const QUICK = [
  ["화장실", "화장실 가고 싶어요", "now"],
  ["커피", "커피 사고 싶어요", "now"],
  ["휴게소", "휴게소에 들러요", "now"],
  ["편의점", "편의점에 들러요", "now"],
  ["깨워 주세요", "도착 10분 전에 깨워 주세요", "before_arrival"],
];

const app = document.getElementById("app");
const sheet = document.getElementById("sheet");
const toastEl = document.getElementById("toast");
const code = () => location.hash.slice(1).toUpperCase();
const myId = () => localStorage.getItem(`gachita:${code()}`);

let trip = null; // 서버에서 받은 여행
let failed = ""; // 여행을 불러오지 못한 이유
let offline = false;
let stale = false; // 입력 중에 온 변경은 입력이 끝난 뒤 그린다
const draft = { join: "", step: 0, name: "", seat: "", tempC: 22, heat: 0, vent: 0 };

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

async function call(method, path, body) {
  const res = await fetch(`/api/trips${path}`, { method, body: body && JSON.stringify(body) });
  if (res.status === 304) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

// 단추와 폼이 부르는 동작. 실패하면 이유를 알린다. 통신이 끊기면 fetch가 TypeError를 던진다.
async function act(fn) {
  try {
    await fn();
    await refresh(true);
  } catch (e) {
    toast(e instanceof TypeError ? "연결이 끊겨서 보내지 못했어요." : e.message);
  }
}

const typing = () => app.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);

async function refresh(force) {
  if (failed && !force) return;
  if (code()) {
    try {
      const next = await call("GET", `/${code()}${trip && !force ? `?v=${trip.version}` : ""}`);
      offline = false;
      if (!next) return;
      trip = next;
      failed = "";
    } catch (e) {
      if (e instanceof TypeError) {
        // 터널 같은 곳에서는 마지막 화면을 그대로 두고 계속 다시 묻는다
        if (!offline) toast("연결이 끊겼어요. 다시 이어지면 새로 보여 드려요.");
        offline = true;
        return;
      }
      trip = null;
      failed = e.message;
    }
  } else if (!force) return; // 첫 화면은 서버에서 바뀔 것이 없다
  if (typing() && !force) stale = true;
  else render();
}

// 작은 DOM 도우미: h("button", { onclick }, "글자")
function h(tag, props = {}, ...kids) {
  const el = Object.assign(document.createElement(tag), props);
  for (const [k, v] of Object.entries(props)) if (k.startsWith("aria-")) el.setAttribute(k, v);
  el.append(...kids.flat().filter((k) => k || k === 0)); // 조건이 거짓인 자리(false, undefined)는 뺀다
  return el;
}
const button = (label, onclick, className = "") => h("button", { type: "button", className, onclick }, label);
const bar = (...kids) => h("div", { className: "bar" }, h("div", {}, kids));
const header = (...kids) => h("div", { className: "top" }, kids);
const form = (onsubmit, ...kids) => h("form", { className: "stack", onsubmit: (e) => (e.preventDefault(), onsubmit()) }, kids);

// 하나를 고르는 칩. 라디오 단추라 키보드와 화면 낭독기가 그대로 쓴다.
const chip = (name, value, label, { sub, onpick, ...input } = {}) =>
  h("label", { className: "chip" }, h("input", { type: "radio", name, value, onchange: () => onpick?.(value), ...input }), label, sub && h("small", {}, sub));
const chipGroup = (legend, name, options, current, onpick) =>
  h("fieldset", {}, h("legend", {}, legend), h("div", { className: "chips" }, options.map(([v, label]) => chip(name, v, label, { checked: v === current, onpick }))));

// 좌석 배치. 위가 차 앞쪽이다.
const car = (seat, className = "car") =>
  h("div", { className }, h("p", { className: "meta" }, "차 앞쪽"), h("div", { className: "front" }, SEATS.slice(0, 2).map(seat)), h("div", { className: "rear" }, SEATS.slice(2).map(seat)));

function share() {
  const url = `${location.origin}/#${trip.code}`;
  if (navigator.share) navigator.share({ title: "같이타 여행 초대", url }).catch(() => {});
  else navigator.clipboard.writeText(url).then(() => toast("초대 주소를 복사했어요."), () => toast(url));
}

function home() {
  return [
    header(h("span", { className: "brand" }, "같이타")),
    h("h1", {}, "여행을 시작할까요?"),
    h("p", { className: "sub" }, "같이 탄 사람들의 부탁과 자리 설정을 한곳에서 챙겨요."),
    h(
      "form",
      { className: "card", onsubmit: (e) => (e.preventDefault(), (location.hash = draft.join.trim())) },
      h(
        "label",
        { className: "field" },
        h("span", {}, "초대 코드가 있나요?"),
        h("input", { className: "code", value: draft.join, required: true, minLength: 6, maxLength: 6, autocapitalize: "characters", autocomplete: "off", placeholder: "K7M2QX", oninput: (e) => (draft.join = e.target.value) }),
      ),
      h("button", {}, "코드로 참가"),
    ),
    bar(button("새 여행 만들기", () => act(async () => (location.hash = (await call("POST", "", {})).code)), "primary")),
  ];
}

const loading = () => [header(h("span", { className: "brand" }, "같이타")), h("div", { className: "skeleton" }), h("div", { className: "skeleton" })];

const missing = () => [
  header(h("span", { className: "brand" }, "같이타")),
  h("h1", {}, "여행을 찾지 못했어요"),
  h("p", { className: "sub" }, `${failed}. 코드를 다시 확인해 주세요.`),
  bar(button("처음으로", () => (location.hash = ""), "primary")),
];

// 참가: 한 화면에 한 가지씩 묻는다
function join() {
  const taken = Object.fromEntries(trip.participants.map((p) => [p.seat, p.name]));
  const go = (n) => {
    draft.step = n;
    render();
    app.querySelector("input:not([type=radio])")?.focus();
  };
  const submit = (consent) =>
    act(async () => {
      const body = { name: draft.name.trim(), seat: draft.seat, consent, prefs: { tempC: draft.tempC, heat: draft.heat, vent: draft.vent } };
      localStorage.setItem(`gachita:${trip.code}`, (await call("POST", `/${trip.code}/participants`, body)).id);
      draft.step = 0;
    });
  const next = () => bar(h("button", { className: "primary" }, "다음"));
  const temp = h("output", { "aria-live": "polite" }, `${draft.tempC.toFixed(1)}℃`);
  const bump = (d) => () => (temp.textContent = `${(draft.tempC = Math.min(27, Math.max(17, draft.tempC + d))).toFixed(1)}℃`);

  const steps = [
    () => ({
      title: "뭐라고 부를까요?",
      sub: `초대 코드 ${trip.code} 여행에 참가해요.`,
      body: form(
        () => go(1),
        h("label", { className: "field" }, h("span", {}, "이름"), h("input", { value: draft.name, required: true, maxLength: 20, autocomplete: "nickname", oninput: (e) => (draft.name = e.target.value) })),
        next(),
      ),
    }),
    () => ({
      title: "어디에 앉으셨나요?",
      sub: "앉은 자리에 맞춰 온도와 시트를 적용해요.",
      body: form(
        () => go(2),
        car(([id, label]) => chip("seat", id, label, { checked: draft.seat === id, disabled: !!taken[id], required: true, sub: taken[id], onpick: (v) => (draft.seat = v) })),
        next(),
      ),
    }),
    () => ({
      title: "온도와 시트는 어떻게 할까요?",
      sub: "차가 지원하는 범위 안에서 탈 때 맞춰 드려요.",
      body: form(
        () => go(3),
        h(
          "div",
          { className: "card" },
          h("div", { className: "temp" }, h("button", { type: "button", onclick: bump(-0.5), "aria-label": "온도 낮추기" }, "−"), temp, h("button", { type: "button", onclick: bump(0.5), "aria-label": "온도 올리기" }, "+")),
          chipGroup("시트 열선", "heat", LEVEL.map((l, i) => [i, l]), draft.heat, (v) => (draft.heat = v)),
          chipGroup("시트 통풍", "vent", LEVEL.map((l, i) => [i, l]), draft.vent, (v) => (draft.vent = v)),
        ),
        next(),
      ),
    }),
    () => ({
      title: "이동 중 대화를 기록해도 될까요?",
      sub: "도착한 뒤 재미있던 장면을 클립으로 남기는 데 써요.",
      body: [
        h(
          "ul",
          { className: "card" },
          h("li", {}, "주행하는 동안 차 안의 대화를 기록해요."),
          h("li", {}, "한 명이라도 동의하지 않으면 기록하지 않아요."),
          h("li", {}, "동의는 여행 중 언제든 끌 수 있어요."),
        ),
        bar(button("동의하고 참가", () => submit(true), "primary"), button("동의하지 않고 참가", () => submit(false))),
      ],
    }),
  ];
  const s = steps[draft.step]();
  return [
    header(button("이전", () => (draft.step ? go(draft.step - 1) : (location.hash = "")), "plain"), h("span", { className: "meta" }, `${draft.step + 1} / ${steps.length}`)),
    h("h1", {}, s.title),
    h("p", { className: "sub" }, s.sub),
    s.body,
  ];
}

function tripView(me) {
  const t = `/${trip.code}`;
  const driver = me.seat === "ROW_1_LEFT";
  const by = Object.fromEntries(trip.participants.map((p) => [p.id, p]));
  const seated = Object.fromEntries(trip.participants.map((p) => [p.seat, p]));
  const waiting = trip.status === "driving" ? trip.participants.filter((p) => !p.consent).map((p) => p.name) : [];
  const patch = (path, body) => () => act(() => call("PATCH", t + path, body));
  const open = trip.requests.filter((r) => !CLOSED.includes(r.status));
  const rec = trip.recording ? ["기록 중", "rec"] : trip.status !== "driving" ? ["기록 안 함", ""] : waiting.length ? ["동의 대기", ""] : ["기록 일시정지", ""];
  const next = NEXT_TRIP[trip.status];
  const controls = [
    trip.status === "driving" && !waiting.length && button(trip.recording ? "기록 일시정지" : "다시 기록", patch("", { recording: !trip.recording })),
    driver && next && button(next[0], patch("", { status: next[1] }), "primary grow"),
  ].filter(Boolean);

  // 운전자가 제안하고 수락한다. 반영 확인은 차량 앱이 내비 결과를 받은 뒤 누르는 자리다.
  const request = (r) => {
    const go = (label, status, className) => button(label, patch(`/requests/${r.id}`, { status }), className);
    const actions = [
      driver && r.status === "held" && go("들르자고 제안", "proposed"),
      driver && r.status === "proposed" && go("수락", "accepted"),
      driver && r.status === "proposed" && go("나중에", "held", "plain"),
      driver && r.status === "accepted" && go("경유 반영 확인", "reflected"),
      driver && r.status === "reflected" && go("완료", "done"),
      !CLOSED.includes(r.status) && (driver || r.by === me.id) && go("취소", "cancelled", "plain"),
    ].filter(Boolean);
    return h(
      "li",
      { className: CLOSED.includes(r.status) ? "closed" : "" },
      h("div", { className: "between" }, h("span", { className: "what grow" }, r.text), h("span", { className: `pill ${REQ[r.status][1]}` }, REQ[r.status][0])),
      h("p", { className: "meta" }, `${by[r.by]?.name ?? "떠난 사람"} · ${WHEN[r.when]}`),
      actions.length > 0 && h("div", { className: "row" }, actions),
    );
  };

  return [
    header(h("span", { className: "brand" }, "같이타"), h("span", { className: "meta" }, trip.title || `코드 ${trip.code}`)),
    h(
      "section",
      { className: "card" },
      h("div", { className: "between" }, h("p", { className: "state" }, TRIP[trip.status][0]), h("span", { className: `pill ${rec[1]}` }, rec[0])),
      h("p", { className: "sub" }, waiting.length ? `${waiting.join(", ")} 님이 동의하면 기록을 시작해요.` : TRIP[trip.status][1]),
      controls.length > 0 && h("div", { className: "row" }, controls),
    ),
    h(
      "section",
      { className: "card" },
      h("h2", {}, open.length ? `챙길 부탁 ${open.length}건` : "챙길 부탁"),
      trip.requests.length ? h("ul", {}, trip.requests.map(request)) : h("p", { className: "empty" }, "아직 부탁이 없어요. 들르고 싶은 곳이나 챙길 일을 남겨 보세요."),
    ),
    h(
      "section",
      { className: "stack" },
      h("div", { className: "between" }, h("h2", {}, `일행 ${trip.participants.length}명`), button(`초대 코드 ${trip.code}`, share)),
      car(([id, label]) => {
        const p = seated[id];
        return h("div", { className: `chip${p ? "" : " empty"}${p?.id === me.id ? " me" : ""}` }, p ? p.name : "빈자리", h("small", {}, label));
      }, "car readonly"),
    ),
    h(
      "section",
      { className: "card" },
      h("div", {}, h("p", { className: "what" }, "내 자리 설정"), h("p", { className: "meta" }, `${SEAT[me.seat]} · ${me.prefs.tempC}℃, 열선 ${LEVEL[me.prefs.heat]}, 통풍 ${LEVEL[me.prefs.vent]}`)),
      h(
        "div",
        { className: "between" },
        h("div", {}, h("p", { className: "what" }, "대화 기록 동의"), h("p", { className: "meta" }, me.consent ? "동의했어요." : "동의하지 않았어요.")),
        button(me.consent ? "동의 끄기" : "동의 켜기", patch(`/participants/${me.id}`, { consent: !me.consent })),
      ),
    ),
    trip.moments.length > 0 &&
      h(
        "section",
        { className: "card" },
        h("h2", {}, `남긴 장면 ${trip.moments.length}개`),
        h("ul", {}, trip.moments.map((m) => h("li", {}, h("span", { className: "what" }, m.label || "이름 없는 장면"), h("span", { className: "meta" }, new Date(m.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }))))),
      ),
    trip.status !== "ended" && bar(button("부탁 남기기", () => (sheet.showModal(), sheet.querySelector("#sheet-text").focus()), "primary")),
  ];
}

function render() {
  stale = false;
  const me = trip?.participants.find((p) => p.id === myId());
  const view = !code() ? home() : failed ? missing() : !trip ? loading() : me ? tripView(me) : join();
  app.replaceChildren(...view.flat().filter(Boolean));
}

// 부탁 남기기 시트는 한 번만 채운다
{
  const text = sheet.querySelector("#sheet-text");
  sheet.querySelector("#sheet-quick").className = "chips free";
  sheet.querySelector("#sheet-quick").append(
    ...QUICK.map(([label, sentence, when]) =>
      button(label, () => {
        text.value = sentence;
        sheet.querySelector(`input[name=when][value=${when}]`).checked = true;
      }),
    ),
  );
  sheet.querySelector("#sheet-when").append(...Object.entries(WHEN).map(([v, label]) => chip("when", v, label, { checked: v === "now", defaultChecked: v === "now" })));
  sheet.querySelector("#sheet-close").onclick = () => sheet.close();
  // 시트 위쪽 바깥을 누르면 닫는다. on* 속성에 넣은 함수가 false를 돌려주면 기본 동작(폼 제출)까지 막히므로 addEventListener를 쓴다.
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet && e.clientY < sheet.getBoundingClientRect().top) sheet.close();
  });
  sheet.querySelector("form").onsubmit = (e) => {
    e.preventDefault();
    const body = { by: myId(), text: text.value, when: new FormData(e.target).get("when") };
    act(async () => {
      await call("POST", `/${code()}/requests`, body);
      sheet.close();
      e.target.reset();
      toast("부탁을 남겼어요.");
    });
  };
}

addEventListener("hashchange", () => ((trip = null), (failed = ""), (draft.step = 0), refresh(true)));
app.addEventListener("focusout", () => setTimeout(() => stale && !typing() && render())); // 입력이 끝나면 밀린 변경을 그린다
setInterval(refresh, 2000); // ponytail: 2초마다 묻는다(바뀐 게 없으면 304). 지연이 문제가 되면 SSE로 바꾼다.
render();
refresh(true);
