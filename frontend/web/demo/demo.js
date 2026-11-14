// 가치타 웹 시연(/demo). Pleos 에뮬레이터의 차 화면을 브라우저에 다시 그리고, 실제 API로 여행 하나를 돌린다(T66, T82).
// 차 화면은 차량 앱(frontend/car, T83 #235)의 칸과 문구를 그대로 따른다: 머리 줄 알약, 왼쪽 무대(기록 상태 · 초점 칸 · 부탁/할 일),
// 오른쪽(좌석 지도 · 주차 중 도구 · 기록 동의). 칸의 크기는 고정이고 내용만 바뀐다.
// 차량 SDK에서만 되는 것(기어, 마이크·STT, TTS, 내비 경유지, 카메라)은 차 화면 밖 '확장 제어'에서 흉내 내고 '시연'이라고 적는다.
// 사용자가 쓴 글은 textContent로만 넣는다. 차량은 운전석 참가자로 들어가 참가자 토큰을 받고, 여행 코드·토큰·순번은 localStorage에 둔다.

import { SEATS, SEAT, api as request, h, toast } from "/shared.js";
import { createVehicleBoarding } from "/vehicle-boarding.js";

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
const TITLE = "가치타 가족 여행"; // 차량 앱의 여행 이름(MainActivity.TITLE)
const DRIVER = ["아빠", "ROW_1_LEFT"]; // 차가 넣는 사람. 시연은 운전석만 넣고 나머지는 차 QR을 휴대폰으로 스캔해 참여한다
const DEVICE = "car-web-demo";
const KEY = "gachita-demo";
const POLL_MS = 2000;
const NAVI_MS = 1500; // 내비가 경유지를 받았다는 알림을 기다리는 흉내(에뮬레이터 실측은 약 6초)
const RESULT_MS = 8000;
// 자리 순서의 캐릭터(차량 앱 Theme.kt SEAT_CHARS: 운전석부터 기본·캡모자·안경·여행·게임)
const CHAR = { ROW_1_LEFT: "basic", ROW_1_RIGHT: "cap", ROW_2_LEFT: "glasses", ROW_2_CENTER: "travel", ROW_2_RIGHT: "game" };
// 좌석 지도의 줄: 서버의 자리(SEATS)를 줄(ROW_n)로 묶고 줄 안은 왼쪽 → 가운데 → 오른쪽. 손으로 칸을 놓지 않는다.
// 차량 앱은 같은 칸을 Vehicle SDK의 좌석 영역에서 만들고, Pleos 에뮬레이터는 이 다섯(SEAT_OCCUPANCY 0x1·0x4·0x10·0x20·0x40)을 줬다(T83).
const SIDE = ["LEFT", "CENTER", "RIGHT"];
const ROWS = [...new Set(SEATS.map(([id]) => id.slice(0, 5)))].map((row) =>
  SEATS.map(([id]) => id).filter((id) => id.startsWith(row)).sort((a, b) => SIDE.indexOf(a.slice(6)) - SIDE.indexOf(b.slice(6))),
);

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"), fit: $("fit"), screen: $("screen"), mic: $("mic"), clock: $("clock"),
  stt: $("stt"), sttState: $("stt-state"), sttLines: $("stt-lines"), sttSeat: $("stt-seat"), sttText: $("stt-text"), sttErr: $("stt-err"),
  gearCtl: $("gear-ctl"), recCtl: $("rec-ctl"), endCtl: $("end-ctl"), said: $("said"), momentCtl: $("moment-ctl"), momentMeta: $("moment-meta"),
  phone: $("phone"), phoneEmpty: $("phone-empty"), phoneOpen: $("phone-open"), phoneClock: $("phone-clock"),
};

