// 가치타 웹 시연(/demo). 에뮬레이터 모양의 차량 화면을 브라우저에 그리고, 실제 API로 여행 하나를 돌린다(T66).
// 차량 앱(frontend/car)의 흐름과 문구를 따른다. Pleos SDK에서만 되는 것(내비 경유지, 차량 STT·TTS)은
// 흉내만 내고 화면에 '시연'이라고 적는다. 마이크는 쓰지 않는다. 사용자가 쓴 글은 textContent로만 넣는다.
// 차량은 운전석 참가자로 들어가 참가자 토큰을 받고, 여행 코드·토큰·순번은 localStorage에 두어 새로 고쳐도 이어진다.

import { SEATS, SEAT, WHEN, REQ, CLOSED, api as request, h, toast } from "/shared.js";

const STATUS = { boarding: "탑승 중", driving: "주행 중", parked: "주차 완료", ended: "여행 종료" };
// 강릉 가족 여행 대사(docs/demo-video.md, frontend/car/demo.py). [누가, 자리, 말]
const LINES = [
  ["딸", "ROW_2_RIGHT", "아빠, 바다는 언제 보여?"],
  ["아빠", "ROW_1_LEFT", "산을 몇 개 넘어야 바다가 나와."],
  ["엄마", "ROW_1_RIGHT", "마트에서 우유랑 간식 사자"],
  ["아들", "ROW_2_LEFT", "화장실 가고 싶어"],
  ["아빠", "ROW_1_LEFT", "응, 다음 휴게소 가자"],
  ["딸", "ROW_2_RIGHT", "아빠, 바다는 왜 짜?"],
];
// 위치를 모를 때 차량 앱이 고르는 첫 휴게소(Asks.kt REST_STOPS, 서울 → 강릉). 시연에는 위치가 없다.
const STOP = "용인휴게소";
const DEVICE = "car-web-demo";
const KEY = "gachita-demo";
const POLL_MS = 2000;
const NAVI_MS = 1500; // 내비가 경유지를 받았다는 알림을 기다리는 흉내(에뮬레이터 실측은 약 6초)
const RESULT_MS = 8000;

const $ = (id) => document.getElementById(id);
const els = {
  setup: $("setup"), setupErr: $("setup-err"), tripwin: $("tripwin"), left: $("left"), ops: $("ops"), right: $("right"),
  stt: $("stt"), sttState: $("stt-state"), sttLines: $("stt-lines"), sttSeat: $("stt-seat"), sttText: $("stt-text"), sttSend: $("stt-send"), sttErr: $("stt-err"),
  phone: $("phone"), phoneEmpty: $("phone-empty"), phoneOpen: $("phone-open"),
  fit: $("fit"), screen: $("screen"), speed: $("speed"), gears: $("gears"), seats: $("seats"), net: $("net"), clock: $("clock"),
};

let car = load(); // { code, id, token, seq } — 이 차량(운전석 참가자)
let trip = null; // 서버의 여행 문서
let lines = []; // 기록본의 발화
let lineSig = "";
let online = true;
let busy = false;
let said = ""; // 마지막 음성 안내(시연)
let navi = null; // { id, stage: "adding" | "added" | "failed" } 경유지 반영 흉내
let loadErr = ""; // 여행을 처음 불러오지 못한 이유(불러오는 화면에서 빠져나갈 길을 보이게)

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? null;
  } catch {
    return null;
  }
}
function save() {
  try {
    if (car) localStorage.setItem(KEY, JSON.stringify(car));
    else localStorage.removeItem(KEY);
  } catch {
    // 저장소를 못 쓰면 새로 고칠 때 이어지지 않을 뿐이다
  }
}

