// 구글 OAuth 제공자(T21, ADR-0006). 서버의 나머지는 이 파일만 안다(ADR-0004의 제공자 자리).
// 토큰 교환과 사용자 정보 주소를 환경 변수로 받는다 — 테스트는 가짜 제공자 주소를 넣어 돈다.
// 클라이언트 값도 환경 변수로만 받는다. 클라이언트 앱은 인증 코드만 서버에 넘긴다.
// 제공자 오류는 코드 거절(401)과 장애(503·504·502)·설정 오류(500)로 나눈다 —
// 4xx가 전부 사용자 코드 잘못은 아니고, 장애를 코드 오류로 알리면 로그인을 헛되이 반복한다(리뷰).
const fail = (status, error) => {
  throw { status, error };
};
const timeoutMs = () => Number(process.env.GOOGLE_TIMEOUT_MS ?? 5000);

// 웹이 로그인 시작에 쓰는 공개 값만 준다. 교환에 필요한 설정이 없으면 시작하지 않게 한다.
export function googlePublicConfig() {
  const ready = process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim();
  return { googleClientId: ready ? process.env.GOOGLE_CLIENT_ID : "" };
}

// 제공자에게 요청해 [응답, 본문]을 받는다. 시간 제한을 넘기면 504, 연결이 안 되면 503,
// 본문이 JSON이 아니면 502로 끝낸다.
async function fetchJson(url, options) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs()) });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") fail(504, "제공자 응답이 늦어 요청을 끊음");
    fail(503, "제공자에 연결하지 못함");
  }
  let body;
  try {
    body = await res.json();
  } catch {
    if (res.ok) fail(502, "제공자 응답을 읽지 못함");
    body = {};
  }
  return [res, body];
}

// 코드를 돌려받는 주소는 우리 출처만 받는다(T27): https 실제 주소와 http 로컬 개발(localhost·127.0.0.1의 아무 포트).
// 적힌 그대로가 정규형이어야 하고 사용자 정보는 안 된다 — 대소문자·역슬래시·blob: 같은 변형을 구글로 넘기지 않는다.
// 경로까지 맞는지는 구글이 등록된 리다이렉트 주소와 다시 본다.
// ponytail: 주소 목록은 코드에 둔다. 주소가 더 생기면 그때 환경 변수로.
const REDIRECT_HOSTS = ["gachita.mangowhois.ai"];
const ourRedirect = (uri) => {
  const u = URL.parse(uri);
  return Boolean(u) && u.href === uri && !u.username && !u.password &&
    ((u.protocol === "https:" && REDIRECT_HOSTS.includes(u.host)) || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)));
};

// 인증 코드를 구글 사용자 번호(sub)와 이름으로 바꾼다. 이메일은 요청하지 않는다.
// 결과가 불확실해도 같은 코드로 다시 시도하지 않는다 — 코드는 한 번만 쓸 수 있다.
export async function googleIdentity(code, redirectUri) {
  if (!ourRedirect(redirectUri)) fail(400, "redirectUri: https://gachita.mangowhois.ai 또는 http://localhost·127.0.0.1의 주소를 정규형으로(예: 끝의 /)");
  const tokenUrl = process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
  const infoUrl = process.env.GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo";
  const [token, tokenBody] = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  });
  if (!token.ok) {
    if (token.status < 500 && (tokenBody.error === "invalid_grant" || tokenBody.error === "invalid_request")) fail(401, "제공자가 코드를 거절함");
    if (token.status < 500 && tokenBody.error === "invalid_client") fail(500, "서버의 구글 클라이언트 설정이 잘못됨");
    fail(503, "제공자가 일시적으로 응답하지 않음");
  }
  if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) fail(502, "제공자 응답에 접근 토큰이 없음");
  const [info, infoBody] = await fetchJson(infoUrl, { headers: { authorization: `Bearer ${tokenBody.access_token}` } });
  if (!info.ok) fail(502, "제공자에서 사용자 정보를 못 받음");
  const { sub, name } = infoBody;
  if (typeof sub !== "string" || !sub) fail(502, "제공자 응답에 사용자 번호가 없음");
  return { providerUserId: sub, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 20) : "이름 없음" };
}
