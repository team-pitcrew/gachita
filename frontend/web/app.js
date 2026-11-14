import { mediaButton, setMediaButton, audioPeaks, drawWaveform } from "/media-controls.js";
// 가치타 모바일 화면(gachita.mangowhois.ai). 빌드 없이 브라우저가 그대로 읽는다.
// 주소: /#코드는 이 폰이 들어간 여행, /#me는 내 프로필. 여행에는 차가 표시한 참석 QR을 이 폰의 카메라로 읽어 참여한다.
// 이 폰이 누구인지(프로필 토큰, 여행마다 참가자 id와 토큰)는 localStorage에 둔다. 폰에서는 수음하지 않는다. 차가 표시한 참석 QR을 폰 카메라로 읽어 참여한다.
// 사용자가 쓴 글은 textContent로만 넣는다(innerHTML 금지).

import { SEATS, SEAT, WHEN, REQ, CLOSED, api, h, toast } from "/shared.js";
import { createShares, shareIconButton } from "/shares.js";
import { createCaptions } from "/captions.js";
import { createRecords } from "/records.js";
import { createConversations } from "/conversations.js";
import { createTodos } from "/todos.js";
import { CHARACTER_OPTIONS, characterKey, characterImage, createShortFilm, exportShortFilm, recordingFormat } from "/short-film.js";
import { createShortStudio } from "/short-studio.js";
import { createScenePicker } from "/short-scenes.js";
import { createBoarding } from "/boarding.js";
import { createOnboarding } from "/onboarding.js";
import { appBar, arrivalCards, askState, createPlaces, driveState, journeyTabs, nearCard, recordingLine, rideHeading, seatMap, statusMoves } from "/ride.js";

// 여행 상태 이름. 상태별 제목·부제·운전석 단추는 ride.js가 고른다.
const TRIP = { boarding: "탑승 중", driving: "주행 중", parked: "주차 완료", ended: "여행 종료" };
const ONLY_HERE = "이 폰에서 연결한 사람만 켤 수 있어요.";
// 켜져 있던 동의를 끄면 서버가 동의 세대를 올려 그 여행의 받아 적은 글과 클립을 모두 지운다(ADR-0007). 누르기 전에 알린다.
const OFF_WIPES = "동의를 끄면 기록이 멈추고, 이 여행에서 지금까지 받아 적은 글과 올라간 소리가 모두 지워져요. 끌까요?";
// 기록 동의 문구. docs/api/voice.md '동의 문구'(api-media가 #183에서 고침)와 글자까지 같게 둔다(#156, 11/14).
// 앱이 실제로 하는 것만 적는다: 외부 음성 인식으로 보내는 것, 지울 수 있는 것, 동의를 끄면 지워지는 것.
const CONSENT = [
  "대화는 차에서 받아 적힙니다.",
  "녹음은 기본 꺼져 있고, 참가자 모두가 동의할 때만 켭니다.",
  "받아 적은 글과 여행 기록은 기간 제한 없이 보관합니다. 기록 동의를 끄면 이 여행의 받아 적은 글과 서버에 올린 소리를 지웁니다.",
  "장면을 고를 수 있게 소리는 차 안에 암호화해 보관합니다. 차에서 원음을 직접 지우거나 기록 동의를 끄면 지웁니다.",
  "장면으로 남기면 그 구간의 소리가 서버로 올라갑니다.",
  "자막을 바로잡으려고 그 구간의 소리와 받아 적은 글, 참가자 이름을 외부 음성 인식 서버로 보내 다시 받아 적습니다.",
  // 화자 식별은 새 차량 앱이 차 안에서 한다(ADR-0023 8절의 전환기 글). 구버전 차량 앱과 웹 입력이 소리를 보내는 동안에는 가운데 문장을 빼지 않는다.
  "누가 말했는지는 차 안에서 가립니다.",
  "이전 버전의 차량 앱과 웹 입력에서는 이를 위해 말소리가 잠시 서버로 갔다가 저장되지 않고 지워집니다.",
  "등록한 목소리는 화자를 가리는 값으로만 바뀌어 서버에 저장되고, 동의를 끄면 지워집니다.",
  "프로필로 참가한 사람은 자기 이름이 붙은 글을, 참가자 누구나 장면으로 남긴 소리를 바로 지울 수 있습니다.",
  "동의는 여행 중 언제든 끌 수 있고, 끄면 이 여행에서 그때까지 받아 적은 글과 올라간 소리가 모두 지워집니다.",
];
// 원본 말랑 10유형 × 큰·작은 전신 2종. API에는 20자 이내의 기존 character 값으로 저장합니다.
const CHARACTERS = CHARACTER_OPTIONS;
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
// /#start는 계정·온보딩(T142). 여행 코드가 아니다.
const code = () => (location.hash === "#me" || location.hash === "#start" ? "" : location.hash.slice(1).toUpperCase());
// 이 폰이 기억하는 것. store(키)는 읽기, store(키, 값)은 쓰기, store(키, null)은 지우기.
const vehicleView = new URLSearchParams(location.search).get("vehicle-view") === "1";
const identityStorage = vehicleView ? sessionStorage : localStorage;
const identityPrefix = vehicleView ? "gachita:vehicle-view:" : "gachita:";
const store = (key, value) =>
  value === undefined ? identityStorage.getItem(`${identityPrefix}${key}`) : value === null ? identityStorage.removeItem(`${identityPrefix}${key}`) : identityStorage.setItem(`${identityPrefix}${key}`, value);
const myId = () => store(code());
const myToken = () => store(`${code()}:token`); // 참가자 토큰: 동의 켜기와 음성 경로의 인증(T68, ADR-0007)

let trip = null; // 서버에서 받은 여행
let profile = null; // 이 폰의 프로필(GET /api/profiles/me). 토큰은 store("profile")
let profileRead = null; // 같은 토큰의 중복 조회를 합칩니다.
let profileError = false;
let photo = ""; // 내 사진(object URL)
const pdraft = { name: "", character: "", photo: null, preview: "", consentDefault: false };
let failed = ""; // 여행을 불러오지 못한 이유
let offline = false;
let stale = false; // 입력 중에 온 변경은 입력이 끝난 뒤 그린다
let conversationPending = false;
let savingProfile = false;
let reading = false; // 여행 화면의 '동의 켜기': 켜기 전에 동의 문구 전문을 보이는 중
const shares = createShares({
  getProfile: () => profile,
  getProfileToken: () => store("profile"),
  getTrip: () => trip,
  getParticipant: () => trip?.participants.find((p) => p.id === myId()),
  getParticipantToken: () => myToken(),
  onProfile: () => (location.hash = "me"),
});

// 여행 경로는 토큰 없이, 프로필 경로(mine)는 이 폰의 프로필 토큰으로.
const call = (method, path, body) => api(method, `/trips${path}`, body);
const mine = (method, path, body) => api(method, path, body, store("profile"));
const captions = createCaptions({
  getTrip: () => trip,
  getParticipant: () => trip?.participants.find((p) => p.id === myId()),
  request: (code, method, path, body, signal) => {
    if (trip?.code !== code) return Promise.reject(new Error("여행이 바뀌었어요."));
    return asMe(trip.participants.find((p) => p.id === myId()), (c, token) => api(method, `/trips/${c}${path}`, body, token, signal));
  },
  refreshTrip: () => refresh(true),
});
const records = createRecords({
  getProfile: () => profile,
  getProfileToken: () => store("profile"),
  getTrip: () => trip,
  getParticipant: () => trip?.participants.find((p) => p.id === myId()),
  getParticipantToken: myToken,
  participantRequest: (method, path, body) => asMe(trip.participants.find((p) => p.id === myId()), (c, token) => api(method, `/trips/${c}${path}`, body, token)),
  onSaved: () => refresh(true),
  onProfile: () => (location.hash = "me"),
  onMoment: (id) => scenes.open({ momentId: id }),
  onConversation: () => conversations.open(),
});