const speak = (line) => (said = line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- API ----

// 이 여행의 경로(/api/trips…). auth면 차량의 참가자 토큰을 보낸다. 서버에 닿았는지는 연결 표시에 쓴다.
async function api(method, path, body, auth = false) {
  try {
    const data = await request(method, `/trips${path}`, body, auth && car.token);
    online = true;
    return data;
  } catch (e) {
    online = e.status !== 0;
    throw e;
  }
}

// 서버가 거절한 이유를 쉬운 말로. 서버의 원래 답도 괄호에 남겨 무엇이 막았는지 보이게 한다.
function plain(e) {
  if (e.status === undefined) return `처리하지 못했어요 · ${e.message}`;
  const m = e.message;
  const why =
    e.status === 0 ? "서버에 닿지 않아요. 연결을 확인해 주세요."
    : e.status === 401 ? "차량의 참가자 토큰을 서버가 알아보지 못했어요. 새 여행을 만들어 주세요."
    : e.status === 403 && m.includes("동의하지 않은") ? "동의하지 않은 탑승자가 있어 받아 적은 말을 올리지 않았어요. 모두 동의하면 다시 보낼 수 있어요."
    : e.status === 403 && m.includes("동의한 참가자만") ? "기록에 동의한 참가자만 기록본을 볼 수 있어요."
    : e.status === 403 ? "이 참가자는 할 수 없는 일이에요."
    : e.status === 404 ? "여행을 찾지 못했어요. 없거나 만든 지 48시간이 지났어요."
    : e.status === 409 && m.includes("동의하지 않은") ? "동의하지 않은 탑승자가 있어 기록을 켤 수 없어요."
    : e.status === 409 && m.includes("주행 중에만") ? "주행 중에만 기록할 수 있어요."
    : e.status === 409 && m.includes("자리") ? "운전석에 이미 다른 사람이 앉아 있어요."
    : e.status === 409 && m.includes("갈 수 있는 상태") ? "그사이 부탁 상태가 바뀌어 처리하지 못했어요."
    : e.status === 409 ? "지금 상태에서는 할 수 없어요."
    : e.status === 413 ? "글이 너무 길어요."
    : e.status === 400 ? "보낸 값이 형식에 맞지 않아요."
    : "서버에 문제가 생겼어요.";
  return e.status ? `${why} (서버 ${e.status}: ${m})` : why;
}

const path = (p = "") => `/${car.code}${p}`;
const me = () => trip?.participants.find((p) => p.id === car?.id);
const everyone = () => trip.participants.length > 0 && trip.participants.every((p) => p.consent);
const waiting = () => trip.participants.filter((p) => !p.consent).map((p) => p.name);
const setRequest = (id, status) => api("PATCH", path(`/requests/${id}`), { status });

// 단추가 부르는 동작. 하나씩만 돌리고, 끝나면 최신 여행을 다시 읽는다.
async function act(fn, show = toast) {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    show(plain(e));
  }
  busy = false;
  await refresh(true);
}

// ---- 흐름 ----

async function createTrip() {
  els.setupErr.textContent = "";
  const title = $("setup-title").value.trim();
  const name = $("setup-name").value.trim();
  busy = true;
  render();
  try {
    const t = await api("POST", "", { title });
    // 차량은 운전석 참가자로 들어가 참가자 토큰을 받는다(발화 올리기·기록본·장면의 인증).
    const p = await api("POST", `/${t.code}/participants`, { seat: "ROW_1_LEFT", name, consent: true });
    car = { code: t.code, id: p.id, token: p.token, seq: 0 };
    save();
    speak("여행을 만들었어요. 폰에서 참가해 주세요");
  } catch (e) {
    els.setupErr.textContent = `여행을 만들지 못했어요 · ${plain(e)}`;
  }
  busy = false;
  await refresh(true);
}

function newTrip() {
  car = null;
  trip = null;
  lines = [];
  lineSig = "";
  navi = null;
  said = "";
  loadErr = "";
  save();
  render();
}

// 수락: accepted → (내비가 경유지를 받았다는 흉내) → reflected. 못 받으면 부탁을 보관(held)으로 되돌린다(Asks.kt·MainActivity.accept).
async function accept(r) {
  await setRequest(r.id, "accepted");
  navi = { id: r.id, stage: "adding" };
  speak(`${STOP}를 경유지로 추가하고 있어요`);
  render();
  await sleep(NAVI_MS);
  try {
    await setRequest(r.id, "reflected");
  } catch (e) {
    result(r.id, "failed");
    speak("경유지를 추가하지 못했어요. 부탁은 보관했어요");
    await setRequest(r.id, "held").catch(() => {}); // 그사이 폰에서 취소됐으면 되돌릴 것이 없다
    throw e;
  }
  result(r.id, "added");
  speak(`${STOP}를 경유지로 추가했어요`);
}

