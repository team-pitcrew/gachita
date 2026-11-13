// 가치타 모바일 화면(gachita.mangowhois.ai). 빌드 없이 브라우저가 그대로 읽는다.
// 주소: /#코드는 이 폰이 들어간 여행, /#me는 내 프로필. 여행에는 차가 이 폰의 동승 연결 QR을 읽어 넣는다(#71, 11/14).
// 이 폰이 누구인지(프로필 토큰, 여행마다 참가자 id와 토큰)는 localStorage에 둔다. 폰에서는 수음하지 않는다.
// 사용자가 쓴 글은 textContent로만 넣는다(innerHTML 금지).

import { SEATS, SEAT, WHEN, REQ, CLOSED, api, h, toast } from "/shared.js";

const TRIP = {
  boarding: ["탑승 중", "모두 타면 운전자가 출발을 눌러요."],
  driving: ["주행 중", "부탁은 아래 단추로 언제든 남길 수 있어요."],
  parked: ["주차 완료", "이번 주행의 기록을 마감했어요."],
  ended: ["여행 종료", "이 여행은 만든 뒤 48시간까지 볼 수 있어요."],
};
const NEXT_TRIP = { boarding: ["출발", "driving"], driving: ["주차", "parked"], parked: ["여행 끝내기", "ended"] };
const ONLY_HERE = "이 폰에서 참가한 사람만 켤 수 있어요.";
// 켜져 있던 동의를 끄면 서버가 동의 세대를 올려 그 여행의 받아 적은 글을 모두 지운다(ADR-0007). 누르기 전에 알린다.
const OFF_WIPES = "동의를 끄면 기록이 멈추고, 이 여행에서 지금까지 받아 적은 글이 모두 지워져요. 끌까요?";
// 기록 동의 문구. 마지막 줄 앞까지는 #156에서 고친 docs/api/voice.md '동의 문구'와 글자까지 같다(voice.md는 api-media가 T75 서버 PR에서 고침).
// 마지막 줄은 서버 동작(켜져 있던 동의를 끄면 동의 세대가 올라 그 여행의 받아 적은 글을 지움, ADR-0007)을 알린다.
const CONSENT = [
  "대화는 차에서 받아 적힙니다.",
  "녹음은 기본 꺼져 있고, 참가자 모두가 동의할 때만 켭니다.",
  "받아 적은 글은 여행 기록과 함께 여행을 만든 뒤 48시간이 지나면 지워지고, 그 뒤엔 사람이 장면으로 남긴 것만 남습니다.",
  "장면을 고를 수 있게 소리는 48시간 동안 차 안에 암호화해 두었다가 지웁니다.",
  "장면으로 남기면 그 구간의 소리가 서버로 올라갑니다.",
  "그 소리는 자막을 바로잡으려고 외부 음성 인식 서버로 보내 다시 받아 적고, 그 서버에는 남기지 않습니다.",
  "누가 말했는지 가리려고 말소리가 잠시 서버로 갔다가 저장되지 않고 지워집니다.",
  "받아 적은 글과 장면은 참가자가 요청하면 바로 지울 수 있습니다.",
  "동의는 여행 중 언제든 끌 수 있고, 끄면 이 여행에서 그때까지 받아 적은 글이 모두 지워집니다.",
];
// 프로필 캐릭터. 사진이 없을 때 이 그림으로 보인다(목록 고정은 T46).
const CHARACTERS = [
  ["bunny", "🐰", "토끼"],
  ["bear", "🐻", "곰"],
  ["cat", "🐱", "고양이"],
  ["dog", "🐶", "강아지"],
  ["fox", "🦊", "여우"],
  ["penguin", "🐧", "펭귄"],
];
const FACE = Object.fromEntries(CHARACTERS.map(([v, face]) => [v, face]));
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
const code = () => (location.hash === "#me" ? "" : location.hash.slice(1).toUpperCase());
// 이 폰이 기억하는 것. store(키)는 읽기, store(키, 값)은 쓰기, store(키, null)은 지우기.
const store = (key, value) =>
  value === undefined ? localStorage.getItem(`gachita:${key}`) : value === null ? localStorage.removeItem(`gachita:${key}`) : localStorage.setItem(`gachita:${key}`, value);