const conversations = createConversations({
  getTrip: () => trip,
  getParticipant: () => trip?.participants.find((p) => p.id === myId()),
  getToken: myToken,
  request: (c, signal) => {
    if (trip?.code !== c) return Promise.reject(new Error("여행이 바뀌었어요."));
    return asMe(trip.participants.find((p) => p.id === myId()), (code, token) => api("GET", `/trips/${code}/transcript`, null, token, signal));
  },
  avatar: (person) => personAvatar(person),
  isOnline: () => !offline,
  onHome: () => { location.hash = ""; },
  onCaptions: () => captions.open(),
  onShorts: () => launchShort(),
  onScenes: () => scenes.open(),
});
const todos = createTodos({
  getTrip: () => trip,
  getParticipant: () => trip?.participants.find((p) => p.id === myId()),
  getToken: myToken,
  request: (method, path, body) => asMe(trip.participants.find((p) => p.id === myId()), (c, token) => api(method, `/trips/${c}${path}`, body, token)),
  onChange: () => { if (typing()) stale = true; else render(); },
});
// 장소 기록(#370)은 녹음에 동의한 참가자만 GET /places로 읽는다. 여행 문서의 places는 읽지 않는다.
const places = createPlaces({
  getTrip: () => trip,
  getParticipant: () => trip?.participants.find((p) => p.id === myId()),
  getToken: myToken,
  request: (method, path) => asMe(trip.participants.find((p) => p.id === myId()), (c, token) => api(method, `/trips/${c}${path}`, null, token)),
  onChange: () => { if (typing()) stale = true; else render(); },
});
const launchLocalShort = (momentId) => {
  const me = trip?.participants.find((p) => p.id === myId());
  if (me) openShort(me, momentId).catch((e) => toast(e.status === 0 ? "연결이 끊겨서 열지 못했어요." : e.message));
};
const studio = createShortStudio({ getTrip: () => trip, getParticipant: () => trip?.participants.find((p) => p.id === myId()), getToken: myToken,
  getOwner: () => profile?.id ? `profile:${profile.id}` : (() => { let id = store("short-owner"); if (!id) { id = crypto.randomUUID(); store("short-owner", id); } return `device:${id}`; })(), onLocal: launchLocalShort,
  onPick: (momentId) => scenes.open({ momentId }), onConnect: () => { if (trip && code()) { render(); } else if (profile) startRide(); else location.hash = "me"; } });
const scenes = createScenePicker({ getTrip: () => trip, getParticipant: () => trip?.participants.find((p) => p.id === myId()), getToken: myToken,
  onChoose: (momentId) => studio.open({ momentId }), onLocal: launchLocalShort, onCandidates: () => records.openScenes(), onCaptions: (options) => captions.open(options), onShare: (momentId) => shares.openCompose({ momentId }) });
const boarding = createBoarding({ getProfile: () => profile, getToken: () => store("profile"), consentText: CONSENT, consentOffMessage: OFF_WIPES,
  onProfile: () => { location.hash = "me"; },
  onLinked: ({ code, participant, token }) => { store(code, participant.id); store(`${code}:token`, token); store(`${code}:asked`, null); store("trip", code); },
  onDecision: ({ code }) => { store(`${code}:asked`, "1"); reading = false; },
  onLeave: ({ code: joinedCode }) => { store(`${joinedCode}:asked`, "1"); reading = false; if (code() === joinedCode) refresh(true); else location.hash = joinedCode; } });
// 계정·온보딩(T142, P01–P08). 프로필 토큰이 없는 첫 화면과 /#start에서 보인다. 동의 문구는 여행 기록 동의와 같은 CONSENT를 넘긴다(T138과 한 배열).
const onboarding = createOnboarding({
  getProfile: () => profile,
  getToken: () => store("profile"),
  setToken: (token) => store("profile", token),
  loadProfile,
  getPhoto: () => photo,
  consentText: CONSENT,
  render: () => render(),
  onBegin: () => { if (location.hash !== "#start") location.hash = "start"; },
  onDone: () => { location.hash = ""; },
  // mock: F2(가족 그룹, T133 #372)가 병합되면 그 입구로 잇는다. 그 전에는 처음 화면으로 간다.
  onFamily: () => { location.hash = ""; },
  onOther: () => { location.hash = "me"; },
  isOnline: () => !offline && navigator.onLine !== false,
});
const startRide = () => boarding.open();
const launchShort = () => studio.open();
const openConversations = () => {
  if (trip?.code === code()) return conversations.open();
  const last = store("trip");
  if (last) { conversationPending = true; location.hash = last; }
};

// 프로필 다시 읽기. 지워졌거나 모르는 토큰이면 이 폰에서도 잊는다.
function loadProfile() {
  const token = store("profile");
  if (profileRead?.token === token) return profileRead.promise;
  const read = { token };
  profileRead = read;
  read.promise = readProfile(token).finally(() => { if (profileRead === read) profileRead = null; });
  return read.promise;
}

async function readProfile(token) {
  profile = null;
  profileError = false;
  URL.revokeObjectURL(photo);
  photo = "";
  if (!token) return;
  try {
    const next = await api("GET", "/profiles/me", undefined, token);
    if (store("profile") !== token) return;
    profile = next;
  } catch (e) {
    if (store("profile") !== token) return;
    if (e.status === 401) store("profile", null); // 서버가 모르는 토큰일 때만 잊습니다.
    else profileError = true;
    return;
  }
  if (profile.hasPhoto) {
    const res = await fetch("/api/profiles/me/photo", { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    if (res?.ok) {
      const image = await res.blob();
      if (store("profile") === token) photo = URL.createObjectURL(image);
    }
  }
}

// 사진은 폰에서 다시 그려 올린다: 위치 같은 덧붙은 정보(EXIF)가 빠지고 1 MB 안으로 줄어든다.
async function shrink(file) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, 640 / Math.max(img.width, img.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * s), height: Math.round(img.height * s) });
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
}

// 단추와 폼이 부르는 동작. 실패하면 이유를 알린다. 서버에 닿지 않으면 api()가 status 0으로 던진다.
async function act(fn) {
  try {
    await fn();
    await refresh(true);
  } catch (e) {
    toast(e.status === 0 ? "연결이 끊겨서 보내지 못했어요." : e.message);
  }
}

// 다른 폰에서 이 프로필로 이미 참가한 여행이면 프로필 토큰으로 다시 참가해 이 폰의 참가자 토큰을 받는다.
// 서버는 있던 참가자를 돌려주고 앞 폰의 토큰도 최근 4개까지 살려 둔다(T68). 참가자 id만 빌려 쓰면 동의를 켤 수 없다.
// 다시 참가했으면 true. 겹쳐 불러도 한 번만 보낸다(보낼 때마다 토큰이 바뀐다).
let claiming = null;
const claim = () => (claiming ??= rejoin().finally(() => (claiming = null)));
async function rejoin() {
  const c = trip?.code;
  if (!c || (store(c) && store(`${c}:token`)) || !profile || !trip.participants.some((p) => p.profileId === profile.id)) return false;
  const seat = trip.participants.find((p) => p.profileId === profile.id).seat; // openapi는 seat 필수. 있던 참가자라 서버는 자리를 바꾸지 않는다
  const p = await api("POST", `/trips/${c}/participants`, { seat }, store("profile"));
  store(c, p.id);
  store(`${c}:token`, p.token);
  return true;
}

// 이 폰의 참가자 토큰으로 부른다(동의 켜기, 지우기, 숏폼). 누른 여행을 잡아 그 여행의 토큰만 쓴다.
// 서버가 토큰을 잊었으면(401: 같은 프로필이 다른 곳에서 다섯 번 넘게 다시 참가) 프로필로 들어온 사람은
// 다시 참가해 새 토큰으로 한 번 더 한다. 기다리는 사이 다른 여행으로 옮겼으면 다시 하지 않는다. 손님은 다시 받을 길이 없다.
async function asMe(me, call) {
  const c = trip.code;
  const go = () => call(c, store(`${c}:token`));
  return go().catch(async (e) => {
    if (e.status !== 401 || !profile || me.profileId !== profile.id || trip?.code !== c) throw e;
    store(`${c}:token`, null);
    await claim();
    if (trip?.code !== c) throw e;
    return go();
  });
}

const typing = () => app.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);

async function refresh(force) {
  if (failed && !force) return;
  const recoveringProfile = !profile && !!store("profile") && navigator.onLine !== false;
  if (recoveringProfile) {
    await loadProfile();
    if (profile && location.hash === "#me") fillDraft();
  }
  if (code()) {
    // 머리의 '연결됨·연결 끊김'과 기록 단추 잠금은 offline을 따른다. 값이 바뀌었으면 304·끊김이어도 다시 그린다(입력 중이면 끝난 뒤).
    const redraw = (was) => { if (was !== offline) { if (typing()) stale = true; else render(); } };
    try {
      const next = await call("GET", `/${code()}${trip && !force ? `?v=${trip.version}` : ""}`);
      const was = offline;
      offline = false;
      if (next) (trip = next), (failed = "");
      // 못 받았으면 다음 폴링에서 다시 한다. 그동안은 참가 화면이 보이고, 거기서 참가해도 같은 참가자로 들어간다.
      const claimed = await claim().catch(() => false);
      if (!next && !claimed) { conversations.sync(); redraw(was); return; }
    } catch (e) {
      if (e.status === 0) {
        // 터널 같은 곳에서는 마지막 화면을 그대로 두고 계속 다시 묻는다
        if (!offline) toast("연결이 끊겼어요. 다시 이어지면 새로 보여 드려요.");
        const was = offline;
        offline = true;
        redraw(was);
        return;
      }
      trip = null;
      failed = e.message;
    }
  } else if (!force && !recoveringProfile) return;
  if (typing() && !force) stale = true;
  else render();
}