// 경유지 결과는 잠시 보이고 닫는다(MainActivity.finish)
function result(id, stage) {
  const shown = { id, stage };
  navi = shown;
  setTimeout(() => navi === shown && ((navi = null), render()), RESULT_MS);
}

async function later(r) {
  await setRequest(r.id, "held");
  speak("부탁은 보관해 둘게요");
}

// 받아 적은 말 한 줄을 올린다. 차량은 주행 중 기록할 때만 듣는다. 동의가 모자라면 서버가 판정한다(403).
async function say(text, seat) {
  els.sttErr.textContent = "";
  text = text.trim();
  if (!text || !trip) return;
  if (trip.status !== "driving") return void (els.sttErr.textContent = "출발한 뒤에 받아 적어요. 차량은 주행 중 기록할 때만 들어요.");
  if (!trip.recording && everyone()) return void (els.sttErr.textContent = "기록을 일시정지했어요. ‘기록 다시 시작’을 누르면 받아 적어요.");
  await act(async () => {
    // 같은 브라우저의 다른 탭도 이 차량으로 올린다. 저장소의 순번을 먼저 맞춰 같은 순번이 멱등 키에 걸려 버려지지 않게.
    const stored = load();
    if (stored?.code === car.code) car.seq = Math.max(car.seq, stored.seq ?? 0);
    const seq = car.seq + 1;
    const generation = trip.generation ?? 1;
    let r;
    try {
      r = await api("POST", path("/utterances"), { device: DEVICE, generation, items: [{ seq, at: Date.now(), text, seatArea: seat || null, generation }] }, true);
    } catch (e) {
      // 닿지 않았으면 서버가 받았을 수도 있다. 같은 순번을 다시 쓰면 새 말이 멱등 키에 걸려 버려지므로 넘긴다.
      if (e.status === 0) ((car.seq = seq), save());
      throw e;
    }
    car.seq = Math.max(seq, r.lastSeq);
    save();
    if (r.generation !== generation) throw new Error("그사이 누군가 동의를 바꿔 이 말은 저장하지 않았어요");
    if (els.sttText.value.trim() === text) els.sttText.value = "";
    await heard(text, seat);
  }, (m) => (els.sttErr.textContent = m));
}

// 들은 말에 차량 앱이 하는 일(MainActivity.heard): 열린 제안에 대한 답, 쉬어 가자는 부탁 순서로 본다.
async function heard(text, seat) {
  const offer = trip.requests.find((r) => r.status === "proposed");
  const answer = answerOf(text);
  if (offer && answer) {
    if (answer === "no") return later(offer);
    if (seat && !seat.startsWith("ROW_1")) return speak("뒷줄의 대답으로는 경로를 바꾸지 않아요");
    return accept(offer);
  }
  if (isRest(text)) {
    // 누가 말했는지는 아직 모른다. 차량 앱처럼 운전석 참가자(이 차량)의 부탁으로 남긴다.
    const r = await api("POST", path("/requests"), { by: car.id, text, when: "now" });
    await setRequest(r.id, "proposed");
    speak(`${STOP}에 들를까요?`);
  }
}

// Asks.kt의 낱말 규칙을 옮긴 것(isRestRequest, answerOf)
const NO_WORDS = new Set(["아니", "아니야", "아니요", "아뇨", "나중에", "괜찮아", "괜찮아요", "싫어", "됐어"]);
const YES_WORDS = new Set(["응", "그래", "그래요", "좋아", "좋아요", "가자", "들르자", "들렀다"]);
const isRest = (text) => ["화장실", "쉬었다가", "쉬어가", "배고파"].some((w) => text.replace(/[^가-힣A-Za-z0-9]/g, "").includes(w));
function answerOf(text) {
  const words = text.split(/[^가-힣A-Za-z0-9]+/);
  if (words.some((w) => NO_WORDS.has(w)) || /안 ?(가|들러)/.test(text)) return "no";
  if (words.some((w) => YES_WORDS.has(w))) return "yes";
  return "";
}

// ---- 읽기 ----

