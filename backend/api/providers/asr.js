// 재전사(T75). 사람이 고른 장면 클립의 말을 상현님 Nemotron ASR(nemo_transcribe30, OpenAI 호환 chat/completions,
// 연동 가이드 v1.0)로 다시 받아 적는다. ASR_URL·ASR_TOKEN이 둘 다 있을 때만 돈다. 서버의 나머지는 이 파일만 안다.
// 보내는 것: 발화 하나의 소리(16 kHz 모노 WAV), 그 발화의 Pleos 초안, 여행이 아는 낱말. 11/14 실측(2구간 56쌍)과 같은 지시다.
// 토큰은 머리말로만 보내고 로그·응답에 남기지 않는다.

const MODEL = "nemo_transcribe30";
const GAP_MS = 550; // 상대 서버가 IP당 초당 2건으로 제한한다
const timeoutMs = () => Number(process.env.ASR_TIMEOUT_MS ?? 10_000); // 문장 하나 중앙값 0.61초(11/14 실측)
const RETRIES = [1000, 2000, 4000]; // 429면 기다렸다 다시(연동 가이드 5절)

export const asrReady = () => Boolean(process.env.ASR_URL && process.env.ASR_TOKEN);

// 여행이 아는 낱말: 참가자 이름, 흔한 호칭, 목적지, 호출어(T59의 '앱이 아는 낱말'과 같은 종류).
export const contextOf = (names, destination) =>
  `등장인물: ${names.join(", ")}. 호칭: 엄마, 아빠, 여보, 오빠, 언니, 누나, 형.${destination ? ` 목적지: ${destination}.` : ""} 차 비서 이름: 글레오.`;

// 모노 표본(-1~1)을 16 kHz 16비트 WAV로.
export function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 모노
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// 믿지 않는 답(11/14: 긴 녹음에 맥락을 넣으면 같은 말을 되풀이하다 토큰 한도까지 감):
// 초안보다 터무니없이 길거나, 12자 넘는 같은 말(13자 창)이 겹치지 않게 다시 나온다.
function suspicious(s, draft) {
  const chars = [...s];
  if (chars.length > [...draft].length * 3 + 30) return true;
  const seen = new Map();
  for (let i = 0; i + 13 <= chars.length; i++) {
    const k = chars.slice(i, i + 13).join("");
    if (!seen.has(k)) seen.set(k, i);
    else if (i - seen.get(k) >= 13) return true;
  }
  return false;
}

let slot = 0; // 다음 요청을 보내도 되는 시각. 이 프로세스 안에서 요청 간격을 지킨다
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// 고친 글을 돌려준다. 실패·늦음·429 세 번·되풀이·빈 답이면 null — 부르는 쪽이 Pleos 원문을 쓴다.
export async function retranscribe(wav, draft, context) {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    skip_special_tokens: false,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Transcribe the following audio in Korean exactly as spoken. Do not translate. A draft from another recognizer (may contain errors): "${draft}". Context: ${context}` },
          { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${wav.toString("base64")}` } },
        ],
      },
    ],
  });
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    slot = Math.max(slot, now) + GAP_MS;
    await sleep(slot - GAP_MS - now);
    let res;
    try {
      res = await fetch(`${process.env.ASR_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.ASR_TOKEN}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch {
      return null; // 늦음·연결 실패
    }
    if (res.status === 429 && attempt < RETRIES.length) {
      await res.body?.cancel();
      await sleep(RETRIES[attempt]);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const text = await res
      .json()
      .then((j) => j?.choices?.[0]?.message?.content)
      .catch(() => null);
    if (typeof text !== "string") return null;
    const clean = text.replace(/<[^>]*>/g, "").trim(); // <spk:N> 같은 태그는 자막에 쓰지 않는다
    return clean && !suspicious(clean, draft) ? clean : null;
  }
}