const button = (label, onclick, className = "") => h("button", { type: "button", className, onclick }, label);
const bar = (...kids) => h("div", { className: "bar" }, h("div", {}, kids));
const header = (...kids) => h("div", { className: "top" }, kids);
const form = (onsubmit, ...kids) => h("form", { className: "stack", onsubmit: (e) => (e.preventDefault(), onsubmit()) }, kids);

// 하나를 고르는 칩. 라디오 단추라 키보드와 화면 낭독기가 그대로 쓴다.
const chip = (name, value, label, { sub, onpick, ...input } = {}) =>
  h("label", { className: "chip" }, h("input", { type: "radio", name, value, onchange: () => onpick?.(value), ...input }), label, sub && h("small", {}, sub));
const chipGroup = (legend, name, options, current, onpick) =>
  h("fieldset", {}, h("legend", {}, legend), h("div", { className: `chips${name === "character" ? " character-options" : ""}` }, options.map(([v, label]) => name === "character"
    ? h("label", { className: "chip character-option" }, h("input", { type: "radio", name, value: v, checked: v === current, onchange: () => onpick(v) }), characterImage(v), h("span", {}, label))
    : chip(name, v, label, { checked: v === current, onpick }))));

// 얼굴: 사진, 없으면 캐릭터 그림(style.css .c-*), 없으면 기본 그림
// 캐릭터 값은 서버가 20자 문자열로만 받으므로, 목록에 있는 값만 클래스로 쓴다(다른 클래스가 섞이지 않게).
const face = characterKey;
const avatar = (p, src) => h("span", { className: src ? "avatar profile-picture" : "avatar character-avatar", "aria-hidden": "true" }, src ? h("img", { src, alt: "" }) : characterImage(face(p?.character)));

// 작은 선 아이콘만 쓰고 캐릭터 원본을 장식 아이콘으로 대체하지 않는다.
const uiIcon = (name) => {
  const paths = {
    pencil: "m16 3 5 5M4 20l4-1L21 6l-5-5L3 14l-1 7 7-1",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    record: "M8 5h8a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Zm1 5h6m-6 4h6M9 2v5m6-5v5",
    play: "m9 5 11 7-11 7V5Z",
    qr: "M3 3h6v6H3V3Zm12 0h6v6h-6V3ZM3 15h6v6H3v-6Zm12 0h2v2h4v4h-6v-6Z",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", paths[name] || paths.arrow);
  svg.append(path);
  return svg;
};
const editPortrait = () => h("button", { type: "button", className: "portrait-edit", "aria-label": "내 사진과 프로필 편집", onclick: () => { location.hash = "me"; } }, avatar(profile, photo), h("span", { className: "portrait-pencil" }, uiIcon("pencil")));
// 참가자 얼굴: 내 프로필이면 내 사진·캐릭터, 아니면 자리 순서의 기본 캐릭터(시안: basic·cap·glasses·travel·game).
function personAvatar(person) {
  const mine = person?.profileId && person.profileId === profile?.id;
  const fallback = ["basic", "cap", "glasses", "travel", "game"][Math.max(0, SEATS.findIndex(([seat]) => seat === person?.seat))];
  return avatar(mine ? profile : { ...person, character: person?.character || fallback }, mine ? photo : "");
}

function fillDraft() {
  URL.revokeObjectURL(pdraft.preview);
  Object.assign(pdraft, { name: profile?.name ?? "", character: profile?.character ?? "basic", photo: null, preview: "", consentDefault: profile?.consentDefault ?? false });
}

// 얼굴 자체가 사진 선택의 시작점이다. 이름은 얼굴 바로 아래에서 고친다.
function profileFields(full) {
  const repaint = () => app.querySelector(".profile-photo .avatar")?.replaceWith(avatar({ character: pdraft.character }, pdraft.preview || photo));
  const pick = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const shrunk = await shrink(file);
      if (!shrunk) throw new Error("사진을 읽지 못했어요.");
      pdraft.photo = shrunk;
      URL.revokeObjectURL(pdraft.preview);
      pdraft.preview = URL.createObjectURL(shrunk);
      repaint();
    } catch { toast("이 사진은 읽지 못했어요. 다른 사진을 골라 주세요."); }
  };
  const file = h("input", { type: "file", accept: "image/*", className: "visually-hidden", "aria-label": "프로필 사진 선택", onchange: pick });
  return [
    h("div", { className: "profile-photo" },
      h("button", { type: "button", className: "portrait-edit", "aria-label": "프로필 사진 선택", onclick: () => file.click() }, avatar({ character: pdraft.character }, pdraft.preview || photo), h("span", { className: "portrait-pencil" }, uiIcon("pencil"))),
      file, h("p", { className: "meta" }, "사진을 누르면 바꿀 수 있어요"),
    ),
    h("label", { className: "field" }, h("span", {}, "이름 또는 별명"), h("input", { value: pdraft.name, required: true, maxLength: 20, autocomplete: "nickname", placeholder: "함께 타는 사람들에게 보일 이름", oninput: (e) => (pdraft.name = e.target.value) })),
    chipGroup("나를 닮은 캐릭터", "character", CHARACTERS, pdraft.character, (v) => { pdraft.character = v; repaint(); }),
    full && h("div", { className: "preference-row" }, h("span", {}, "다음 여행에서 기록 동의 먼저 제안받기"), h("button", { type: "button", role: "switch", "aria-checked": String(pdraft.consentDefault), "aria-label": "기록 동의 먼저 제안받기", className: `mobile-switch${pdraft.consentDefault ? " is-on" : ""}`, onclick: (e) => { pdraft.consentDefault = !pdraft.consentDefault; e.currentTarget.setAttribute("aria-checked", String(pdraft.consentDefault)); e.currentTarget.classList.toggle("is-on", pdraft.consentDefault); } }, h("span"))),
  ];
}

async function saveProfile() {
  if (savingProfile) return;
  if (!pdraft.name.trim()) return toast("함께 타는 사람들에게 보일 이름을 적어 주세요.");
  savingProfile = true;
  const control = document.getElementById("profile-save");
  if (control) { control.disabled = true; control.textContent = "저장 중"; }
  try {
    await act(async () => {
      const fresh = !store("profile");
      const body = { name: pdraft.name.trim(), consentDefault: pdraft.consentDefault, ...(pdraft.character && { character: pdraft.character }) };
      if (fresh) {
        store("profile", (await api("POST", "/profiles", { ...body, device: "폰" })).token);
        await loadProfile();
      } else await mine("PATCH", "/profiles/me", body);
      if (pdraft.photo) await mine("PUT", "/profiles/me/photo", pdraft.photo);
      await loadProfile();
      toast("프로필을 저장했어요.");
      location.hash = "";
    });
  } finally {
    savingProfile = false;
    if (control?.isConnected) { control.disabled = false; control.textContent = "저장"; }
  }
}

// 구글 로그인(OAuth 인증 코드). 새 로그인은 프로필 없이, 연결은 이 폰의 프로필 토큰과 함께 코드를 서버에 넘긴다.
// 복귀 주소는 이 웹앱의 /oauth/google/callback(서버가 첫 화면을 준다). Client ID는 서버가 준다(GET /api/config, 웹에 박지 않음).
// PKCE(S256, RFC 7636): verifier는 이 탭에만 두고 구글에는 그 해시(challenge)만 보낸다. 코드를 넘길 때 verifier를 같이 보낸다.
const GOOGLE_BACK = `${location.origin}/oauth/google/callback`;
const GOOGLE_KEY = "gachita:google"; // sessionStorage: { state, verifier, profileId, draft } — 돌아와서 확인하고, 실패하면 입력을 되돌린다
let googleId = ""; // 공개 Google Client ID. 비었으면(서버 설정 없음) 구글 단추를 숨긴다
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
const random = () => b64url(crypto.getRandomValues(new Uint8Array(32))); // 43자: state, PKCE verifier(43~128자)