let car = load(); // { code, id, token, seq } — 이 차량(운전석 참가자)
let trip = null; // 서버의 여행 문서
let lines = []; // 기록본의 발화
let lineSig = "";
let online = true;
let busy = false;
let navi = null; // { id, stage: "adding" | "added" | "failed" } 경유지 반영 흉내
let loadErr = "";
let ride = null; // 이전 화면 상태와 호환하며 새 참여는 vehicleBoarding을 사용합니다.
let rideNote = "";
let short = null; // 숏폼 무대: { title, scenes, at, pos }
let tab = "ride";
let managing = false;
let chat = false; // 대화록을 대화방으로 연 상태(주차 중, 왼쪽 무대 전체)
let note = ""; // 도구 줄 알림(차량 앱의 rideNote·shortNote 자리)
let setupErr = "";
const vehicleBoarding = createVehicleBoarding({ getTrip: () => trip, getToken: () => car?.token, onNotice: toast });

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

const speak = (line) => (els.said.textContent = line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- API ----

// 이 여행의 경로(/api/trips…). auth면 차량의 참가자 토큰을 보낸다. 서버에 닿았는지는 연결 알약에 쓴다.
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
    : e.status === 404 && m.includes("동승 연결") ? "QR이 만료됐거나 없어요. 차에서 새 QR을 열어 주세요."
    : e.status === 404 ? "여행이 지워졌거나 연결한 주소를 찾을 수 없어요."
    : e.status === 409 && m.includes("동의하지 않은") ? "동의하지 않은 탑승자가 있어 기록을 켤 수 없어요."
    : e.status === 409 && m.includes("주행 중에만") ? "주행 중에만 기록할 수 있어요."
    : e.status === 409 && m.includes("이미 사용한") ? "이미 쓴 QR이에요. 차에서 새 QR을 열어 주세요."
    : e.status === 409 && m.includes("주차 중에만") ? "주차 중에만 동승자를 연결할 수 있어요."
    : e.status === 409 && m.includes("이미 참가한") ? "그 폰은 이미 이 여행에 있어요."
    : e.status === 409 && m.includes("자리") ? "그 자리에는 이미 다른 사람이 앉아 있어요."
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
const driving = () => trip?.status === "driving";
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
  setupErr = "";
  busy = true;
  render();
  try {
    const t = await api("POST", "", { title: TITLE });
    // 차량은 운전석 참가자로 들어가 참가자 토큰을 받는다(발화 올리기·기록본·장면의 인증).
    const p = await api("POST", `/${t.code}/participants`, { seat: DRIVER[1], name: DRIVER[0], consent: true });
    car = { code: t.code, id: p.id, token: p.token, seq: 0 };
    save();
    speak("여행을 만들었어요. 차의 참석 QR을 휴대폰 카메라로 스캔해 주세요");
  } catch (e) {
    setupErr = `여행을 만들지 못했어요 · ${plain(e)}`;
  }
  busy = false;
  await refresh(true);
}

function newTrip() {
  tab = "ride"; managing = false;
  car = null;
  trip = null;
  lines = [];
  lineSig = "";
  navi = null;
  ride = null;
  short = null;
  note = rideNote = loadErr = "";
  speak("아직 안내가 없어요");
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
  render();
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
  if (!driving()) return void (els.sttErr.textContent = "출발한 뒤에 받아 적어요. 차량은 주행 중 기록할 때만 들어요.");
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

// 차에 참석 QR을 표시하고 동승자는 실제 휴대폰 카메라로 URL을 엽니다.
const scan = () => vehicleBoarding.open();

// 숏폼(T43): 차와 같은 GET /shortform(차의 참가자 토큰). 시연은 자막만 장면 길이대로 넘기고 소리는 틀지 않는다(차에서 원음으로 들려줌).
async function showShort() {
  short = null;
  note = "숏폼을 받고 있어요";
  await act(async () => {
    const s = await api("GET", path("/shortform"), null, true);
    note = s.scenes?.length ? "" : "아직 숏폼으로 만들 장면이 없어요";
    if (s.scenes?.length) ((short = { title: s.title, scenes: s.scenes, cast: s.cast ?? [], at: 0, pos: 0 }), playShort());
  }, (m) => (note = m));
}
let shortTimer;
function playShort() {
  clearInterval(shortTimer);
  shortTimer = setInterval(() => {
    if (!short) return clearInterval(shortTimer);
    short.pos += 0.25;
    if (short.pos >= short.scenes[short.at].seconds) ((short.at += 1), (short.pos = 0));
    if (short.at >= short.scenes.length) ((short = null), clearInterval(shortTimer));
    render();
  }, 250);
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
        // 서버에서 여행을 찾을 수 없으면 새로 만들게 처음 화면으로.
        const why = plain(e);
        newTrip();
        setupErr = `지난 여행을 이어 가지 못했어요 · ${why}`;
        return render();
      }
      if (!trip) loadErr = plain(e);
      changed = true; // 연결 알약만 바꾼다
    }
    if (driving()) { tab = "ride"; managing = false; }
    if (driving() && (ride || short || chat)) ((ride = null), (short = null), (chat = false)); // 주행 중에는 무대를 닫는다(T11)
    if (await loadLines()) changed = true;
    if (changed) render();
  } finally {
    polling = false;
  }
}