let polling = false;
async function refresh(force = false) {
  if (polling && !force) return;
  polling = true;
  try {
    if (!car) return render();
    let changed = force;
    try {
      const next = await api("GET", `/${car.code}${trip && !force ? `?v=${trip.version}` : ""}`);
      if (next) ((trip = next), (changed = true));
    } catch (e) {
      if (e.status === 404 || e.status === 400) {
        // 지난 여행이 없어졌다(48시간). 새로 만들게 처음 화면으로.
        const why = plain(e);
        newTrip();
        els.setupErr.textContent = `지난 여행을 이어 가지 못했어요 · ${why}`;
        return;
      }
      if (!trip) loadErr = plain(e); // 처음부터 못 불러왔으면 이유와 새 여행 단추를 보인다
      changed = true; // 연결 표시만 바꾼다
    }
    if (await loadLines()) changed = true;
    if (changed) render();
  } finally {
    polling = false;
  }
}

// 기록본(GET /transcript). 차량이 동의한 참가자라 읽을 수 있다. 바뀐 것이 없으면 다시 그리지 않는다.
async function loadLines() {
  if (!trip || !me()?.consent) return false;
  try {
    const t = await api("GET", path("/transcript"), null, true);
    const sig = `${t.generation}|${t.utterances.map((u) => `${u.device}:${u.seq}`).join(",")}`;
    if (sig === lineSig) return false;
    lineSig = sig;
    lines = t.utterances;
    return true;
  } catch {
    return false;
  }
}

// ---- 그리기 ----

const button = (label, onclick, className = "") => h("button", { type: "button", className, onclick, disabled: busy }, label);
const card = (...kids) => h("section", { className: "card" }, kids);
const hm = (ms) => new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

function joinCard() {
  const url = `${location.origin}/#${trip.code}`;
  const copy = () => navigator.clipboard?.writeText(url).then(() => toast("폰 주소를 복사했어요."), () => toast(url));
  return card(
    h("div", { className: "between" }, h("h3", {}, trip.title || "가치타 여행"), h("span", { className: "pill" }, `일행 ${trip.participants.length}명`)),
    h("p", { className: "code", title: "여행 코드" }, trip.code),
    h("p", { className: "sub" }, "폰에서 이 주소를 열어 자리를 고르고 기록에 동의해요."),
    h("p", { className: "link" }, h("a", { href: url, target: "_blank", rel: "noopener" }, url)),
    h("div", { className: "row" }, button("주소 복사", copy)),
  );
}

function recordCard() {
  const s = trip.status;
  const who = waiting();
  const [big, sub, rec] = trip.recording
    ? ["● 기록 중", "동의를 끄면 바로 멈춰요", true]
    : s === "driving" && everyone() ? ["기록을 일시정지했어요", "‘기록 다시 시작’을 누르면 다시 기록해요"]
    : s === "driving" ? ["기록 꺼짐", `모두 동의하면 다시 기록할 수 있어요 · ${who.join(", ")} 님 동의 대기`]
    : s === "boarding" ? ["기록 꺼짐", everyone() ? "출발하면 기록을 시작해요" : `${who.join(", ")} 님이 동의하면 출발과 함께 기록해요`]
    : s === "parked" ? ["여행 기록을 마쳤어요", "다시 출발하면 이어서 기록해요"]
    : ["여행을 마쳤어요", "기록본은 여행을 만든 뒤 48시간까지 볼 수 있어요"];
  return card(
    h("div", { className: "between" }, h("span", { className: "pill" }, STATUS[s]), h("span", { className: "pill sim" }, "음성 안내는 시연(실제는 차량 TTS)")),
    h("p", { className: `big${rec ? " rec" : ""}` }, big),
    h("p", { className: "sub" }, sub),
    said && h("p", { className: "speak" }, said),
  );
}

// 경유지 제안 카드(MainActivity.OfferCard). 한 번에 한 건.
function offerCard() {
  const by = Object.fromEntries(trip.participants.map((p) => [p.id, p.name]));
  const pill = h("span", { className: "pill sim" }, "경유지 반영은 시연(실제는 Pleos 내비)");
  const next = trip.requests.find((x) => x.status === "proposed");
  if (navi && (navi.stage === "adding" || !next)) {
    const r = trip.requests.find((x) => x.id === navi.id);
    const [title, sub] =
      navi.stage === "adding" ? ["내비에 경유지를 추가하고 있어요", `${STOP} · 시연 경로(서울 → 강릉)`]
      : navi.stage === "added" ? ["경유지를 추가했어요", `${STOP} · 부탁 “${r?.text ?? ""}”`]
      : ["경유지를 추가하지 못했어요", "부탁은 보관했어요"];
    return h("section", { className: "card offer" }, pill, h("h3", {}, title), h("p", { className: "sub" }, sub));
  }
  const r = next;
  if (!r) return null;
  return h(
    "section",
    { className: "card offer" },
    pill,
    h("h3", {}, `${STOP}에 들를까요?`),
    h("p", { className: "sub" }, `부탁 “${r.text}” · ${by[r.by] ?? "떠난 사람"}`),
    h("div", { className: "row" }, button("경유지로 추가", () => act(() => accept(r)), "primary"), button("나중에", () => act(() => later(r)))),
  );
}