async function google() {
  const state = random();
  const verifier = random();
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const { name, character, consentDefault } = pdraft; // 사진은 옮기지 못한다(돌아오면 다시 고른다)
  // 시작한 프로필(없으면 null = 새 로그인)을 묶어 둔다: 돌아왔을 때 이 폰의 프로필이 바뀌었으면 연결하지 않는다
  sessionStorage.setItem(GOOGLE_KEY, JSON.stringify({ state, verifier, invite: boarding.pending(), profileId: profile?.id ?? null, draft: { name, character, consentDefault } }));
  const q = { client_id: googleId, redirect_uri: GOOGLE_BACK, response_type: "code", scope: "openid profile", state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" };
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(q)}`;
}

// 구글에서 돌아옴. 코드가 기록에 남지 않게 먼저 주소창을 /#me로 바꾸고, state가 맞을 때만 코드를 넘긴다.
// 실패·취소면 프로필은 그대로 두고, 구글로 가기 전에 쓰던 입력을 돌려준다(성공이면 null).
async function googleBack() {
  const q = new URLSearchParams(location.search);
  history.replaceState(null, "", "/#me");
  const saved = JSON.parse(sessionStorage.getItem(GOOGLE_KEY) ?? "null");
  sessionStorage.removeItem(GOOGLE_KEY);
  const fail = (message) => (toast(message), saved?.draft ?? null);
  if (q.get("state") === saved?.state && /^[A-Za-z0-9_-]{20,120}$/.test(saved?.invite || "")) history.replaceState(null, "", `/?join=${encodeURIComponent(saved.invite)}#me`);
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "구글 로그인을 취소했어요." : "구글 로그인을 마치지 못했어요. 다시 해 주세요.");
  if (!saved?.verifier || !q.get("code") || q.get("state") !== saved.state) return fail("로그인 요청을 확인하지 못했어요. 다시 해 주세요.");
  // 다른 탭에서 프로필을 지우거나 새로 만들었으면 엉뚱한 프로필에 구글을 붙이지 않게 멈춘다
  const nowId = store("profile") ? await mine("GET", "/profiles/me").then((p) => p.id, () => undefined) : null;
  if (nowId !== saved.profileId) return fail("구글로 가는 사이 이 폰의 프로필이 바뀌어 멈췄어요. 다시 해 주세요.");
  try {
    const res = await api("POST", "/profiles/me/links/google", { code: q.get("code"), redirectUri: GOOGLE_BACK, codeVerifier: saved.verifier, device: "폰" }, saved.profileId && store("profile"));
    if (res.token) store("profile", res.token);
    if (saved.invite) history.replaceState(null, "", `/?join=${encodeURIComponent(saved.invite)}`);
    toast(res.token ? "구글 계정으로 들어왔어요." : "이 프로필에 구글 계정을 연결했어요.");
    return null;
  } catch (e) {
    return fail(
      e.status === 409 ? "이미 다른 프로필에 연결된 구글 계정이에요. 이 폰의 프로필은 그대로예요."
      : e.status === 401 || e.status === 400 ? "구글 로그인을 확인하지 못했어요. 다시 해 주세요."
      : e.status === 0 || e.status >= 500 ? "지금은 구글 계정을 확인할 수 없어요. 잠시 뒤 다시 해 주세요."
      : e.message,
    );
  }
}

function profileConnection() {
  return h("section", { className: "card", role: "status" },
    h("h2", {}, profileError ? "프로필을 불러오지 못했어요" : "프로필을 확인하고 있어요"),
    h("p", { className: "meta" }, "연결이 돌아오면 기존 프로필을 다시 보여 드려요. 새 프로필을 만들 필요는 없어요."),
    button("다시 불러오기", () => refresh(true)),
  );
}

function profileView() {
  if (!profile && store("profile")) return [header(button("이전", () => (location.hash = ""), "plain")), profileConnection()];
  const remove = () =>
    confirm("프로필과 남긴 장면 앨범이 지워져요. 지울까요?") &&
    act(async () => {
      await mine("DELETE", "/profiles/me");
      store("profile", null);
      await loadProfile();
      location.hash = "";
    });
  return [
    header(button("이전", () => (location.hash = ""), "plain"), h("span", { className: "meta" }, profile ? "내 프로필" : "프로필 만들기")),
    h("h1", {}, profile ? "내 프로필" : "나를 소개해 주세요"),
    h("p", { className: "sub" }, "같이 타는 사람들에게 보이는 이름과 얼굴이에요."),
    googleId &&
      !profile?.links?.includes("google") &&
      h(
        "section",
        { className: "card" },
        h("p", { className: "what" }, profile ? "다른 기기에서도 쓰기" : "구글 계정이 있나요?"),
        h("p", { className: "meta" }, profile ? "구글 계정을 연결하면 다른 폰에서 구글로 계속해 이 프로필로 들어와요." : "구글로 계속하면 다른 폰에서도 같은 프로필로 들어와요. 전에 만든 프로필이 있으면 그대로 이어져요."),
        button(profile ? "구글 계정 연결" : "구글로 계속", () => google().catch((e) => toast(e.status === 0 ? "연결이 끊겨서 열지 못했어요." : e.message))),
      ),
    profile?.links?.includes("google") &&
      h(
        "section",
        { className: "card" },
        h("p", { className: "what" }, "구글 계정을 연결했어요"),
        h("p", { className: "meta" }, "다른 폰에서 구글로 계속하면 이 프로필로 들어와요."),
        button("구글 연결 끊기", () => act(async () => (await mine("DELETE", "/profiles/me/links/google"), await loadProfile(), toast("구글 연결을 끊었어요."))), "plain"),
      ),
    profile && h("section", { className: "card" },
      h("p", { className: "what" }, profile.email ? (profile.hasVoice ? "목소리 다시 등록" : "15초 목소리 등록") : "이메일 계정과 목소리 등록"),
      h("p", { className: "meta" }, profile.email ? `${profile.email} 계정 · 차에서 말한 사람을 알아보는 데 써요.` : "같은 계정으로 차에서도 로그인하고, 15초 목소리로 말한 사람을 알아봐요."),
      button(profile.email ? "목소리 등록하기" : "계정 만들기", () => { onboarding.open(); location.hash = "start"; })),
    form(saveProfile, ...profileFields(true), bar(h("button", { id: "profile-save", className: "primary", disabled: savingProfile }, savingProfile ? "저장 중" : "저장"))),
    profile &&
      h(
        "section",
        { className: "card" },
        h("p", { className: "what" }, "지우기"),
        h(
          "div",
          { className: "row" },
          profile.hasPhoto && button("사진 지우기", () => act(async () => (await mine("DELETE", "/profiles/me/photo"), await loadProfile()))),
          button("프로필 지우기", remove, "plain"),
        ),
      ),
  ];
}

function home() {
  const last = store("trip");
  const entry = (icon, title, detail, onclick, className = "") => h("button", { type: "button", className: `home-entry ${className}`, onclick },
    h("span", { className: "entry-icon", "aria-hidden": "true" }, uiIcon(icon)),
    h("span", { className: "entry-copy" }, h("strong", {}, title), h("span", {}, detail)),
    h("span", { className: "entry-arrow", "aria-hidden": "true" }, uiIcon("arrow")),
  );
  return [
    header(h("span", { className: "brand" }, "가치타"), h("span", { className: "meta" }, "함께 타고, 함께 남기고")),
    h("section", { className: "home-intro" },
      profile ? h("div", { className: "home-profile" }, editPortrait(), h("div", {}, h("p", { className: "meta" }, "오늘도 함께해요"), h("h1", {}, `${profile.name} 님`))) : h("h1", {}, "같이 탄 오늘,", h("br"), "함께 남겨요."),
      h("p", { className: "sub" }, profile ? "차 안에서 나눈 이야기가 우리만의 기록이 돼요." : "이름과 얼굴을 정하고, 차 화면의 QR을 스캔해 주세요."),
    ),
    profile?.email && !profile.hasVoice && entry("record", "15초 목소리 등록", "차에서 말한 사람을 알아보는 데 써요", () => { onboarding.open(); location.hash = "start"; }),
    profile ? entry("qr", "차량 QR로 참여", "차 화면의 QR을 휴대폰으로 스캔해요", startRide, "ride-entry") : store("profile") ? profileConnection() : entry("pencil", "내 프로필 만들기", "사진 또는 캐릭터로 나를 소개해요", () => { location.hash = "me"; }, "ride-entry"),
    h("section", { className: "home-section" }, h("div", { className: "between" }, h("h2", {}, "다시 만나는 우리 이야기"), button("보관함", () => studio.open({ view: "library" }), "plain")), entry("play", "우리 쇼츠", "원래 목소리로 남긴 짧은 여행", launchShort)),
    last && h("section", { className: "home-section" },
      h("div", { className: "between" }, h("h2", {}, "함께한 여행"), button("여행 열기", () => { location.hash = last; }, "plain")),
      entry("record", "대화 기록", "최근에 탄 여행의 이야기를 이어 봐요", openConversations),
    ),
    profile && h("section", { className: "home-section" },
      h("h2", {}, "내가 남긴 순간"),
      h("div", { className: "home-library" },
        entry("record", "내 기록본", "내가 한 말과 남긴 장면", records.openFeed),
        entry("play", "나눈 장면", "동승자와 주고받은 기록", () => shares.openList("received")),
      ),
    ),
    !last && h("section", { className: "home-first" },
      avatar({ character: "travel" }),
      h("div", {}, h("h2", {}, "첫 이야기를 기다리고 있어요"), h("p", { className: "meta" }, "차에 연결하면 대화 기록과 남긴 장면이 여기에 모여요.")),
    ),
    h("p", { className: "home-footer" }, "우리의 목소리로 남기는 여행"),
  ];
}