const myId = () => store(code());
const myToken = () => store(`${code()}:token`); // 참가자 토큰: 동의 켜기와 음성 경로의 인증(T68, ADR-0007)

let trip = null; // 서버에서 받은 여행
let profile = null; // 이 폰의 프로필(GET /api/profiles/me). 토큰은 store("profile")
let photo = ""; // 내 사진(object URL)
const pdraft = { name: "", character: "", photo: null, preview: "", consentDefault: false };
let failed = ""; // 여행을 불러오지 못한 이유
let offline = false;
let stale = false; // 입력 중에 온 변경은 입력이 끝난 뒤 그린다

// 여행 경로는 토큰 없이, 프로필 경로(mine)는 이 폰의 프로필 토큰으로.
const call = (method, path, body) => api(method, `/trips${path}`, body);
const mine = (method, path, body) => api(method, path, body, store("profile"));

// 프로필 다시 읽기. 지워졌거나 모르는 토큰이면 이 폰에서도 잊는다.
async function loadProfile() {
  profile = null;
  URL.revokeObjectURL(photo);
  photo = "";
  if (!store("profile")) return;
  try {
    profile = await mine("GET", "/profiles/me");
  } catch (e) {
    if (e.status === 401) store("profile", null); // 서버가 모르는 토큰일 때만 잊는다(서버가 잠시 멈춘 것과 구분)
    return;
  }
  if (profile.hasPhoto) {
    const res = await fetch("/api/profiles/me/photo", { headers: { authorization: `Bearer ${store("profile")}` } }).catch(() => null);
    if (res?.ok) photo = URL.createObjectURL(await res.blob());
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
  const p = await api("POST", `/trips/${c}/participants`, {}, store("profile"));
  store(c, p.id);
  store(`${c}:token`, p.token);
  return true;
}

const typing = () => app.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName);