// 기록본(GET /transcript). 차량이 동의한 참가자라 읽을 수 있다. 바뀐 것이 없으면 다시 그리지 않는다.
async function loadLines() {
  if (!trip || !me()?.consent) {
    const changed = lines.length > 0 || short !== null;
    lines = []; lineSig = ""; short = null;
    return changed;
  }
  try {
    const t = await api("GET", path("/transcript"), null, true);
    const sig = `${t.generation}|${t.utterances.map((u) => `${u.device}:${u.seq}:${u.version ?? 0}:${u.text}`).join(",")}`;
    if (sig === lineSig) return false;
    if (lineSig && lineSig.split("|")[0] !== String(t.generation)) short = null;
    lineSig = sig;
    lines = t.utterances;
    return true;
  } catch {
    // 권한 철회·만료·연결 실패 때 이전 자막과 쇼츠를 남기지 않는다.
    const changed = lines.length > 0 || short !== null;
    lines = []; lineSig = ""; short = null;
    return changed;
  }
}

// ---- 차 화면 그리기(frontend/car MainActivity.kt T83의 칸과 문구) ----

const div = (className, ...kids) => h("div", { className }, kids.flat(Infinity)); // h()는 한 겹만 편다
const text = (className, s) => h("p", { className }, s);
const btn = (label, onclick, className = "") => h("button", { type: "button", className, onclick, disabled: busy }, label);
const card = (cls, ...kids) => h("section", { className: `card ${cls}` }, kids.flat(Infinity));
const hm = (ms) => new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const char = (seat, cls = "") => h("img", { className: `char ${cls}`, src: `/chars/${CHAR[seat] ?? "basic"}.png`, alt: "" });
const pill = (label, ok = true) => h("span", { className: `pill${ok ? "" : " bad"}` }, h("i"), label);

// 가치타 마스코트(차량 앱 Theme.kt Mascot과 같은 64 좌표). 듣는 중은 눈을 뜨고 민트 점, 멈춤은 눈을 감는다.
function mascot(listening) {
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, a) => Object.entries(a).reduce((e, [k, v]) => (e.setAttribute(k, v), e), document.createElementNS(ns, tag));
  const svg = el("svg", { viewBox: "0 0 64 64", class: "mascot", "aria-hidden": "true" });
  svg.append(el("path", { d: "M14 22C14 16.5 18.5 12 24 12H40C45.5 12 50 16.5 50 22V24H54C56.2 24 58 25.8 58 28V44C58 48.4 54.4 52 50 52H14C9.6 52 6 48.4 6 44V28C6 25.8 7.8 24 10 24H14Z", fill: "#fff", stroke: "#28221B", "stroke-width": "3", "stroke-linejoin": "round" }));
  if (listening) {
    svg.append(el("circle", { cx: "24.5", cy: "36", r: "2.8", fill: "#28221B" }), el("circle", { cx: "39.5", cy: "36", r: "2.8", fill: "#28221B" }));
    svg.append(el("path", { d: "M28.5 42.5Q32 45.5 35.5 42.5", fill: "none", stroke: "#28221B", "stroke-width": "2.4", "stroke-linecap": "round" }));
    svg.append(el("circle", { cx: "52", cy: "12", r: "6", fill: "#60C090" }));
  } else for (const x of [24, 40]) svg.append(el("path", { d: `M${x - 4} 36Q${x} 39 ${x + 4} 36`, fill: "none", stroke: "#28221B", "stroke-width": "2.6", "stroke-linecap": "round" }));
  return svg;
}

