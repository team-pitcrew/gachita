// 구글 OAuth 제공자(T21, ADR-0005). 서버의 나머지는 이 파일만 안다(ADR-0004의 제공자 자리).
// 토큰 교환과 사용자 정보 주소를 환경 변수로 받는다 — 테스트는 가짜 제공자 주소를 넣어 돈다.
// 클라이언트 값도 환경 변수로만 받는다. 클라이언트 앱은 인증 코드만 서버에 넘긴다.
const fail = (status, error) => {
  throw { status, error };
};

// 인증 코드를 구글 사용자 번호(sub)와 이름으로 바꾼다. 이메일은 요청하지 않는다.
export async function googleIdentity(code, redirectUri) {
  const tokenUrl = process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
  const infoUrl = process.env.GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo";
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  });
  const token = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }).catch(() => null);
  if (!token || !token.ok) fail(401, "제공자가 코드를 거절함");
  const { access_token } = await token.json();
  const info = await fetch(infoUrl, { headers: { authorization: `Bearer ${access_token}` } }).catch(() => null);
  if (!info || !info.ok) fail(502, "제공자에서 사용자 정보를 못 받음");
  const { sub, name } = await info.json();
  if (typeof sub !== "string" || !sub) fail(502, "제공자 응답에 사용자 번호가 없음");
  return { providerUserId: sub, name: typeof name === "string" && name.trim() ? name.trim().slice(0, 20) : "이름 없음" };
}