const loading = () => [header(h("span", { className: "brand" }, "가치타")), h("div", { className: "skeleton" }), h("div", { className: "skeleton" })];

const missing = () => [
  header(h("span", { className: "brand" }, "가치타")),
  h("h1", {}, "여행을 찾지 못했어요"),
  h("p", { className: "sub" }, "여행이 지워졌거나 연결한 주소를 찾을 수 없어요."),
  bar(button("처음으로", () => (location.hash = ""), "primary")),
];

// 이 폰이 들어가지 않은 여행. 여행 코드로는 들어갈 수 없고, 차의 참석 QR로 참여한다.
const notHere = () => [
  header(h("span", { className: "brand" }, "가치타")),
  h("h1", {}, "이 폰은 이 여행에 없어요"),
  h("p", { className: "sub" }, "차 화면의 동승자 설정에서 참석 QR을 열고, 이 휴대폰의 카메라로 스캔해 주세요."),
  bar(button("처음으로", () => (location.hash = ""), "primary")),
];

// 차가 넣어 준 뒤 한 번 묻는 기록 동의. 켜기는 이 폰의 참가자 토큰으로만 된다(T68). 고른 뒤로는 여행 화면에서 바꾼다.
const asking = (me) => !me.consent && !store(`${trip.code}:asked`);
function consentView(me) {
  const decide = (on) => () => (store(`${trip.code}:asked`, "1"), (reading = false), on ? consentOn(me) : render());
  return [
    header(h("span", { className: "brand" }, "가치타"), h("span", { className: "meta" }, trip.title || "가치타 여행")),
    asking(me) && h("p", { className: "state" }, `${SEAT[me.seat] ?? "차"}에 탔어요`),
    h("h1", {}, "이동 중 대화를 기록해도 될까요?"),
    h("p", { className: "sub" }, "도착한 뒤 재미있던 장면을 클립으로 남기는 데 써요. 한 명이라도 동의하지 않으면 기록하지 않아요."),
    h("p", { className: "meta" }, "내 동의는 기록을 허락하는 설정이에요. 실제 녹음은 차에서 따로 시작해요."),
    h("ul", { className: "card" }, CONSENT.map((line) => h("li", {}, line))),
    bar(myToken() ? button("동의해요", decide(true), "primary") : h("p", { className: "meta" }, ONLY_HERE), button("동의하지 않아요", decide(false))),
  ];
}

// 켜기는 본인의 참가자 토큰으로만 된다(끄기는 누구나). 서버가 이 폰의 토큰을 잊었으면(다른 곳에서 다섯 번 넘게
// 다시 참가) 프로필로 들어온 사람은 다시 참가해 새 토큰으로 한 번 더 켠다. 손님은 다시 받을 길이 없다.
// 켜기는 본인의 참가자 토큰으로만 된다(끄기는 누구나). 토큰 회복과 여행 고정은 asMe()가 한다.
const consentOn = (me) =>
  act(() =>
    asMe(me, (c, token) => api("PATCH", `/trips/${c}/participants/${me.id}`, { consent: true }, token)).catch((e) => {
      throw e.status === 401 || e.status === 403 ? new Error(ONLY_HERE) : e;
    }),
  );

// '함께 타는 중'(최종 시안 P17–P21). 위는 지금 상태(제목·좌석 지도·기록 상태 또는 곧 도착·도착 부탁),
// 아래는 그대로 둔 기능(할 일, 챙길 부탁, 내 동의, 장면·자막·공유)이다. 도착과 '확인'은 이 탭에서만 기억한다(여행·동의 세대별, 저장하지 않음).
const ride = { seen: { key: "", place: "", at: null }, near: { key: "", id: "" } };
function tripView(me) {
  const t = `/${trip.code}`;
  const driver = me.seat === "ROW_1_LEFT";
  const by = Object.fromEntries(trip.participants.map((p) => [p.id, p]));
  const waiting = trip.status === "driving" ? trip.participants.filter((p) => !p.consent).map((p) => p.name) : [];
  const patch = (path, body) => () => act(() => call("PATCH", t + path, body));
  // 지우기(#156 동의 문구): 장면 소리는 이 여행의 참가자 누구나, 자기 글은 프로필로 참가한 사람만
  const eraseClip = (m) =>
    confirm("이 장면의 소리를 지울까요? 받아 적은 글과 장면은 남아요.") &&
    act(async () => {
      const del = () => asMe(me, (c, token) => api("DELETE", `/trips/${c}/recordings/${m.id}`, null, token));
      await del()
        .catch((e) => (e.status === 409 ? del() : Promise.reject(e))) // 그사이 새로 올라왔으면 한 번 더 지운다
        .then(
          () => toast("장면 소리를 지웠어요."),
          (e) => (e.status === 404 ? toast("지울 소리가 없어요.") : Promise.reject(e)),
        );
    });
  const eraseMine = () =>
    confirm("이 여행에서 내 이름이 붙은 받아 적은 글을 지울까요? 되돌릴 수 없어요.") &&
    act(async () => {
      const { deleted } = await asMe(me, (c, token) => api("DELETE", `/trips/${c}/utterances`, null, token));
      toast(deleted ? `내 이름이 붙은 글 ${deleted}줄을 지웠어요.` : "지울 내 글이 없어요.");
    });
  const open = trip.requests.filter((r) => !CLOSED.includes(r.status));

  // 지금 상태 고르기. 할 일은 기록에 동의하고 이 폰에서 연결한 사람만 읽는다(todos.snapshot이 null이면 부탁을 말하지 않음).
  // 마지막 읽기가 실패한 목록(stale)으로는 완료·남은 수를 단정하지 않는다.
  const scope = `${trip.code}:${trip.generation ?? 1}`;
  const list = todos.snapshot();
  const asks = askState(list);
  if (trip.status === "parked" && list?.arrival?.place) ride.seen = { key: scope, place: list.arrival.place, at: list.arrival.at };
  const state = driveState(trip, { places: places.items(), arrival: list?.arrival, seenArrival: ride.seen.key === scope ? ride.seen : null, nearSeen: ride.near.key === scope ? ride.near.id : "" });
  const heading = rideHeading(state, { title: trip.title, waiting, asks });
  const [recordText, recordOn] = recordingLine(trip, waiting);

  // 아래 단추: 기록 중지·재개(주행 중, 누구나), 곧 도착 '확인', 그 밖에는 운전석의 다음 여행 상태. 부탁 남기기는 늘 함께.
  const moves = driver ? statusMoves(trip) : [];
  const move = ([label, status, ask], className) => button(label, () => (!ask || confirm(ask)) && patch("", { status })(), className);
  const toggleRecording = async (e) => {
    const control = e.currentTarget;
    control.disabled = true;
    try { await patch("", { recording: !trip.recording })(); } finally { if (control.isConnected) control.disabled = offline; }
  };
  const recordButton = (className) => h("button", { type: "button", className, disabled: offline || (!trip.recording && waiting.length > 0), onclick: toggleRecording }, trip.recording ? "기록 중지" : "기록 재개");
  let main = null;
  if (state.kind === "near") main = button("확인", () => { ride.near = { key: scope, id: state.id }; render(); }, "primary");
  else if (trip.status === "driving") main = recordButton("primary big");
  else if (moves.length) main = move(moves.shift(), "primary");
  const ask = trip.status !== "ended" && button("부탁 남기기", () => (sheet.showModal(), sheet.querySelector("#sheet-text").focus()), main ? "secondary" : "primary");

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

  // 기록 상태 띠. 곧 도착 화면에서는 주 단추가 '확인'이라 기록 중지·재개를 띠 안에 둔다(멈추는 길을 가리지 않게).
  const band = (withToggle) => h("section", { className: `ride-status${recordOn ? " on" : ""}`, role: "status" },
    h("div", { className: "between" }, h("strong", {}, recordText), withToggle && recordButton("plain")),
    h("p", { className: "meta" }, "실제 녹음 상태는 차 화면에서 확인해 주세요."));
  const now = state.kind === "near" ? [nearCard(state, asks), band(true)]
    : state.kind === "arrived" ? arrivalCards(state, asks, trip.participants, personAvatar)
    : [seatMap(trip, me, personAvatar), band(false)];

  return [
    appBar({ online: !offline, onHome: () => { location.hash = ""; } }),
    journeyTabs("ride", { talk: () => conversations.open(), contents: launchShort }),
    h("div", { className: "ride-title" }, h("h1", {}, heading.title), heading.sub && h("p", { className: "sub" }, heading.sub)),
    ...now,
    todos.card(),
    h(
      "section",
      { className: "card" },
      h("h2", {}, open.length ? `챙길 부탁 ${open.length}건` : "챙길 부탁"),
      trip.requests.length ? h("ul", {}, trip.requests.map(request)) : h("p", { className: "empty" }, "아직 부탁이 없어요. 들르고 싶은 곳이나 챙길 일을 남겨 보세요."),
    ),
    h(
      "section",
      { className: "card" },
      h("div", { className: "between" }, h("div", {}, h("p", { className: "what" }, "내 자리"), h("p", { className: "meta" }, `${SEAT[me.seat]} · ${TRIP[trip.status]}`)),
        // 운전석의 나머지 여행 상태 단추(첫째는 아래 주 단추 자리). 시안 위쪽을 가리지 않게 여기 둔다.
        moves.length > 0 && h("div", { className: "row ride-moves" }, moves.map((m) => move(m)))),
      h(
        "div",
        { className: "between" },
        h("div", {}, h("p", { className: "what" }, "대화 기록 동의"), h("p", { className: "meta" }, me.consent ? "동의했어요." : "동의하지 않았어요.")),
        me.consent ? button("동의 끄기", () => confirm(OFF_WIPES) && patch(`/participants/${me.id}`, { consent: false })()) : myToken() ? button("동의 켜기", () => ((reading = true), render(), scrollTo(0, 0))) : h("p", { className: "meta" }, ONLY_HERE),
      ),
      // 동의 문구가 약속한 지우기: 프로필로 참가한 사람의 자기 글(손님 발화는 누구 것인지 가릴 수 없어 서버가 403)
      me.profileId &&
        myToken() &&
        h("div", { className: "between" }, h("div", {}, h("p", { className: "what" }, "내 글"), h("p", { className: "meta" }, "내 이름이 붙은 받아 적은 글")), button("내 글 지우기", eraseMine, "plain")),
      // 이미 동의한 사람도 지금의 동의 문구(바뀐 것 포함)를 언제든 다시 본다
      h("details", {}, h("summary", { className: "meta" }, "동의 문구 보기"), h("ul", {}, CONSENT.map((line) => h("li", {}, line)))),
    ),
    me.consent && myToken() && h("div", { className: "row" }, button("쇼츠로 남길 장면", () => scenes.open(), "grow primary"), button("자막 수정", () => captions.open(), "plain")),
    trip.moments.length > 0 &&
      h(
        "section",
        { className: "card" },
        h("h2", {}, `남긴 장면 ${trip.moments.length}개`),
        !(me.consent && myToken()) && h("p", { className: "meta" }, "기록에 동의한 사람만 숏폼을 볼 수 있어요."),
        h(
          "ul",
          {},
          trip.moments.map((m) =>
            h(
              "li",
              { className: "between" },
              h("div", { className: "grow" }, h("span", { className: "what" }, m.label || "이름 없는 장면"), " ", h("span", { className: "meta" }, new Date(m.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }))),
              me.consent && myToken() && button("원음·자막", () => scenes.open({ momentId: m.id }), "plain"),
              myToken() && button("소리 지우기", () => eraseClip(m), "plain"),
            ),
          ),
        ),
      ),
    profile && me.profileId === profile.id && me.consent && myToken() && trip.moments.length > 0 && h("section", { className: "card" }, h("div", { className: "between" }, h("h2", {}, "함께 나눌 장면"), shareIconButton("share", "내 장면 공유", () => shares.openCompose())), h("p", { className: "meta" }, "내 앨범에 남긴 장면과 받는 동승자를 직접 골라요.")),
    (ask || main) && bar(ask, main),
  ];
}