function appBar(title, listening, ...pills) {
  return div("appbar", div("mascot-box", mascot(listening)), div("brand", h("b", {}, "가치타"), h("span", { className: "title" }, title)), ...pills);
}

// 여행 만들기(C6). 시연은 운전석만 차가 넣고 동승자는 차의 QR을 스캔해 들어온다(서버 주소 칸 없음).
function setupScreen() {
  return div(
    "setup",
    appBar(TITLE, false, pill("주차 중 · P")),
    h("h2", {}, "누구랑 같이 타나요?"),
    text("sub", "같이 타는 가족을 골라 주세요"),
    div("members", h("div", { className: "member on" }, char(DRIVER[1], "big"), h("b", {}, DRIVER[0]), text("sub", "운전석"), text("mint", "✓ 같이 타요"))),
    h("span", { className: "grow" }),
    text("err", setupErr),
    btn(busy ? "여행을 만들고 있어요" : "1명으로 여행 만들기", createTrip, "primary make"),
  );
}

function status() {
  const s = trip.status;
  return trip.recording ? ["● 기록 중", "동의를 끄면 바로 멈춰요", "rec"]
    : s === "driving" && everyone() ? ["기록 멈춤", "동의는 그대로예요 · 확장 제어에서 다시 시작해요", "wait"]
    : s === "boarding" && everyone() ? ["기록 대기", "출발하면 기록을 시작해요", "wait"]
    : s === "parked" ? ["기록 꺼짐", "다시 출발하면 이어서 기록해요", ""]
    : s === "ended" ? ["기록 꺼짐", "여행을 마쳤어요 · 남긴 기록을 다시 볼 수 있어요", ""]
    : ["기록 꺼짐", trip.participants.some((p) => p.consent) ? "모두 동의하면 다시 기록할 수 있어요" : "주차(P)한 뒤 대화 기록 동의를 켜면 기록해요", ""];
}

function statusHero() {
  const [big, sub, tone] = status();
  return card(`hero ${tone}`, text("big", big), text("sub", sub));
}

// 초점 칸: 제안 > 받아 적은 말. 한 번에 하나만, 크기는 그대로.
function focus() {
  const next = trip.requests.find((x) => x.status === "proposed");
  if (navi && (navi.stage === "adding" || !next)) {
    const [title, sub, cls] =
      navi.stage === "adding" ? ["내비에 경유지를 추가하고 있어요", STOP, ""]
      : navi.stage === "added" ? ["경유지를 추가했어요", `${STOP} · 부탁 1건`, "mint"]
      : ["경유지를 추가하지 못했어요", "부탁은 보관했어요", "red"];
    return card("focus accent", div("center", text(`h44 ${cls}`, title), text("sub30", sub)));
  }
  if (next)
    return card(
      "focus accent",
      text("h44", `${STOP}에 들를까요?`),
      text("sub", "부탁 1건"),
      h("span", { className: "grow" }),
      div("row2", btn("경유지로 추가", () => act(() => accept(next)), "primary xl"), btn("나중에", () => act(() => later(next)), "outline xl")),
    );
  const recent = lines.slice(-2).reverse();
  const empty = !me()?.consent ? text("sub", "기록에 동의한 참가자만 기록본을 볼 수 있어요") : !lines.length && text("sub", "아직 받아 적은 말이 없어요");
  return card("focus", div("head", h("b", {}, "방금 나눈 대화"), h("span", {}, `${lines.length}건`)), empty, div("lines", recent.map(line)));

}

const zone = (u) => u.seatArea && (u.seatArea.startsWith("ROW_1") ? "앞줄" : "뒷줄");
const line = (u) => div("line", h("i", { className: "who" }), div("", text("meta", [hm(u.at), zone(u)].filter(Boolean).join(" · ")), text("said", u.text)));
// 방 얼굴: 일행 캐릭터를 겹쳐 놓는다(넷까지)
const groupFace = () => div("group", trip.participants.slice(0, 4).map((p) => char(p.seat, "mini")));

