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

// API 부르기. token이 있으면 Authorization: Bearer로 보낸다(프로필 토큰이나 참가자 토큰). Blob 본문(사진)은 그대로 보낸다.
// 실패하면 Error에 status를 붙여 던진다. 서버에 닿지 않았으면 status 0.
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
  if (!res.ok) throw Object.assign(new Error(data.error ?? `서버가 잠시 답하지 못했어요(${res.status}). 잠시 뒤 다시 해 주세요.`), { status: res.status });
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
