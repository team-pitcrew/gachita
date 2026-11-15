// 계정·온보딩(T142, 최종 시안 P01–P08, 피그마 2004:57): 시작 → 계정 만들기·로그인 → 기록 동의 → 내 프로필 → 사진 → 15초 목소리 → 등록 완료.
// 서버 계약: POST /api/accounts·/api/sessions, PATCH /api/profiles/me(consent·name·character), PUT /api/profiles/me/photo,
// POST /api/profiles/me/voice(JSON 값, ADR-0023). 목소리는 이 기기에서 값(112차원)으로 바꿔 값만 올린다 — 소리는 폰을 떠나지 않는다.
// 계정 동의가 켜져 있지 않으면 마이크를 열지 않는다. 사용자가 쓴 글은 textContent로만 넣는다.
import { api, h, toast } from "./shared.js";
import { appBar } from "./ride.js";
import { CHARACTER_TYPES, characterImage, characterKey } from "./short-film.js";
import { MIN_SECONDS, startVoice, voiceBars, VOICE_SECONDS, WAVE_BARS as BARS } from "./voice-meter.js";

export { MIN_SECONDS, VOICE_SECONDS };
// 시안 P04의 앞 네 캐릭터(안경·힐링·캡모자·기본) 순서로 두고 나머지를 잇는다.
const LABEL = Object.fromEntries(CHARACTER_TYPES);
const ORDER = ["glasses", "healing", "cap", "basic", ...CHARACTER_TYPES.map(([key]) => key).filter((key) => !["glasses", "healing", "cap", "basic"].includes(key))];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 처음 열 때의 단계. 토큰이 없으면 시작, 이메일 계정이 없으면(기기 프로필) 계정 만들기, 동의 전이면 동의, 그 밖은 프로필부터 다시.
export function firstStep(profile, hasToken) {
  if (!hasToken) return "welcome";
  if (!profile?.email) return "signup";
  if (!profile.consent) return "consent";
  return "profile";
}

// 로그인·가입 뒤 이어 갈 단계: 동의가 없으면 동의, 목소리가 없으면 프로필, 다 있으면 끝(null).
export function nextAfterAccount(profile, mode) {
  if (!profile?.consent) return "consent";
  if (mode === "login" && profile.hasVoice) return null;
  return "profile";
}

// 받침이 있으면 '이야', 없으면 '야'(시안: '나는 민준이야'). 한글이 아니면 '이야'.
export function callName(name) {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  return `${name.trim()}${code >= 0 && code < 11172 && code % 28 === 0 ? "야" : "이야"}`;
}

// 가입 때 서버가 이름을 꼭 받으므로 이메일 앞부분을 임시 이름으로 보낸다. 다음 단계(P04)에서 바꾼다.
export const provisionalName = (email) => (email.split("@")[0] || "나").slice(0, 20);

// 가입 때 붙인 임시 이름(이메일 앞부분)을 아직 그대로 쓰는지. P04에서 이름을 받기 전의 계정이다.
export const provisionalOnly = (profile) => Boolean(profile?.email) && profile.name === provisionalName(profile.email);

// 이메일 계정이 온보딩을 마쳤는지: 계정 동의, 직접 정한 이름, 목소리(첫 프로필은 목소리 필수). 초대 링크로 그룹에 들어가기 전에 본다.
export const accountReady = (profile) => Boolean(profile?.consent && profile.hasVoice && !provisionalOnly(profile));

// 서버 오류를 화면 문장으로. 로그인 실패는 이메일과 비밀번호 중 무엇이 틀렸는지 말하지 않는다(서버와 같음).
export function accountError(e, mode) {
  if (e.status === 0) return "연결이 끊겨서 보내지 못했어요.";
  if (e.status === 409) return "이미 가입한 이메일이에요. 로그인해 주세요.";
  if (e.status === 401) return mode === "login" ? "이메일 또는 비밀번호가 맞지 않아요." : "이 폰의 프로필을 확인하지 못했어요. 다시 해 주세요.";
  if (e.status === 400 && /password/.test(e.message)) return "비밀번호는 8~72자로 적어 주세요.";
  if (e.status === 400 && /email/.test(e.message)) return "이메일 주소를 확인해 주세요.";
  return e.message;
}