// 서버 장면 클립·자막을 9:16 말랑 대화극으로 재생한다. 영상 만들기는 현재 장면을 실제 소리와 녹화한다.
// 클립은 머리말 인증으로 받아 object URL로 튼다(토큰을 URL에 넣지 않음). 첫 재생은 사람이 누른다(자동 재생 막기).
let short = null; // 보고 있는 구성 { title, cast, scenes, code, generation, at(지금 장면), clips(장면별 object URL 약속), started, req }
const audio = new Audio(); // DOM 밖에 두어 화면을 다시 그려도 끊기지 않는다
let openingShort;
const shortReadReason = (s) => trip?.code !== s.code || code() !== s.code ? "여행이 바뀌어 쇼츠를 닫았어요."
  : !trip.participants.find((p) => p.id === s.participantId)?.consent || trip.generation !== s.generation ? "기록 동의가 바뀌어 쇼츠를 닫았어요."
  : !myToken() || myToken() !== s.token ? "동승 연결을 다시 확인해 주세요." : "";
const clearFilmFile = (s) => { if (s.fileUrl) URL.revokeObjectURL(s.fileUrl); s.fileUrl = null; s.file = null; s.libraryId = null; s.assetSource = null; };
const cancelFilm = (s) => { s.exportJob?.abort(); s.exportJob = null; s.exportProgress = 0; };
const checkFilmAccess = async (s, signal) => {
  const control = new AbortController();
  const cancel = () => control.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) control.abort();
  const timeout = setTimeout(cancel, 8000);
  try {
    if (shortReadReason(s) || offline) throw new Error("지금은 기록 권한을 확인할 수 없어요. 연결 후 다시 시도해 주세요.");
    const data = await api("GET", `/trips/${s.code}/transcript`, null, s.token, control.signal);
    if (data.generation !== s.generation || shortReadReason(s)) throw new Error("기록 동의가 바뀌어 영상 만들기를 멈췄어요.");
    if (s.assetSource) {
      const latest = await api("GET", `/trips/${s.code}/short-assets/source?moment=${encodeURIComponent(s.assetSource.momentId)}`, null, s.token, control.signal);
      if (latest.sourceHash !== s.assetSource.sourceHash || latest.generation !== s.generation) throw new Error("원음·자막·화자가 바뀌었어요. 최신 내용으로 다시 만들어 주세요.");
    }
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", cancel); }
};

async function makeShortFilm(s) {
  if (s.exportJob || short !== s || shortReadReason(s)) return;
  const index = s.at;
  const controller = s.exportJob = new AbortController();
  s.exportError = ""; s.exportProgress = 0; clearFilmFile(s); audio.pause(); s.paint?.();
  try {
    const source = await api("GET", `/trips/${s.code}/short-assets/source?moment=${encodeURIComponent(s.scenes[index].momentId)}`, null, s.token, controller.signal);
    if (source.generation !== s.generation || shortReadReason(s)) throw new Error("원음과 기록 동의를 다시 확인해 주세요.");
    s.assetSource = source;
    s.title = source.source.title; s.cast = source.source.cast; s.scenes[index] = source.source.scenes[0];
    s.film.dispose(); s.film = createShortFilm({ title: s.title, cast: s.cast });
    const file = await exportShortFilm({ title: s.title, cast: s.cast, scene: s.scenes[index], signal: controller.signal,
      canRead: () => short === s && s.exportJob === controller && s.at === index && !shortReadReason(s) && !offline,
      checkAccess: (signal) => checkFilmAccess(s, signal),
      getAudio: async (signal) => {
        const response = await fetch(clipAddress(s, index), { signal, headers: { authorization: `Bearer ${s.token}` } });
        if (!response.ok) throw new Error(`장면 소리를 받지 못했어요(${response.status}).`);
        return response.arrayBuffer();
      },
      onProgress: (progress) => { if (s.exportJob === controller) { s.exportProgress = progress; s.paint?.(); } },
    });
    if (short !== s || s.exportJob !== controller || shortReadReason(s)) return;
    s.file = file; s.fileUrl = URL.createObjectURL(file);
  } catch (error) {
    if (short === s && s.exportJob === controller) s.exportError = error.name === "AbortError" ? "영상 만들기를 취소했어요." : error.message;
  } finally {
    if (s.exportJob === controller) s.exportJob = null;
    if (short === s) s.paint?.();
  }
}

async function saveShortFilm(s) {
  if (!s.file || shortReadReason(s) || s.saving || !s.assetSource) return;
  s.saving = true; s.paint?.();
  try {
    await checkFilmAccess(s, s.controller.signal);
    const { momentId, generation, sourceHash } = s.assetSource;
    const key = s.libraryId ||= crypto.randomUUID();
    const query = new URLSearchParams({ moment: momentId, generation, sourceHash, key });
    const value = await api("POST", `/trips/${s.code}/short-assets?${query}`, s.file, s.token, AbortSignal.any([s.controller.signal, AbortSignal.timeout(150000)]));
    if (short !== s || shortReadReason(s)) return;
    closeShort(); studio.open({ selectedId: `asset:${s.code}:${value.id}` }); toast("서버 보관함에 저장했어요. 차량과 휴대폰에서 함께 볼 수 있어요.");
  } catch (e) { s.exportError = e.message; toast(e.message); }
  finally { s.saving = false; if (short === s) s.paint?.(); }
}
async function shareShortFilm(s) {
  if (!s.file || shortReadReason(s)) return;
  if (!navigator.canShare?.({ files: [s.file] })) { s.exportError = "이 브라우저는 파일 공유를 지원하지 않아요. 영상을 저장해 공유해 주세요."; s.paint?.(); return; }
  try { await checkFilmAccess(s, s.controller.signal); if (short !== s || !s.file) return; await navigator.share({ files: [s.file], title: s.scenes[s.at].label || "가치타 쇼츠" }); }
  catch (error) { if (error.name !== "AbortError") { s.exportError = "공유를 마치지 못했어요. 영상을 저장해 다시 공유해 주세요."; s.paint?.(); } }
}

