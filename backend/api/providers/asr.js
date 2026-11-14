// 재전사(T75). 사람이 고른 장면 클립의 말을 상현님 Nemotron ASR(nemo_transcribe30, OpenAI 호환 chat/completions,
// 연동 가이드 v1.0)로 다시 받아 적는다. ASR_URL·ASR_TOKEN이 둘 다 있을 때만 돈다. 서버의 나머지는 이 파일만 안다.
// 보내는 것: 발화 하나의 소리(16 kHz 모노 WAV), 그 발화의 Pleos 초안, 여행이 아는 낱말. 11/14 실측(2구간 56쌍)과 같은 지시다.
// 토큰은 머리말로만 보내고 로그·응답에 남기지 않는다.

import { setTimeout as pause } from "node:timers/promises";

const MODEL = "nemo_transcribe30";
// 상대 서버는 IP당 초당 2건이다. API 파드 둘이 한 노드(한 IP)로 나가므로 파드마다 1.1초 간격(합쳐 초당 2건 아래).
const gapMs = () => Number(process.env.ASR_GAP_MS ?? 1100);
const timeoutMs = () => Number(process.env.ASR_TIMEOUT_MS ?? 10_000); // 문장 하나 중앙값 0.61초(11/14 실측)
const BACKOFF = [1000, 2000, 4000]; // 429면 기다렸다 다시 — 처음 보낸 것까지 네 번(연동 가이드 5절)

export const asrReady = () => Boolean(process.env.ASR_URL && process.env.ASR_TOKEN);

// 여행이 아는 낱말: 참가자 이름, 흔한 호칭, 목적지, 호출어(T59의 '앱이 아는 낱말'과 같은 종류).
export const contextOf = (names, destination) =>
  `등장인물: ${names.join(", ")}. 호칭: 엄마, 아빠, 여보, 오빠, 언니, 누나, 형.${destination ? ` 목적지: ${destination}.` : ""} 차 비서 이름: 글레오.`;

// 16비트 모노 PCM(Int16Array)을 16 kHz WAV로.
export function toWav(pcm) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.byteLength, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 모노
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([head, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

const plain = (s) => [...s.replace(/[\s\p{P}]/gu, "")];
// 두 글의 편집 거리(공백·문장부호를 뺀 글자 단위).
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// 12자 넘는 같은 말(13자 창)이 겹치지 않게 다시 나온다(11/14: 긴 녹음에 맥락을 넣으면 같은 말을 되풀이하다 토큰 한도까지 감).
function repeats(chars) {
  const seen = new Map();
  for (let i = 0; i + 13 <= chars.length; i++) {
    const k = chars.slice(i, i + 13).join("");
    if (!seen.has(k)) seen.set(k, i);
    else if (i - seen.get(k) >= 13) return true;
  }
  return false;
}
// 믿지 않는 답: 초안과 글자의 절반 넘게 다르거나(옆 사람의 말, 지어낸 말), 초안에 없던 되풀이가 생겼다.
const suspicious = (text, draft) => {
  const [t, d] = [plain(text), plain(draft)];
  return distance(t, d) > d.length / 2 || (repeats(t) && !repeats(d));
};

let slot = 0; // 다음 요청을 보내도 되는 시각. 첫 전사와 재전사가 함께 지킨다
const wait = async (signal) => {
  const now = Date.now();
  slot = Math.max(slot, now) + gapMs();
  await pause(Math.max(0, slot - gapMs() - now), undefined, { signal });
};

let transcribing = 0;
// 웹의 첫 전사(T96): Pleos 초안이나 추정 문장을 넣지 않는다. 대기까지 제한하고 공급자는 한 번만 부른다.
// stillOk는 DB 읽기를 마친 뒤 돌아온다. 공급자 응답을 기다리는 동안 DB 연결·잠금을 점유하지 않는다.
export async function transcribe(wav, stillOk, callerSignal) {
  if (!asrReady()) return { reason: "unconfigured" };
  if (transcribing >= 8) return { reason: "rate_limited" };
  const configured = timeoutMs();
  const deadline = AbortSignal.timeout(Number.isFinite(configured) && configured > 0 ? Math.min(20_000, Math.ceil(configured)) : 10_000);
  const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
  transcribing++;
  try {
    await wait(signal);
    await stillOk();
    signal.throwIfAborted();
    const res = await fetch(`${process.env.ASR_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.ASR_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 512,
        chat_template_kwargs: { enable_thinking: false },
        skip_special_tokens: false,
        messages: [{ role: "user", content: [
          { type: "text", text: "Transcribe the following audio in Korean exactly as spoken. Do not translate. Return only the spoken words. Return an empty string for silence. Do not invent dialogue or speaker names." },
          { type: "audio_url", audio_url: { url: `data:audio/wav;base64,${wav.toString("base64")}` } },
        ] }],
      }),
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 429) {
        slot = Math.max(slot, Date.now() + BACKOFF[0]); // 재전사도 함께 물러서되 이 음성은 재전송하지 않는다.
        return { reason: "rate_limited" };
      }
      return { reason: "upstream" };
    }
    const choice = (await res.json())?.choices?.[0];
    const content = choice?.message?.content;
    signal.throwIfAborted();
    if (typeof content !== "string" || choice.finish_reason === "length") return { reason: "bad_response" };
    const clean = content.replace(/<[^>]*>/g, "").trim();
    if (!clean) return { reason: "empty" };
    if (clean.length > 500 || clean.includes("\0") || !clean.isWellFormed()) return { reason: "bad_response" };
    return { text: clean };
  } catch (e) {
    if (e?.status) throw e; // 호출 직전의 인증·동의·세대 검사를 공급자 장애로 바꾸지 않는다.
    return { reason: callerSignal?.aborted ? "cancelled" : deadline.aborted ? "timeout" : "unreachable" };
  } finally {
    transcribing--;
  }
}

// 다시 받아 적은 글 { text } 또는 원문으로 남는 이유 { reason }. 보내기 직전마다 stillOk()로 다시 본다 —
// 그 사이 클립이 지워졌거나 동의가 철회됐거나 글이 지워졌으면 보내지 않는다(기다리는 동안과 429 뒤에도).
export async function retranscribe(wav, draft, context, stillOk) {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0,
    max_tokens: Math.min(512, [...draft].length * 3 + 64), // 되풀이하다 토큰 한도까지 가지 않게
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
    await wait();
    if (!(await stillOk())) return { reason: "stopped" };
    let res;
    try {
      res = await fetch(`${process.env.ASR_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.ASR_TOKEN}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (e) {
      return { reason: e?.name === "TimeoutError" ? "timeout" : "unreachable" };
    }
    if (res.status === 429 && attempt < BACKOFF.length) {
      await res.body?.cancel();
      slot = Math.max(slot, Date.now() + BACKOFF[attempt]); // 이 프로세스의 다른 재전사도 함께 물러선다
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { reason: `http_${res.status}` };
    }
    const text = await res
      .json()
      .then((j) => j?.choices?.[0]?.message?.content)
      .catch(() => null);
    if (typeof text !== "string") return { reason: "bad_response" };
    const clean = text.replace(/<[^>]*>/g, "").trim(); // <spk:N> 같은 태그는 자막에 쓰지 않는다
    if (!clean) return { reason: "empty" };
    return suspicious(clean, draft) ? { reason: "suspicious" } : { text: clean };
  }
}