export function createOnboarding({ getProfile, getToken, setToken, loadProfile, getPhoto, consentText, render, onBegin = () => {}, onDone, onFamily, onOther, hasInvite = () => false, isOnline = () => navigator.onLine !== false }) {
  let step = null; // null이면 view()가 firstStep으로 정한다
  let mode = "signup";
  const draft = { email: "", password: "", name: "", character: "", photo: null, preview: "" };
  let busy = false;
  let rec = null; // 녹음 중·끝난 녹음(voice-meter.js startVoice)
  let mic = ""; // 마이크를 열지 못한 이유

  const me = () => getProfile();
  const call = (method, path, body) => api(method, path, body, getToken());
  const go = (next) => { step = next; render(); };
  const fill = () => {
    const p = me();
    draft.name = provisionalOnly(p) ? "" : p?.name ?? ""; // 임시 이름(이메일 앞부분)은 채워 두지 않는다 — P04에서 직접 적게
    draft.character = characterKey(p?.character || "basic").replace(/-small$/, "");
  };
  const work = async (fn) => {
    if (busy) return;
    busy = true; render();
    try { await fn(); } catch (e) { toast(e.status === 0 ? "연결이 끊겨서 보내지 못했어요." : e.message); } finally { busy = false; render(); }
  };

  // ---- 화면 조각(시안 P 토큰: 카드 반경 24, 컨트롤 16, Display 28 / Headline 19 / Label 15) ----
  const top = () => appBar({ online: isOnline(), onHome: () => { close(); onDone(); } });
  const title = (text, sub) => h("div", { className: "ob-title" }, h("h1", {}, text), sub && h("p", { className: "sub" }, sub));
  const card = (heading, detail, { soft, face, onclick } = {}) => h(onclick ? "button" : "div", { className: `ob-card${soft ? " soft" : ""}${face ? " with-face" : ""}`, ...(onclick && { type: "button", onclick }) },
    face && h("span", { className: "ob-face", "aria-hidden": "true" }, face),
    h("span", { className: "ob-copy" }, h("strong", {}, heading), detail && h("span", {}, detail)));
  const note = (text) => h("p", { className: "ob-note" }, text);
  const bottom = (...buttons) => h("div", { className: "bar" }, h("div", {}, buttons));
  const primary = (label, onclick, disabled = false) => h("button", { type: "button", className: "primary", disabled: disabled || busy, onclick }, label);
  const secondary = (label, onclick, disabled = false) => h("button", { type: "button", className: "secondary", disabled: disabled || busy, onclick }, label);
  const avatar = () => draft.preview || getPhoto()
    ? h("span", { className: "ob-avatar" }, h("img", { src: draft.preview || getPhoto(), alt: "" }))
    : h("span", { className: "ob-avatar" }, characterImage(draft.character || me()?.character || "glasses"));
  const field = (label, input) => h("label", { className: "field ob-field" }, h("span", {}, label), input);
  // 녹음 전은 시안 모양(모두 켬), 녹음 중·뒤는 실제 들어온 소리 크기(voice-meter.js). 앞으로 칸은 시안처럼 옅은 막대.
  const wave = (meter) => voiceBars(meter, { className: "ob-wave", slots: BARS.length, ready: BARS, min: 11, max: 62, upcoming: BARS });
  const clock = (s) => `00:${String(Math.min(99, Math.floor(s))).padStart(2, "0")}`;

  // P01(최신 시안 2005:4799): '주행 중 / 주행 후' 두 줄과 콘텐츠 기록 보관함 카드 한 장(Archive / galleryPhone, 보여 주기용 그림).
  const moment = (when, line) => h("div", {}, h("span", {}, when), h("strong", {}, line));
  const welcome = () => [top(),
    title("함께 탄 순간을 오래", "운전할 때는 부탁을, 여행 후에는 추억을."),
    h("div", { className: "ob-welcome" },
      h("div", { className: "ob-moments" }, moment("주행 중", "부탁은 놓치지 않도록"), moment("주행 후", "즐거운 이야기는 오래도록")),
      h("div", { className: "ob-archive", "aria-hidden": "true" },
        h("small", {}, "11.14  강릉 가족 여행"),
        h("strong", {}, "아빠, 아까부터", h("br"), "바다 보이는데?"),
        h("div", { className: "ob-archive-cast" }, h("img", { src: "/brand/welcome-dad.png", alt: "" }), h("img", { src: "/brand/welcome-seojun.png", alt: "" })),
        h("p", {}, "서준의 한마디에 모두 웃음"),
        h("div", { className: "ob-archive-foot" }, h("span", {}, "가치타"), h("span", {}, "▶ 0:32")))),
    bottom(primary("가치타 시작하기", () => { step = "signup"; onBegin(); render(); }))];

  // P02. '이미 계정이 있나요?'를 누르면 같은 칸으로 로그인한다. 이 폰에 기기 프로필이 있으면 그 프로필에 계정을 붙인다(구글 연결 그대로).
  const signup = () => {
    const login = mode === "login";
    const submit = () => {
      const email = draft.email.trim();
      if (!EMAIL.test(email)) return toast("이메일 주소를 확인해 주세요.");
      if ([...draft.password].length < 8 || [...draft.password].length > 72) return toast("비밀번호는 8~72자로 적어 주세요.");
      work(async () => {
        let res;
        try {
          res = login
            ? await api("POST", "/sessions", { email, password: draft.password, device: "폰" })
            : await api("POST", "/accounts", { email, password: draft.password, device: "폰", ...(!getToken() && { name: provisionalName(email) }) }, getToken() || undefined);
        } catch (e) {
          if (e.status === 409 && !login) mode = "login";
          throw new Error(accountError(e, mode));
        }
        if (res.token) setToken(res.token);
        draft.password = "";
        await loadProfile();
        fill();
        const next = nextAfterAccount(me(), mode);
        if (next) go(next); else { close(); onDone(); }
      });
    };
    return [top(),
      title(login ? "내 계정으로 로그인" : "내 계정 만들기", login ? "차와 다른 폰에서 만든 같은 계정으로 들어와요." : "이 계정으로 차량과 폰을 함께 사용해요."),
      h("form", { className: "ob-form", onsubmit: (e) => { e.preventDefault(); submit(); } },
        field("이메일", h("input", { type: "email", value: draft.email, required: true, autocomplete: "email", inputMode: "email", placeholder: "minjun@example.com", oninput: (e) => (draft.email = e.target.value) })),
        field("비밀번호", h("input", { type: "password", value: draft.password, required: true, minLength: 8, maxLength: 72, autocomplete: login ? "current-password" : "new-password", placeholder: "8자 이상", oninput: (e) => (draft.password = e.target.value) })),
        h("button", { type: "submit", hidden: true, tabIndex: -1 })),
      card(login ? "처음이신가요?" : "이미 계정이 있나요?", login ? "새 계정을 만들어 시작해요." : "같은 계정으로 로그인해 기록을 불러와요.", { onclick: () => { mode = login ? "signup" : "login"; render(); } }),
      h("button", { type: "button", className: "plain ob-other", onclick: onOther }, "이메일 없이 프로필 만들기 · 구글로 계속"),
      bottom(primary(busy ? "확인 중" : login ? "로그인하고 계속" : "가입하고 계속", submit))];
  };

  // P03. 세 항목을 한 번에. 아래 '동의 문구 전체'는 여행 기록 동의와 같은 배열(app.js CONSENT)을 그대로 보인다 —
  // '누가 말했는지…말소리가 잠시 서버로…' 문장(ADR-0023 8절)을 빼지 않고, 문구를 따로 베끼지 않는다.
  const consent = () => [top(),
    title("우리의 대화를 남기기 전에", "아래 내용을 확인하고 한 번에 동의해 주세요."),
    card("탑승 시 대화 자동 기록", "가족 그룹 연결 시 시작 / 기록 상태 표시와 일시정지 제공"),
    card("서버 전송과 콘텐츠 생성", "음성과 전사록 업로드, 요약과 편집에 사용"),
    card("목소리 등록과 발화자 식별", "등록한 음성 특징으로 말하는 사람 구분"),
    note("함께 타는 성인은 직접 동의하고, 아이의 프로필과 녹음은 보호자가 관리해요."),
    h("details", { className: "ob-terms" }, h("summary", {}, "동의 문구 전체 보기"), h("ul", {}, consentText.map((line) => h("li", {}, line)))),
    bottom(primary(busy ? "저장 중" : "동의하고 계속", () => work(async () => {
      await call("PATCH", "/profiles/me", { consent: true });
      await loadProfile();
      fill();
      step = "profile";
    })))];

  const saveProfile = async () => {
    const name = draft.name.trim();
    if (!name) throw new Error("함께 타는 사람들에게 보일 이름을 적어 주세요.");
    await call("PATCH", "/profiles/me", { name, character: draft.character });
    if (draft.photo) {
      await call("PUT", "/profiles/me/photo", draft.photo);
      draft.photo = null;
    }
    await loadProfile();
  };

  // P04. 단계 표시 01 프로필 → 02 목소리 → 03 가족.
  const profile = () => [top(),
    h("div", { className: "ob-title" }, h("h1", {}, "나를 소개해 주세요"),
      h("p", { className: "ob-steps" }, "01 프로필", h("span", { "aria-hidden": "true" }, "→"), "02 목소리", h("span", { "aria-hidden": "true" }, "→"), "03 가족")),
    field("이름 또는 별명", h("input", { value: draft.name, required: true, maxLength: 20, autocomplete: "nickname", placeholder: "민준", oninput: (e) => (draft.name = e.target.value) })),
    h("fieldset", { className: "ob-chars" }, h("legend", {}, "내 캐릭터"),
      h("div", {}, ORDER.map((key) => [key, LABEL[key]]).map(([key, label]) => h("label", { className: "ob-char" },
        h("input", { type: "radio", name: "ob-character", value: key, checked: key === draft.character, "aria-label": label, onchange: () => { draft.character = key; } }),
        characterImage(key))))),
    secondary("내 사진으로 바꾸기", () => go("photo")),
    note("캐릭터와 이름은 같은 계정의 차량과 폰에 함께 저장돼요."),
    bottom(primary(busy ? "저장 중" : "목소리 등록하기", () => work(async () => { await saveProfile(); step = "voice"; })))];

  // P05. 사진은 폰에서 다시 그려 올린다(위치 같은 덧붙은 정보가 빠지고 1 MB 안으로). 고르지 않으면 캐릭터로 계속.
  const photo = () => {
    const input = h("input", { type: "file", accept: "image/*", className: "visually-hidden", "aria-label": "프로필 사진 선택", onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const small = await shrink(file);
        URL.revokeObjectURL(draft.preview);
        draft.photo = small;
        draft.preview = URL.createObjectURL(small);
        render();
      } catch { toast("이 사진은 읽지 못했어요. 다른 사진을 골라 주세요."); }
    } });
    return [top(),
      title("프로필 사진", "사진 대신 캐릭터도 언제든 선택할 수 있어요."),
      h("div", { className: "ob-portrait" }, draft.preview || getPhoto() ? h("img", { src: draft.preview || getPhoto(), alt: "고른 프로필 사진" }) : characterImage(draft.character)),
      card("내 사진 선택", "촬영 또는 사진 보관함에서 가져오기", { onclick: () => input.click() }), input,
      h("p", { className: "ob-note body" }, "공유 콘텐츠에는 캐릭터를 기본으로 사용해요."),
      bottom(primary(busy ? "저장 중" : draft.photo ? "사진으로 계속" : "캐릭터로 계속", () => work(async () => { await saveProfile(); step = "voice"; })))];
  };

  // P06
  const voice = () => [top(),
    title("15초만 들려주세요", "02 목소리 등록 / 조용한 곳에서 혼자 읽어 주세요."),
    h("div", { className: "ob-script" }, h("strong", {}, `“안녕, 나는 ${callName(me()?.name || draft.name || "나")}.`), h("span", {}, "우리 가족과 함께 여행하는 시간이 좋아. 오늘은 바다를 보러 가고, 맛있는 것도 먹을 거야.”")),
    h("div", { className: "ob-meter" }, h("span", {}, mic || "목소리 등록 준비"), wave(null), h("p", {}, h("span", {}, "00:00"), h("span", {}, clock(VOICE_SECONDS)))),
    note("등록한 목소리로 차량에서 발화자를 구분해요. 소리는 이 폰에서 값으로 바뀌고, 값만 서버에 저장돼요."),
    bottom(primary("녹음 시작", startRecording))];

  // P07. 15초가 차면 저절로 멈춘다. '녹음 완료'는 5초부터 눌린다(눌러도 멈추고 바로 등록).
  const recording = () => {
    const s = seconds();
    const done = rec?.done;
    const late = s >= 7;
    return [top(),
      title(done ? "녹음을 마쳤어요" : "목소리를 듣고 있어요", done ? "‘녹음 완료’를 누르면 등록해요." : "주변 사람은 잠시 조용히 기다려 주세요."),
      h("div", { className: "ob-script" }, late
        ? [h("strong", {}, "“함께 타는 순간을 오래 기억하고 싶어.”"), h("span", {}, "평소 말하는 목소리로 이어 읽어 주세요.")]
        : [h("strong", {}, `“안녕, 나는 ${callName(me()?.name || draft.name || "나")}.`), h("span", {}, "우리 가족과 함께 여행하는 시간이 좋아. 오늘은 바다를 보러 가고, 맛있는 것도 먹을 거야.”")]),
      h("div", { className: "ob-meter" }, h("span", { role: "status" }, `${done ? "녹음 끝" : "녹음 중"}  ${Math.floor(Math.min(s, VOICE_SECONDS))} / ${VOICE_SECONDS}초`), wave(rec),
        h("p", {}, h("span", {}, clock(s)), h("span", {}, clock(VOICE_SECONDS)))),
      // '다시 녹음'은 준비 화면(P06)으로 돌아간다(시안 P07 → P06). 마이크는 놓고 모은 소리는 버린다.
      bottom(secondary("다시 녹음", () => { rec?.cancel(); rec = null; go("voice"); }), primary(busy ? "등록 중" : "녹음 완료", submitVoice, s < MIN_SECONDS))];
  };

  // P08. 시안의 '민준 / 아빠'는 가족 안 역할인데 그 값은 그룹(F2)에 있다. 여기서는 이름만 쓴다.
  const done = () => {
    const p = me();
    return [top(),
      title(`${p?.name ?? draft.name}님의 목소리 등록 완료`, "차량과 폰에서 같은 프로필을 사용해요."),
      card(p?.name ?? draft.name, p?.hasVoice ? "캐릭터와 음성 특징 저장 완료" : "캐릭터 저장 완료", { soft: true, face: avatar() }),
      // 초대 링크로 들어왔으면 새 가족을 만들지 않고 초대받은 그룹으로 간다(참여 화면에서 동의하고 참여).
      hasInvite()
        ? card("다음은 초대받은 그룹", "참여하면 같은 차에서 내 캐릭터와 목소리로 함께 기록해요.")
        : card("다음은 우리 가족", `아이의 프로필도 ${p?.name ?? draft.name}님이 만들어 줄 수 있어요.`),
      bottom(primary(hasInvite() ? "초대받은 그룹에 참여" : "가족 그룹 만들기", () => { close(); onFamily(); }))];
  };

  // ---- 녹음: 마이크 → 실제 소리 크기로 막대 → 16 kHz 모노 → embed() → 값만 올림(voice-meter.js) ----
  function seconds() {
    return rec ? Math.min(rec.elapsed(), VOICE_SECONDS) : 0;
  }

  async function startRecording() {
    if (!me()?.consent) { toast("기록 동의를 먼저 받아요."); return go("consent"); } // 동의 없이 마이크를 열지 않는다
    rec?.cancel();
    rec = null;
    mic = "";
    let current;
    try {
      // 15초가 차면 저절로 등록하고 P08로(시안 P07 → P08). 전에는 '녹음을 마쳤어요'에 머물러 '녹음 완료'를 또 눌러야 했다.
      current = await startVoice({ slots: BARS.length, seconds: VOICE_SECONDS, onChange: () => {
        if (step !== "recording" || rec !== current) return;
        if (current.done && !current.sent) { current.sent = true; submitVoice(); } else render();
      } });
    } catch (e) {
      mic = e.message;
      return go("voice");
    }
    rec = current;
    go("recording");
  }

  async function submitVoice() {
    if (!rec || seconds() < MIN_SECONDS || busy) return;
    const got = rec;
    got.stop();
    await work(async () => {
      if (!me()?.consent) { step = "consent"; return; }
      const { value } = await got.finish(); // 표본은 값을 만든 뒤 버린다
      try {
        await call("POST", "/profiles/me/voice", value);
      } catch (e) {
        throw e.status === 400 ? new Error("말소리가 없어 등록할 수 없음") : e;
      }
      await loadProfile();
      step = "done";
    });
  }

  async function shrink(file) {
    const img = await createImageBitmap(file);
    const s = Math.min(1, 640 / Math.max(img.width, img.height));
    const c = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * s), height: Math.round(img.height * s) });
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (!blob) throw new Error("사진을 읽지 못했어요.");
    return blob;
  }

  function close() {
    rec?.cancel();
    rec = null;
    step = null;
    mode = "signup";
    draft.password = "";
  }

  const views = { welcome, signup, consent, profile, photo, voice, recording, done };
  return {
    // 처음부터(또는 빠진 단계부터) 연다. 내 프로필의 '계정·목소리 등록'과 첫 화면이 부른다.
    open(at) { close(); step = at ?? null; fill(); },
    close,
    get step() { return step; },
    view() {
      if (!step) {
        // 다시 열었을 때(새로 고침) 프로필을 읽기 전에 단계를 정하면 계정이 있는데도 '계정 만들기'에 멈춘다. 읽은 뒤에 정한다.
        if (getToken() && !me()) return [top(), title("프로필을 확인하고 있어요")];
        step = firstStep(me(), !!getToken());
        fill();
      }
      if (step === "recording" && !rec) step = "voice";
      return views[step]();
    },
  };
}