async function openShort(me, momentId) {
  const c = trip.code;
  const generation = trip.generation;
  if (!me.consent || !myToken()) return toast("기록에 동의한 사람만 숏폼을 볼 수 있어요.");
  openingShort?.abort();
  const opening = openingShort = new AbortController();
  const data = await asMe(me, (code, token) => api("GET", `/trips/${code}/shortform`, null, token, opening.signal)).catch((e) => {
    throw e.status === 401 || e.status === 403 ? new Error("기록에 동의한 사람만 숏폼을 볼 수 있어요.") : e;
  });
  if (opening.signal.aborted || trip?.code !== c || trip.generation !== generation || data.generation !== generation) return;
  if (!data.scenes.length) return toast("아직 숏폼으로 만들 장면 클립이 없어요.");
  const at = momentId ? data.scenes.findIndex((scene) => scene.momentId === momentId) : 0;
  if (at < 0) return toast("선택한 장면의 원음을 다시 확인해 주세요.");
  // 연 때의 여행·동의 세대를 남긴다: 보는 사이 바뀌면 render()가 닫는다
  if (short) closeShort();
  short = { ...data, code: c, generation, participantId: me.id, token: myToken(), createdAt: trip.createdAt, at, clips: [], waveforms: [], started: false, req: 0, controller: new AbortController() };
  short.film = createShortFilm({ title: short.title, cast: short.cast });
  const current = short;
  const animate = () => {
    if (short !== current) return;
    const reason = shortReadReason(current);
    if (reason) return closeShort(reason);
    current.film.draw(current.scenes[current.at], current.exportJob ? current.exportProgress * current.scenes[current.at].seconds : current.started ? audio.currentTime : 0, Boolean(current.exportJob) || !audio.paused);
    current.frame = requestAnimationFrame(animate);
  };
  current.frame = requestAnimationFrame(animate);
  current.fileGuard = setInterval(async () => {
    if (!current.file || current.checkingFile || short !== current) return;
    current.checkingFile = true;
    try { await checkFilmAccess(current, current.controller.signal); }
    catch { if (short === current) { clearFilmFile(current); current.exportError = "기록 권한을 확인할 수 없어 만든 영상을 비웠어요."; current.paint?.(); } }
    finally { current.checkingFile = false; }
  }, 2000);
  audio.muted = false;
  render();
}
// 장면 소리를 머리말 인증으로 받아 object URL로. 실패하면 그 자리를 비워 연결이 돌아오면 다시 받는다.
const clipAddress = (s, i) => {
  const url = new URL(s.scenes[i].clip, location.origin);
  if (url.origin !== location.origin || url.pathname !== `/api/trips/${s.code}/recordings/${s.scenes[i].momentId}` || url.search || url.hash) throw new Error("장면 소리 주소를 확인하지 못했어요.");
  return url;
};
const clip = async (s, i) => {
  return (s.clips[i] ??= fetch(clipAddress(s, i), { headers: { authorization: `Bearer ${s.token}` }, signal: s.controller.signal })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`장면 소리를 받지 못했어요(${r.status}).`))))
    .then((b) => {
      audioPeaks(b).then((peaks) => { if (short === s && !shortReadReason(s)) { s.waveforms[i] = peaks; s.paint?.(); } }).catch(() => {});
      return URL.createObjectURL(b);
    })
    .catch((e) => {
      s.clips[i] = null;
      throw e instanceof TypeError ? Object.assign(new Error("연결이 끊겨서 소리를 받지 못했어요."), { status: 0 }) : e;
    }));
};
async function playScene(i) {
  const s = short;
  if (!s || s.exportJob || i < 0 || i >= s.scenes.length) return;
  if (shortReadReason(s)) return closeShort(shortReadReason(s));
  const req = ++s.req; // 늦게 끝난 옛 받기가 새 재생의 소리를 덮지 않게 마지막 요청만 튼다
  s.loading = true;
  s.paint?.();
  try {
    const url = await clip(s, i);
    if (short !== s || s.req !== req) return; // 받는 사이 닫았거나 다른 장면을 틀었다
    // 소리를 받은 뒤에 장면과 소리를 함께 바꾼다: 받기에 실패하면 지금 장면에 머물러 자막과 소리가 어긋나지 않는다
    if (s.at !== i) { clearFilmFile(s); s.exportError = ""; }
    s.at = i;
    s.started = true;
    audio.src = url;
    s.paint?.();
    await audio.play();
    if (i + 1 < s.scenes.length) clip(s, i + 1).catch(() => {}); // 다음 장면을 미리 받는다
  } finally {
    if (short === s && s.req === req) { s.loading = false; s.paint?.(); }
  }
}
const playing = (i) => playScene(i).catch((e) => toast(e.message));
function closeShort(message) {
  openingShort?.abort();
  if (short) { cancelFilm(short); clearFilmFile(short); short.controller.abort(); clearInterval(short.fileGuard); cancelAnimationFrame(short.frame); short.film.dispose(); }
  audio.pause();
  audio.removeAttribute("src");
  for (const u of short?.clips ?? []) u?.then(URL.revokeObjectURL, () => {});
  short = null;
  if (message) toast(message);
  render();
}
audio.ontimeupdate = () => short?.paint?.();
audio.onplay = audio.onpause = audio.onvolumechange = () => short?.paint?.();
audio.onended = () => short && (short.at + 1 < short.scenes.length ? playing(short.at + 1) : short.paint?.());
function shortView() {
  const s = short;
  const segs = s.scenes.map(() => h("i"));
  const count = h("span", { className: "short-count" });
  const clock = h("span", { className: "short-time" });
  const status = h("p", { className: "short-state", role: "status" });
  const caption = h("p", { className: "visually-hidden", "aria-live": "polite" });
  const toggle = () => s.loading || s.exportJob ? undefined : !s.started || audio.ended ? playing(s.at) : audio.paused ? audio.play().catch((e) => toast(e.message)) : audio.pause();
  const playControl = mediaButton("play", "원음 재생", toggle, "short-play");
  const mute = mediaButton("sound", "음소거", () => { audio.muted = !audio.muted; });
  const prev = mediaButton("up", "이전 쇼츠", () => playing(s.at - 1));
  const next = mediaButton("down", "다음 쇼츠", () => playing(s.at + 1));
  const waveform = h("canvas", { className: "audio-waveform", width: 880, height: 96, "aria-hidden": "true" });
  const seek = h("input", { type: "range", className: "audio-seek", min: 0, max: 1, step: .01, value: 0, "aria-label": "원음 재생 위치", oninput: (e) => { if (s.started && !s.loading && !s.exportJob && Number.isFinite(audio.duration)) { audio.currentTime = Number(e.target.value); s.paint?.(); } } });
  prev.setAttribute("aria-label", "이전 쇼츠"); next.setAttribute("aria-label", "다음 쇼츠");
  const make = button("영상 만들기", () => makeShortFilm(s), "short-make");
  const cancel = button("취소", () => { cancelFilm(s); s.exportError = "영상 만들기를 취소했어요."; s.paint?.(); });
  const save = button("서버 보관함에 저장", () => saveShortFilm(s), "short-make");
  const share = button("공유", () => shareShortFilm(s));
  const progress = h("progress", { className: "film-progress", max: 1, value: 0, "aria-label": "영상 만드는 중" });
  const exportNote = h("p", { className: "film-note", role: "status" });
  const actions = h("div", { className: "film-actions" }, make, cancel, save, share);
  const supported = Boolean(recordingFormat() && (globalThis.AudioContext || globalThis.webkitAudioContext) && HTMLCanvasElement.prototype.captureStream);
  const elapsed = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  s.paint = () => {
    const scene = s.scenes[s.at], exporting = Boolean(s.exportJob);
    const t = exporting ? s.exportProgress * scene.seconds : s.started ? audio.currentTime : 0;
    segs.forEach((el, i) => el.style.setProperty("--p", i < s.at ? 1 : i > s.at ? 0 : Math.min(1, t / scene.seconds)));
    count.textContent = `${s.at + 1} / ${s.scenes.length}`;
    clock.textContent = `${elapsed(t)} / ${elapsed(scene.seconds)}`;
    status.textContent = s.loading ? "장면 소리를 불러오고 있어요" : exporting ? `영상 만드는 중 · ${Math.round(s.exportProgress * 100)}%` : !s.started ? "우리의 목소리를 말랑 쇼츠로" : audio.ended ? "다시 듣고 싶은 순간" : audio.paused ? "잠시 멈춤" : "원래 목소리로 재생 중";
    const playing = s.started && !audio.paused && !audio.ended;
    setMediaButton(playControl, playing ? "pause" : "play", s.loading ? "원음 불러오는 중" : playing ? "원음 일시정지" : "원음 재생");
    playControl.disabled = Boolean(s.loading || exporting);
    setMediaButton(mute, audio.muted ? "muted" : "sound", audio.muted ? "소리 켜기" : "음소거"); mute.setAttribute("aria-pressed", String(audio.muted)); mute.disabled = exporting;
    const duration = s.started && Number.isFinite(audio.duration) ? audio.duration : scene.seconds;
    seek.max = duration || 1; seek.value = t;
    seek.disabled = !s.started || !!s.loading || exporting;
    seek.setAttribute("aria-valuetext", `${elapsed(t)} / ${elapsed(duration)}`);
    drawWaveform(waveform, s.waveforms[s.at], duration ? t / duration : 0);
    prev.disabled = exporting || s.at === 0; next.disabled = exporting || s.at === s.scenes.length - 1;
    make.hidden = exporting || Boolean(s.file); make.disabled = !supported || Boolean(s.loading);
    cancel.hidden = !exporting; save.hidden = share.hidden = !s.file;
    save.disabled = !!s.saving; save.textContent = s.saving ? "서버에 보관 중" : "서버 보관함에 저장";
    share.disabled = Boolean(s.file && !navigator.canShare?.({ files: [s.file] }));
    progress.hidden = !exporting; progress.value = s.exportProgress || 0;
    const format = s.file?.type.startsWith("video/mp4") ? "MP4" : "WebM";
    exportNote.textContent = s.exportError || (exporting ? "소리와 함께 만드는 중이에요. 이 화면을 유지해 주세요." : s.file ? `${format} 영상이 준비됐어요.${share.disabled ? " 저장한 뒤 다른 앱에서 공유할 수 있어요." : ""}` : !supported ? "이 브라우저는 영상 만들기를 지원하지 않아요." : "현재 장면을 소리와 함께 만들어요.") + " 서버에 보관한 영상은 같은 여행에서 함께 봅니다. 내려받거나 공유한 사본은 동의를 꺼도 남아요.";
    const cue = scene.cues.find((c) => c.start <= t && t < c.end);
    const spoken = cue?.text || "";
    if (caption.textContent !== spoken) caption.textContent = spoken;
    s.film.draw(scene, t, exporting || !audio.paused);
  };
  s.paint();
  let pointer;
  const movie = h("div", {
    className: "short-movie", tabIndex: 0, "aria-label": "가공한 쇼츠. 위아래로 넘기거나 방향키로 장면을 바꿀 수 있어요.",
    onpointerdown: (e) => { if (!s.exportJob) pointer = { x: e.clientX, y: e.clientY }; },
    onpointerup: (e) => {
      if (!pointer || s.exportJob) return;
      const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y; pointer = null;
      if (Math.abs(dy) > 55 && Math.abs(dy) > Math.abs(dx)) playing(s.at + (dy < 0 ? 1 : -1));
      else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) toggle();
    },
    onpointercancel: () => { pointer = null; },
    onkeydown: (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); playing(s.at + (e.key === "ArrowDown" ? 1 : -1)); }
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); }
      if (e.key === "Escape") closeShort();
    },
  }, s.film.canvas, caption);
  const editConversation = button("대화·자막 수정", () => { closeShort(); conversations.open(); }, "short-existing-share");
  const connectedShare = profile && trip?.participants.find((p) => p.id === s.participantId)?.profileId === profile.id
    ? button("동승자에게 장면 카드 공유", () => { const id = s.scenes[s.at].momentId; closeShort(); shares.openCompose({ momentId: id }); }, "short-existing-share") : null;
  return [h("section", { className: "short", "aria-label": "가공한 쇼츠 재생과 공유" },
    h("div", { className: "short-shell" },
      h("header", { className: "short-top" }, h("span", { className: "what" }, "추천 쇼츠"), count, mediaButton("back", "쇼츠 닫기", () => closeShort(), "short-close")),
      h("div", { className: "segs", "aria-hidden": "true" }, segs),
      movie,
      h("div", { className: "short-controls" },
        status,
        h("div", { className: "audio-timeline" }, waveform, seek),
        h("div", { className: "short-transport" }, playControl, clock, mute),
        h("div", { className: "short-pages" }, prev, h("span", {}, "위아래로 넘겨 보세요"), next),
        h("div", { className: "film-export" }, progress, actions, exportNote), h("div", { className: "short-options" }, editConversation, connectedShare),
      ),
    ),
  )];
}