// 대화방(주차 중, 왼쪽 무대 전체): 기록본 전체를 단체 대화방처럼. 웹 시연의 기록본에는 말한 사람이 없어(서버의 화자 대조 전) '누구?'와 자리 구역만.
function chatStage() {
  const box = h(
    "div",
    { className: "chatlist" },
    lines.map((u) => div("bubble-row", h("i", { className: "who" }), div("", text("name", ["누구?", zone(u)].filter(Boolean).join(" · ")), div("bubble-line", text("bubble", u.text), text("time", hm(u.at)))))),
  );
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight)); // 처음 열면 맨 아래(최신)부터
  return h(
    "section",
    { className: "chatstage" },
    div("chathead", btn("‹ 닫기", () => ((chat = false), (tab = "ride"), render()), "outline"), groupFace(), div("grow", h("b", {}, trip.title || "가족 여행"), text("sub", `${trip.participants.length}명 · 받아 적은 말 ${lines.length}건`))),
    box,
  );
}

function counts() {
  const held = trip.requests.filter((r) => r.status === "held").length;
  return div("overview-counts", text("sub", `보관한 부탁 ${held} · 도착 할 일 0`), !driving() && btn("여행 관리", () => { managing = true; render(); }, "text-button"));
}

function people() {
  const at = Object.fromEntries(trip.participants.map((p) => [p.seat, p]));
  const last = trip.recording && lines.at(-1)?.seatArea; // 방금 받아 적은 말의 좌석 구역(차량 앱 seatZone)
  return card(
    "people",
    div("head", h("b", {}, `일행 ${trip.participants.length}명`), h("span", {}, "차 앞쪽 ▲")),
    div(
      "seatmap-box",
      div(
        "seatmap",
        ROWS.map((row) =>
          div(
            `seatrow${last && row[0].slice(0, 5) === last.slice(0, 5) ? " zone" : ""}`,
            row.map((seat) => {
              const p = at[seat];
              if (!p) return div("seat", h("i", { className: "empty" }), text("name dim", "빈자리"));
              const [label, cls] = p.consent ? ["동의", "ok"] : ["동의 전", "dim"];
              return div("seat", char(seat), text("name", p.name), text(`note ${cls}`, label));
            }),
          ),
        ),
      ),
    ),
  );
}

// 주차 중 도구(C5): 차량 참석 QR·숏폼 보기, 여행 코드와 진단(알림이 있으면 그 자리에), 새 여행 만들기.
// 차량 앱의 '이 차에 둔 원음 지우기'는 웹에 차 원음이 없어 두지 않는다.
function tools() {
  return div("row2 ride-tools",
    btn("참석 QR", () => vehicleBoarding.open(), "tonal"),
    btn("동승자 설정", () => { managing = true; render(); }, "outline"));
}

function consent() {
  const on = !!me()?.consent;
  return card(
    "consent",
    div("", h("b", {}, "대화 기록 동의"), text("sub", driving() ? "끄기는 주행 중에도 한 번에 돼요" : "기본값은 꺼짐 · 주차 중에만 켤 수 있어요")),
    h("span", { className: `switch${on ? " on" : ""}`, role: "switch", "aria-checked": String(on), "aria-disabled": "true", title: "시연에서는 운전석 동의를 여행 만들 때 켜요" }, h("i")),
  );
}