async function refresh(force) {
  if (failed && !force) return;
  if (code()) {
    try {
      const next = await call("GET", `/${code()}${trip && !force ? `?v=${trip.version}` : ""}`);
      offline = false;
      if (next) (trip = next), (failed = "");
      // 못 받았으면 다음 폴링에서 다시 한다. 그동안은 참가 화면이 보이고, 거기서 참가해도 같은 참가자로 들어간다.
      const claimed = await claim().catch(() => false);
      if (!next && !claimed) return;
    } catch (e) {
      if (e.status === 0) {
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

// 얼굴: 사진, 없으면 캐릭터, 없으면 이름 첫 글자
const avatar = (p, src) => h("span", { className: "avatar", "aria-hidden": "true" }, src ? h("img", { src, alt: "" }) : FACE[p?.character] ?? (p?.name || "?").slice(0, 1));

function fillDraft() {
  URL.revokeObjectURL(pdraft.preview);
  Object.assign(pdraft, { name: profile?.name ?? "", character: profile?.character ?? "", photo: null, preview: "", consentDefault: profile?.consentDefault ?? false });
}

// 프로필 칸: 이름이나 별명, 사진이나 캐릭터. full이면 기록 동의 기본값까지.
function profileFields(full) {
  const pick = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pdraft.photo = await shrink(file);
    } catch {
      return toast("이 사진은 읽지 못했어요. 다른 사진을 골라 주세요.");
    }
    URL.revokeObjectURL(pdraft.preview);
    pdraft.preview = URL.createObjectURL(pdraft.photo);
    face();
  };
  // 얼굴만 다시 그린다(화면 전체를 다시 그리면 고른 파일 이름이 지워져 보인다)
  const face = () => app.querySelector(".face .avatar")?.replaceWith(avatar({ name: pdraft.name, character: pdraft.character }, pdraft.preview || photo));
  return [
    h("label", { className: "field" }, h("span", {}, "이름 또는 별명"), h("input", { value: pdraft.name, required: true, maxLength: 20, autocomplete: "nickname", oninput: (e) => (pdraft.name = e.target.value) })),
    h(
      "div",
      { className: "card face" },
      avatar({ name: pdraft.name, character: pdraft.character }, pdraft.preview || photo),
      h("label", { className: "field grow" }, h("span", {}, "사진(고르면 캐릭터 대신 보여요)"), h("input", { type: "file", accept: "image/*", onchange: pick })),
    ),
    chipGroup("캐릭터", "character", CHARACTERS.map(([v, face, label]) => [v, `${face} ${label}`]), pdraft.character, (v) => ((pdraft.character = v), face())),
    full &&
      h("label", { className: "chip" }, h("input", { type: "checkbox", checked: pdraft.consentDefault, onchange: (e) => (pdraft.consentDefault = e.target.checked) }), "참가할 때 대화 기록 동의를 미리 켜 둠"),
  ];
}

const saveProfile = () =>
  act(async () => {
    const fresh = !store("profile");
    const body = {
      name: pdraft.name.trim(),
      consentDefault: pdraft.consentDefault,
      ...(pdraft.character && { character: pdraft.character }),
    };
    if (fresh) {
      store("profile", (await api("POST", "/profiles", { ...body, device: "폰" })).token);
      await loadProfile(); // 사진 올리기가 실패해도 다음 저장은 이 프로필을 고친다
    } else await mine("PATCH", "/profiles/me", body);
    if (pdraft.photo) await mine("PUT", "/profiles/me/photo", pdraft.photo);
    await loadProfile();
    toast("프로필을 저장했어요.");
    location.hash = "";
  });

function profileView() {
  const remove = () =>
    confirm("프로필과 남긴 장면 앨범까지 지워져요. 지울까요?") &&
    act(async () => {
      await mine("DELETE", "/profiles/me");
      store("profile", null);
      await loadProfile();
      location.hash = "";
    });
  return [
    header(button("이전", () => (location.hash = ""), "plain"), h("span", { className: "meta" }, profile ? "내 프로필" : "프로필 만들기")),
    h("h1", {}, profile ? "내 프로필" : "나를 소개해 주세요"),
    h("p", { className: "sub" }, "같이 타는 사람들에게 보이는 이름과 얼굴이에요. 이 폰에서만 이 프로필로 들어가요."),
    form(saveProfile, ...profileFields(true), bar(h("button", { className: "primary" }, "저장"))),
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
  const last = store("trip"); // 이 폰이 마지막으로 들어간 여행
  return [
    header(h("span", { className: "brand" }, "가치타")),
    h("h1", {}, "같이 탈 준비를 할까요?"),
    h("p", { className: "sub" }, "차가 이 폰의 동승 연결 QR을 읽으면 여행에 들어가요. 부탁과 기록은 그다음에 여기서 챙겨요."),
    profile
      ? h(
          "section",
          { className: "card face" },
          avatar(profile, photo),
          h("div", { className: "grow" }, h("p", { className: "what" }, `${profile.name} 님`), h("p", { className: "meta" }, "차에 탈 때 동승 연결 QR을 띄우면 돼요.")),
          button("프로필", () => (location.hash = "me"), "plain"),
        )
      : h(
          "section",
          { className: "card" },
          h("p", { className: "what" }, "프로필을 만들어 두세요"),
          h("p", { className: "meta" }, "이름과 캐릭터를 정하면 동승 연결 QR을 띄울 수 있어요."),
          button("프로필 만들기", () => (location.hash = "me")),
        ),
    last && bar(button("지난 여행 열기", () => (location.hash = last), "primary")),
  ];
}

const loading = () => [header(h("span", { className: "brand" }, "가치타")), h("div", { className: "skeleton" }), h("div", { className: "skeleton" })];

const missing = () => [
  header(h("span", { className: "brand" }, "가치타")),
  h("h1", {}, "여행을 찾지 못했어요"),
  h("p", { className: "sub" }, "끝났거나 만든 지 48시간이 지나 지워졌어요."),
  bar(button("처음으로", () => (location.hash = ""), "primary")),
];

// 이 폰이 들어가지 않은 여행. 여행 코드로는 들어갈 수 없고, 차가 동승 연결 QR을 읽어 넣는다(#71).
const notHere = () => [
  header(h("span", { className: "brand" }, "가치타")),
  h("h1", {}, "이 폰은 이 여행에 없어요"),
  h("p", { className: "sub" }, "차 화면의 '동승자 연결'에서 이 폰의 동승 연결 QR을 읽으면 들어갈 수 있어요."),
  bar(button("처음으로", () => (location.hash = ""), "primary")),
];

// 차가 넣어 준 뒤 한 번 묻는 기록 동의. 켜기는 이 폰의 참가자 토큰으로만 된다(T68). 고른 뒤로는 여행 화면에서 바꾼다.
const asking = (me) => !me.consent && !store(`${trip.code}:asked`);
function consentView(me) {
  const decide = (on) => () => (store(`${trip.code}:asked`, "1"), on ? consentOn(me) : render());
  return [
    header(h("span", { className: "brand" }, "가치타"), h("span", { className: "meta" }, trip.title || "가치타 여행")),
    h("h1", {}, "이동 중 대화를 기록해도 될까요?"),
    h("p", { className: "sub" }, `${SEAT[me.seat] ?? "자리"}에 앉은 ${me.name} 님으로 들어왔어요. 도착한 뒤 재미있던 장면을 클립으로 남기는 데 써요.`),
    h("ul", { className: "card" }, CONSENT.map((line) => h("li", {}, line))),
    bar(myToken() ? button("동의하고 시작", decide(true), "primary") : h("p", { className: "meta" }, ONLY_HERE), button("동의하지 않고 시작", decide(false))),
  ];
}

// 켜기는 본인의 참가자 토큰으로만 된다(끄기는 누구나). 서버가 이 폰의 토큰을 잊었으면(다른 곳에서 다섯 번 넘게
// 다시 참가) 프로필로 들어온 사람은 다시 참가해 새 토큰으로 한 번 더 켠다. 손님은 다시 받을 길이 없다.
const consentOn = (me) =>
  act(async () => {
    const on = () => api("PATCH", `/trips/${trip.code}/participants/${me.id}`, { consent: true }, myToken());
    await on()
      .catch(async (e) => {
        if (e.status !== 401 || !profile || me.profileId !== profile.id) throw e;
        store(`${trip.code}:token`, null);
        await claim();
        await on();
      })
      .catch((e) => {
        throw e.status === 401 || e.status === 403 ? new Error(ONLY_HERE) : e;
      });
  });

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
    header(h("span", { className: "brand" }, "가치타"), h("span", { className: "meta" }, trip.title || "가치타 여행")),
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
      h("h2", {}, `일행 ${trip.participants.length}명`),
      car(([id, label]) => {
        const p = seated[id];
        return h("div", { className: `chip${p ? "" : " empty"}${p?.id === me.id ? " me" : ""}` }, p ? p.name : "빈자리", h("small", {}, label));
      }, "car readonly"),
    ),
    h(
      "section",
      { className: "card" },
      h("div", {}, h("p", { className: "what" }, "내 자리"), h("p", { className: "meta" }, SEAT[me.seat])),
      h(
        "div",
        { className: "between" },
        h("div", {}, h("p", { className: "what" }, "대화 기록 동의"), h("p", { className: "meta" }, me.consent ? "동의했어요." : "동의하지 않았어요.")),
        me.consent ? button("동의 끄기", () => confirm(OFF_WIPES) && patch(`/participants/${me.id}`, { consent: false })()) : myToken() ? button("동의 켜기", () => consentOn(me)) : h("p", { className: "meta" }, ONLY_HERE),
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
  if (me) store("trip", trip.code); // 처음 화면의 '지난 여행 열기'
  else if (failed && store("trip") === code()) store("trip", null);
  const view = location.hash === "#me" ? profileView() : !code() ? home() : failed ? missing() : !trip ? loading() : !me ? notHere() : asking(me) ? consentView(me) : tripView(me);
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

addEventListener("hashchange", () => (location.hash === "#me" && fillDraft(), (trip = null), (failed = ""), refresh(true)));
app.addEventListener("focusout", () => setTimeout(() => stale && !typing() && render())); // 입력이 끝나면 밀린 변경을 그린다
setInterval(refresh, 2000); // ponytail: 2초마다 묻는다(바뀐 게 없으면 304). 지연이 문제가 되면 SSE로 바꾼다.
render();
await loadProfile();
fillDraft();
refresh(true);
navigator.serviceWorker?.register("/sw.js").catch(() => {}); // 홈 화면 설치와 끊겼을 때의 마지막 화면(T6)
// 처음 설치되는 방문에서는 여행을 워커가 맡기 전에 읽었고 그 뒤 폴링은 304라 캐시에 여행이 없다.
// 워커가 이 화면을 맡는 순간 한 번 더 읽어 끊겼을 때 보일 여행을 남긴다.
navigator.serviceWorker?.addEventListener("controllerchange", () => refresh(true));