function render() {
  boarding.sync(trip);
  studio.sync();
  scenes.sync();
  shares.sync();
  captions.sync();
  records.sync();
  conversations.sync();
  todos.sync();
  places.sync();
  stale = false;
  const me = trip?.participants.find((p) => p.id === myId());
  if (me) store("trip", trip.code); // 처음 화면의 '지난 여행 열기'
  else if (failed && store("trip") === code()) store("trip", null);
  // 숏폼은 기록에 동의한 사람만 본다. 보는 사이 여행이 사라지거나 동의가 꺼지면(세대가 오름) 닫고 받은 소리를 버린다.
  const gone = short && (failed || trip?.code !== short.code ? "여행을 더 볼 수 없어 숏폼을 닫았어요." : !me?.consent || trip.generation !== short.generation ? "기록 동의가 바뀌어 숏폼을 닫았어요." : "");
  if (gone) return closeShort(gone);
  const ownProfile = profile && me?.profileId === profile.id;
  const firstVisit = !location.hash && !store("profile") && !vehicleView && !boarding.pending();
  const page = short ? "short" : location.hash === "#me" ? "profile" : location.hash === "#start" || firstVisit ? "onboarding" : !code() ? "home" : failed ? "missing" : !trip ? "loading" : !me ? "notHere" : (asking(me) || reading) && !ownProfile ? "consent" : "trip";
  const view = { short: shortView, profile: profileView, onboarding: () => onboarding.view(), home, missing, loading, notHere, consent: () => consentView(me), trip: () => tripView(me) }[page]();
  app.classList.toggle("home-view", page === "home");
  app.classList.toggle("onboarding-view", page === "onboarding");
  app.classList.toggle("ride-view", page === "trip");
  app.replaceChildren(...view.flat().filter(Boolean));
  if (!short && me && ownProfile && myToken() && (asking(me) || reading)) boarding.openConsent(trip, me, myToken());
  if (conversationPending && me && !asking(me) && !reading) { conversationPending = false; conversations.open(); }
  if (failed || (trip && !me)) conversationPending = false;
  if (location.hash !== "#me" && !savingProfile && boarding.pending()) boarding.resume();
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

addEventListener("hashchange", () => (boarding.close(), location.hash !== "#start" && onboarding.close(), openingShort?.abort(), (reading = false), short && closeShort(), location.hash === "#me" && fillDraft(), (trip = null), (failed = ""), refresh(true)));
app.addEventListener("focusout", () => setTimeout(() => stale && !typing() && render())); // 입력이 끝나면 밀린 변경을 그린다
setInterval(refresh, 2000); // ponytail: 2초마다 묻는다(바뀐 게 없으면 304). 지연이 문제가 되면 SSE로 바꾼다.
render();
const refreshConfig = () => api("GET", "/config").then((c) => {
  googleId = c.googleClientId ?? "";
  if (typing()) stale = true;
  else render();
}, () => {});
refreshConfig(); // 못 받으면 구글 단추를 숨기고 재연결 때 다시 읽습니다.
addEventListener("online", () => { refreshConfig(); refresh(); });
const back = location.pathname === "/oauth/google/callback" && (await googleBack());
await loadProfile();
boarding.resume();
fillDraft();
if (back) Object.assign(pdraft, back); // 구글에서 실패·취소로 돌아오면 쓰던 입력을 되돌린다
await refresh(true);
const initialView = new URLSearchParams(location.search).get("view");
if (initialView === "shorts" && trip) launchShort();
else if (initialView === "conversation" && trip) conversations.open();
navigator.serviceWorker?.register("/sw.js").catch(() => {}); // 홈 화면 설치와 끊겼을 때의 마지막 화면(T6)
// 처음 설치되는 방문에서는 여행을 워커가 맡기 전에 읽었고 그 뒤 폴링은 304라 캐시에 여행이 없다.
// 워커가 이 화면을 맡는 순간 한 번 더 읽어 끊겼을 때 보일 여행을 남긴다.
navigator.serviceWorker?.addEventListener("controllerchange", () => refresh(true));