function transcriptCard() {
  if (!me()?.consent) return card(h("h3", {}, "받아 적은 말"), h("p", { className: "sub" }, "기록에 동의한 참가자만 기록본을 볼 수 있어요."));
  return card(
    h("div", { className: "between" }, h("h3", {}, `받아 적은 말 ${lines.length}건`), h("span", { className: "pill" }, "서버 기록본")),
    h("p", { className: "meta" }, "실제 차량은 주행 중에 최근 두 줄만 보여요. 여기서는 시연을 위해 기록본 전체를 최신순으로 보여요."),
    lines.length
      ? h("ul", { className: "list" }, [...lines].reverse().map((u) => h("li", {}, h("span", { className: "meta" }, `${hm(u.at)} · ${SEAT[u.seatArea] ?? "자리 모름"}`), h("span", {}, u.text))))
      : h("p", { className: "sub" }, "아직 받아 적은 말이 없어요"),
  );
}

function peopleCard() {
  return card(
    h("h3", {}, `일행 ${trip.participants.length}명`),
    h(
      "ul",
      { className: "list" },
      trip.participants.map((p) =>
        h(
          "li",
          {},
          h("div", { className: "between" }, h("span", { className: "what" }, `${p.name} · ${SEAT[p.seat] ?? p.seat}${p.id === car.id ? " (이 차량)" : ""}`), h("span", { className: `pill${p.consent ? " ok" : ""}` }, p.consent ? "동의" : "동의 안 함")),
        ),
      ),
    ),
    trip.participants.length < 2 && h("p", { className: "sub" }, "오른쪽 폰 화면에서 일행이 참가하면 여기에 나와요."),
  );
}

function opsCard() {
  const s = trip.status;
  const patch = (body) => () =>
    act(async () => {
      const was = trip.recording;
      const t = await api("PATCH", path(), body);
      speak(t.status === "parked" ? "여행 기록을 마쳤어요" : t.status === "ended" ? "여행을 마쳤어요" : t.recording && !was ? "기록을 시작했어요" : !t.recording && was ? "기록을 멈췄어요" : t.status === "driving" ? "출발해요" : said);
    });
  const all = everyone();
  const buttons =
    s === "boarding" ? [button("출발", patch({ status: "driving" }), "primary")]
    : s === "driving" ? [button("도착했어요 · 주차", patch({ status: "parked" }), "primary"), Object.assign(button(trip.recording ? "기록 일시정지" : "기록 다시 시작", patch({ recording: !trip.recording })), { disabled: busy || (!trip.recording && !all) })]
    : s === "parked" ? [button("다시 출발", patch({ status: "driving" }), "primary"), button("여행 끝", patch({ status: "ended" }))]
    : [];
  const open = trip.requests.filter((r) => ["held", "proposed", "accepted"].includes(r.status)).length;
  const done = trip.requests.filter((r) => r.status === "done" || r.status === "reflected").length;
  return card(
    h("div", { className: "between" }, h("h3", {}, "운행"), h("span", { className: "pill" }, `기어 ${s === "driving" ? "D" : "P"} · 시연`)),
    s === "boarding" && h("p", { className: "sub" }, all ? "출발하면 기록을 켜요." : "모두 동의하지 않아도 출발할 수 있지만 기록은 꺼진 채로 가요."),
    (s === "parked" || s === "ended") && h("p", { className: "sub" }, `부탁 ${trip.requests.length}건 · 들렀거나 마친 것 ${done}건 · 남은 것 ${open}건. 클립과 주행 기억 지도는 아직 준비 전이에요.`),
    buttons.length > 0 && h("div", { className: "row" }, buttons),
  );
}