// 숏폼 무대(T43·T83): 왼쪽 무대 전체에 릴스·쇼츠처럼. 진행 막대, 가운데 말하는 사람, 큰 자막, 오른쪽 세로 단추.
function shortStage() {
  const sc = short.scenes[short.at];
  const cue = sc.cues.findLast((c) => short.pos >= c.start) ?? sc.cues[0];
  const who = short.cast.find((c) => c.participantId === cue?.participantId);
  const seat = who?.seat;
  return h(
    "section",
    { className: "shortstage" },
    div("bars", short.scenes.map((s, i) => h("i", { style: `--f:${i < short.at ? 1 : i > short.at ? 0 : Math.min(1, short.pos / s.seconds)}` }))),
    text("scene", `${short.at + 1} / ${short.scenes.length} · ${sc.label}`),
    div("face", seat ? char(seat, "ring huge") : mascot(true)),
    div("cap", (who?.name || cue?.seatArea) && text("who", who?.name ?? SEAT[cue.seatArea]), text("line", cue?.text ?? ""), text("muted", "시연은 자막만 · 소리는 차에서 원래 목소리로")),
    div(
      "rail",
      btn("다음 장면", () => ((short.at += 1), (short.pos = 0), short.at >= short.scenes.length && (short = null), render()), "rail next"),
      btn("닫기", () => ((short = null), render()), "rail close"),
    ),
  );
}

function tripScreen() {
  const parked = !driving();
  const pills = [pill(parked ? "주차 중" : "주행 중"), pill(online ? "서버 연결됨" : "연결 대기", online)];
  const tabs = div("tabs", ...[["ride", "함께 타는 중"], ["chat", "대화 기록"], ["shorts", "쇼츠"]].map(([id, label]) => {
    const b = btn(label, () => { tab = id; managing = false; ride = null; short = null; render(); }, tab === id ? "selected" : "");
    b.disabled = busy || (!parked && id !== "ride"); return b;
  }));
  let body;
  if (parked && managing) body = card("manage", h("h3", {}, "여행 관리"), text("sub", `여행 코드 ${trip.code}`), btn("새 여행 만들기", newTrip, "outline"), btn("닫기", () => { managing = false; render(); }, "outline"));
  else if (parked && tab === "chat") body = chatStage();
  else if (parked && tab === "shorts") body = short ? shortStage() : card("manage", h("h3", {}, "쇼츠"), text("sub", note || "남긴 장면을 골라 자막 미리보기를 열어요"), btn("쇼츠 미리보기", showShort, "tonal"));
  else body = div("overview", statusHero(), div("overview-panels", people(), focus()), counts(), parked && tools());
  return div("trip", appBar("함께하는 여행", !!trip.recording, ...pills), tabs, div("trip-body", body), consent());

}

function loading() {
  return div("setup", appBar(TITLE, false), card("hero", text("big", loadErr ? "여행을 불러오지 못했어요" : "여행을 불러오고 있어요"), text("err", loadErr)), btn("새 여행 만들기", newTrip, "outline"));
}

// ---- 시스템 칸과 확장 제어 ----

function renderSystem() {
  const d = driving();
  els.screen.classList.toggle("driving", d);
  els.mic.hidden = !trip?.recording; // 기록 중이면 Pleos가 상태 줄에 마이크 표시를 띄운다(에뮬레이터 캡처)
}

function renderExt() {
  const s = trip?.status;
  const none = !trip || busy;
  for (const b of els.gearCtl.children) {
    b.disabled = none || s === "ended";
    b.classList.toggle("on", b.dataset.g === (s === "driving" ? "D" : "P"));
  }
  els.recCtl.textContent = trip?.recording ? "기록 일시정지" : "기록 다시 시작";
  els.recCtl.disabled = none || s !== "driving" || (!trip.recording && !everyone());
  els.endCtl.disabled = none || s !== "parked";
  $("scan-ctl").disabled = none || driving() || s === "ended";
  els.momentCtl.disabled = none;
  els.momentMeta.textContent = trip?.moments.length ? `남긴 장면 ${trip.moments.length}개 · 마지막 ${hm(trip.moments.at(-1).at)}` : "";
  const who = trip ? trip.participants.filter((p) => !p.consent).map((p) => p.name) : [];
  els.sttState.textContent = !trip ? "여행을 만들면 쓸 수 있어요"
    : trip.recording ? "● 기록 중 · 대사를 누르면 그 자리의 말로 받아 적어요(마이크는 쓰지 않음)"
    : s !== "driving" ? "출발(D)한 뒤에 받아 적어요"
    : who.length ? `${who.join(", ")} 님이 동의하지 않아 서버가 받지 않아요(보내 보면 거절 이유가 나와요)`
    : "기록을 일시정지했어요";
  for (const b of els.stt.querySelectorAll("button")) b.disabled = none || s === "ended";
}

