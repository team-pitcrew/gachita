// 웹앱(/)과 웹 시연(/demo)이 함께 쓰는 것. 빌드 없이 <script type="module">이 그대로 읽는다.
// API 부르기와 토큰 머리말은 여기 한 곳에 둔다. JSON이 아닌 응답(프로필 사진 받기)만 app.js가 직접 부른다.

export const SEATS = [
  ["ROW_1_LEFT", "운전석"],
  ["ROW_1_RIGHT", "조수석"],
  ["ROW_2_LEFT", "뒤 왼쪽"],
  ["ROW_2_CENTER", "뒤 가운데"],
  ["ROW_2_RIGHT", "뒤 오른쪽"],
];
export const SEAT = Object.fromEntries(SEATS);
// 부탁 상태: [글자, 배지 색]
export const REQ = {
  held: ["보관", ""],
  proposed: ["제안 중", "accent"],
  accepted: ["수락됨", "accent"],
  reflected: ["경유지 반영", "ok"],
  done: ["완료", "ok"],
  cancelled: ["취소됨", ""],
};

// 정적 파일(그림 등)의 주소는 이 모듈이 온 자리를 기준으로 만든다(T180). 화면 파일이 다른 출처의 하위 경로
// (CDN의 public/web/{커밋}/)에서 와도 같은 묶음의 파일을 찾는다. 같은 출처로 줄 때는 지금처럼 /chars/…가 된다.
// path는 웹 폴더 기준 상대 경로("chars/basic.webp"). 모듈과 CSS에는 /로 시작하는 정적 주소를 쓰지 않는다(static-paths.test.mjs가 막는다).
// /api/…와 화면 이동 주소(/, /demo/), 서비스 워커(/sw.js), 화자 모델·실행기(/models, /vendor)는 문서 출처 그대로 둔다.
export const asset = (path) => new URL(path, import.meta.url).href;
// 그 주소가 문서와 다른 출처인가. 캔버스에 그려 녹화하는 그림과 Worker는 이때 따로 다룬다(short-film.js, wespeaker.js).
export const elsewhere = (url) => Boolean(globalThis.location) && new URL(url, location.href).origin !== location.origin;

// API 부르기. token이 있으면 Authorization: Bearer로 보낸다(프로필 토큰이나 참가자 토큰). Blob 본문(사진)은 그대로 보낸다.
// 실패하면 Error에 status를 붙여 던진다. 서버에 닿지 않았으면 status 0.
// 서버의 '목소리 먼저'(T173): 목소리 없는 프로필이 그룹·여행에 새로 들어가려 하면 409 voice_required.
export const needsVoice = (e) => e?.status === 409 && e.reason === "voice_required";

export async function api(method, path, body, token, signal) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body && !(body instanceof Blob)) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body instanceof Blob ? body : body && JSON.stringify(body), signal });
  } catch {
    throw Object.assign(new Error("서버에 닿지 않아요. 연결을 확인해 주세요."), { status: 0 });
  }
  if (res.status === 304 || res.status === 204) return null;
  const data = await res.json().catch(() => ({})); // 앞단(ALB 등)의 HTML 오류 쪽은 JSON이 아니다
  // reason·missing: 서버가 문장 대신 가르라고 주는 칸(예: 409 voice_required와 목소리 없는 구성원 목록, T173)
  if (!res.ok) throw Object.assign(new Error(data.error ?? `서버가 잠시 답하지 못했어요(${res.status}). 잠시 뒤 다시 해 주세요.`), { status: res.status, reason: data.reason, missing: data.missing });
  return data;
}

// 작은 DOM 도우미: h("button", { onclick }, "글자"). 사용자가 쓴 글은 자식 글자로만 넣는다(innerHTML 금지).
export function h(tag, props = {}, ...kids) {
  const el = Object.assign(document.createElement(tag), props);
  for (const [k, v] of Object.entries(props)) if (k.startsWith("aria-")) el.setAttribute(k, v);
  el.append(...kids.flat().filter((k) => k || k === 0)); // 조건이 거짓인 자리(false, undefined)는 뺀다
  return el;
}

// 화면 아래의 짧은 알림(#toast)
let toastTimer;
export function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}