function requestsCard() {
  const by = Object.fromEntries(trip.participants.map((p) => [p.id, p.name]));
  const held = trip.requests.filter((r) => r.status === "held").length;
  const sorted = [...trip.requests].sort((a, b) => CLOSED.includes(a.status) - CLOSED.includes(b.status));
  const actions = (r) => {
    const go = (label, status, className) => button(label, () => act(() => setRequest(r.id, status)), className);
    const adding = navi?.id === r.id && navi.stage === "adding";
    return [
      r.status === "held" && go("경유지로 제안", "proposed"),
      r.status === "held" && go("완료", "done"),
      r.status === "proposed" && button("경유지로 추가", () => act(() => accept(r))),
      r.status === "proposed" && button("나중에", () => act(() => later(r))),
      r.status === "accepted" && !adding && go("경유지 반영 확인(시연)", "reflected"),
      r.status === "accepted" && !adding && go("반영 못 함 · 보관", "held"),
      r.status === "reflected" && go("완료", "done"),
      !CLOSED.includes(r.status) && !adding && go("취소", "cancelled", "plain"),
    ].filter(Boolean);
  };
  return card(
    h("div", { className: "between" }, h("h3", {}, held ? `보관한 부탁 ${held}건` : "보관한 부탁이 없어요"), h("span", { className: "pill" }, `전체 ${trip.requests.length}건`)),
    trip.requests.length
      ? h(
          "ul",
          { className: "list" },
          sorted.map((r) => {
            const acts = actions(r);
            return h(
              "li",
              { className: CLOSED.includes(r.status) ? "closed" : "" },
              h("div", { className: "between" }, h("span", { className: "what" }, r.text), h("span", { className: `pill${r.status === "reflected" || r.status === "done" ? " ok" : ""}` }, REQ[r.status][0])),
              h("p", { className: "meta" }, `${by[r.by] ?? "떠난 사람"} · ${WHEN[r.when] ?? r.when}`),
              acts.length > 0 && h("div", { className: "row" }, acts),
            );
          }),
        )
      : h("p", { className: "sub" }, "폰에서 ‘부탁 남기기’를 누르거나, 받아쓰기 시연에서 “화장실 가고 싶어”를 보내 보세요."),
  );
}

function momentCard() {
  const add = () =>
    act(async () => {
      // 차량의 참가자 토큰으로 남긴다. 위치는 시연이라 넣지 않는다(위치 없는 장면, ADR-0007).
      await api("POST", path("/moments"), { label: `장면 ${trip.moments.length + 1}` }, true);
      toast("장면을 남겼어요.");
    });
  return card(
    h("div", { className: "between" }, h("h3", {}, trip.moments.length ? `남긴 장면 ${trip.moments.length}개` : "장면 남기기"), button("장면 남기기", add)),
    h("p", { className: "meta" }, "지금 시각을 장면으로 남겨요. 위치는 시연이라 남기지 않아요."),
    trip.moments.length > 0 && h("ul", { className: "list" }, trip.moments.slice(-3).reverse().map((m) => h("li", {}, h("span", {}, `${m.label || "이름 없는 장면"} · ${hm(m.at)}`)))),
  );
}

function connCard() {
  return card(
    h("p", { className: online ? "" : "err" }, online ? "서버에 연결됐어요" : "연결이 끊겼어요 · 마지막으로 확인한 정보예요"),
    h("p", { className: "meta" }, `여행 코드 ${trip.code} · 받아 적은 말을 올리는 기기 ${DEVICE}`),
    h("div", { className: "row" }, button("새 여행 만들기", newTrip, "plain")),
  );
}

function renderSystem() {
  const driving = trip?.status === "driving";
  els.speed.textContent = driving ? "80" : "0";
  for (const li of els.gears.children) li.classList.toggle("on", li.dataset.g === (driving ? "D" : "P"));
  const at = Object.fromEntries((trip?.participants ?? []).map((p) => [p.seat, p]));
  const pos = { ROW_1_LEFT: "s11", ROW_1_RIGHT: "s13", ROW_2_LEFT: "s21", ROW_2_CENTER: "s22", ROW_2_RIGHT: "s23" };
  els.seats.replaceChildren(...SEATS.map(([id, label]) => h("div", { className: `seat ${pos[id]}${at[id] ? " on" : ""}`, title: label }, at[id] ? at[id].name.slice(0, 3) : "")));
  els.net.textContent = online ? "통신 연결됨" : "연결이 끊겼어요";
  els.net.classList.toggle("off", !online);
}