let phoneCode = "";
function renderPhone() {
  const code = trip?.code ?? "";
  els.phone.hidden = !code;
  els.phoneOpen.hidden = !code;
  els.phoneEmpty.hidden = !!code;
  if (code && code !== phoneCode) {
    phoneCode = code;
    els.phone.src = "/"; // 실제 휴대폰은 차의 QR URL을 열어 같은 서버 여행에 참여합니다.
    els.phoneOpen.href = "/";
  }
}

function render() {
  vehicleBoarding.sync();
  els.app.replaceChildren(!car ? setupScreen() : !trip ? loading() : tripScreen());
  renderSystem();
  renderExt();
  renderPhone();
}

// ---- 화면 맞추기: 2560 × 1440 좌표를 보이는 칸에 맞게 줄인다 ----

function fit() {
  const col = els.fit.closest(".car-col");
  const wide = matchMedia("(min-width: 1100px)").matches;
  const top = els.fit.getBoundingClientRect().top + scrollY;
  const ext = document.querySelector(".ext").offsetHeight + 24;
  const w = wide ? innerWidth - 380 - 24 * 3 : document.querySelector(".stage").clientWidth - 48; // 넓으면 폰 칸 옆, 좁으면 한 줄
  const hgt = innerHeight - top - ext - 24;
  // 좁은 화면에서도 누를 수 있게 0.3배 아래로는 줄이지 않고 가로로 밀어 본다(.emu가 가로 스크롤)
  const s = Math.max(0.3, Math.min(w / 2560, wide ? Math.max(hgt, 280) / 1440 : Infinity));
  els.screen.style.setProperty("--s", String(s));
  els.fit.style.width = `${Math.floor(2560 * s)}px`;
  els.fit.style.height = `${Math.floor(1440 * s)}px`;
  col.style.width = wide ? `${Math.floor(2560 * s)}px` : ""; // 확장 제어도 차 화면 너비에 맞춘다
  if (!wide) els.fit.closest(".emu").scrollLeft = Math.round(854 * s);
}

function tick() {
  const now = new Date();
  els.clock.textContent = now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: true }).replace(/^(오전|오후) (.*)$/, "$2 $1");
  els.phoneClock.textContent = now.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit", hour12: false });
}

// ---- 한 번만 하는 준비 ----

const patch = (body) =>
  act(async () => {
    const was = trip.recording;
    const t = await api("PATCH", path(), body);
    speak(t.status === "parked" ? "여행 기록을 마쳤어요" : t.status === "ended" ? "여행을 마쳤어요" : t.recording && !was ? "기록을 시작했어요" : !t.recording && was ? "기록을 멈췄어요" : t.status === "driving" ? "출발해요" : els.said.textContent);
  });
els.gearCtl.addEventListener("click", (e) => {
  const g = e.target.closest("button")?.dataset.g;
  if (g && trip) patch({ status: g === "D" ? "driving" : "parked" });
});
els.recCtl.addEventListener("click", () => patch({ recording: !trip.recording }));
els.endCtl.addEventListener("click", () => patch({ status: "ended" }));
els.momentCtl.addEventListener("click", () =>
  act(async () => {
    // 차량의 참가자 토큰으로 남긴다. 위치는 시연이라 넣지 않는다(위치 없는 장면, ADR-0007).
    await api("POST", path("/moments"), { label: `장면 ${trip.moments.length + 1}` }, true);
    toast("장면을 남겼어요.");
  }),
);
els.sttSeat.append(h("option", { value: "" }, "자리 모름"), ...SEATS.map(([id, label]) => h("option", { value: id }, label)));
els.sttLines.append(
  ...LINES.map(([who, seat, line]) =>
    h("button", { type: "button", title: `${who}(${SEAT[seat]})의 말로 받아 적기`, onclick: () => ((els.sttSeat.value = seat), say(line, seat)) }, h("small", {}, `${who} · ${SEAT[seat]}`), h("span", {}, line)),
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

$("scan-ctl").onclick = () => { if (trip && !driving() && !busy) scan(); };
