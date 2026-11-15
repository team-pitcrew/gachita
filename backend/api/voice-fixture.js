// 시험용 목소리 값(T173): 프로필로 그룹·여행에 들어가려면 목소리 등록이 먼저라(오너 원칙), 시험이 만드는 프로필에 등록한다.
// 값은 서버·차가 함께 쓰는 voice-vectors.json의 첫 사례(지금 임베더 logmel-pitch-1, 112차원). 이미지에는 들어가지 않는다.
import { readFileSync } from "node:fs";

export const VOICE = {
  embedder: "logmel-pitch-1",
  vector: JSON.parse(readFileSync(new URL("voice-vectors.json", import.meta.url), "utf8")).cases[0].vector,
  seconds: 7,
};

// base는 서버 주소(…:포트). 프로필 토큰으로 목소리 값을 등록한다. 실패하면 시험 준비가 틀린 것이라 던진다.
export async function withVoice(base, token) {
  const res = await fetch(`${base}/api/profiles/me/voice`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(VOICE),
  });
  if (res.status !== 200) throw new Error(`시험 목소리 등록 실패 ${res.status} ${await res.text()}`);
}