let phoneCode = "";
function renderPhone() {
  const code = trip?.code ?? "";
  els.phone.hidden = !code;
  els.phoneOpen.hidden = !code;
  els.phoneEmpty.hidden = !!code;
  if (code && code !== phoneCode) {
    phoneCode = code;
    els.phone.src = `/#${code}`;
    els.phoneOpen.href = `/#${code}`;
  }
}

function renderStt() {
  const s = trip?.status;
  const who = trip ? waiting() : [];
  els.sttState.textContent = !trip ? ""
    : trip.recording ? "● 기록 중 · 대사를 누르면 받아 적어요"
    : s !== "driving" ? "출발한 뒤에 받아 적어요"
    : who.length ? `${who.join(", ")} 님이 동의하지 않아 서버가 받지 않아요(보내 보면 거절 이유가 나와요)`
    : "기록을 일시정지했어요";
  for (const b of els.stt.querySelectorAll("button")) b.disabled = busy || !trip || s === "ended";
}

function render() {
  const ready = Boolean(car && trip);
  els.setup.hidden = Boolean(car);
  els.tripwin.hidden = !car;
  $("setup-go").disabled = busy;
  if (car && !trip)
    els.left.replaceChildren(
      card(
        h("p", { className: "big" }, loadErr ? "여행을 불러오지 못했어요" : "여행을 불러오고 있어요"),
        loadErr && h("p", { className: "err" }, loadErr),
        h("div", { className: "row" }, button("새 여행 만들기", newTrip, "plain")),
      ),
    );
  if (ready) {
    els.left.replaceChildren(
      ...[trip.status === "boarding" && joinCard(), recordCard(), offerCard(), transcriptCard(), peopleCard(), trip.status !== "boarding" && joinCard()].filter(Boolean),
    );
    els.ops.replaceChildren(opsCard());
    els.right.replaceChildren(requestsCard(), momentCard(), connCard());
  } else {
    els.ops.replaceChildren();
    els.right.replaceChildren();
  }
  renderSystem();
  renderPhone();
  renderStt();
}

// ---- 화면 맞추기: 2560 × 1440 좌표를 보이는 칸에 맞게 줄인다 ----

function fit() {
  const col = els.fit.parentElement;
  const wide = matchMedia("(min-width: 1100px)").matches;
  const top = col.getBoundingClientRect().top + scrollY;
  const w = col.clientWidth - 12; // 테두리 그림자 자리
  const h = innerHeight - top - 24;
  // 좁은 화면에서도 누를 수 있게 0.3배 아래로는 줄이지 않고 가로로 밀어 본다(.car-col이 가로 스크롤)
  const s = Math.max(0.3, Math.min(w / 2560, wide ? Math.max(h, 280) / 1440 : Infinity));
  els.screen.style.setProperty("--s", String(s));
  els.fit.style.width = `${Math.floor(2560 * s)}px`;
  els.fit.style.height = `${Math.floor(1440 * s)}px`;
}

function tick() {
  els.clock.textContent = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// ---- 한 번만 하는 준비 ----

els.setup.addEventListener("submit", (e) => (e.preventDefault(), createTrip()));
els.sttSeat.append(h("option", { value: "" }, "모름"), ...SEATS.map(([id, label]) => h("option", { value: id }, label)));
els.sttLines.append(
  ...LINES.map(([who, seat, text]) =>
    h("button", { type: "button", title: `${who}(${SEAT[seat]})의 말로 받아 적기`, onclick: () => ((els.sttSeat.value = seat), say(text, seat)) }, h("small", {}, `${who} · ${SEAT[seat]}`), h("span", {}, text)),
  ),
);
els.stt.addEventListener("submit", (e) => (e.preventDefault(), say(els.sttText.value, els.sttSeat.value)));
addEventListener("resize", fit);
fit();
tick();
setInterval(tick, 10_000);
setInterval(refresh, POLL_MS); // 바뀐 것이 없으면 304. 기록본은 따로 읽어 바뀌었을 때만 다시 그린다
render();
refresh(true);
