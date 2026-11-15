// 목소리 등록 녹음과 파형(T142 P06·P07, T133 P12·P42). 한 곳에서 재고 그린다.
// 마이크 → Web Audio: MediaStreamAudioSourceNode → AnalyserNode.getFloatTimeDomainData로 막대 칸마다 실제로 들어온 소리 크기(RMS)를 잰다.
// 지난 칸은 잰 크기로 멈춰 두고, 지금 칸은 소리를 따라 움직이고, 앞으로 칸은 낮게 둔다. 같은 소리를 모아 voice-embed.js로
// 이 기기 안에서 값(112차원)만 만든다 — 소리는 기기를 떠나지 않는다(ADR-0023). 새 의존성 없이 브라우저 Web Audio만 쓴다.
import { h } from "./shared.js";
import { embed, RATE, toMono16k, voiceValue } from "./voice-embed.js";
import { strongValue } from "./wespeaker.js";

export const VOICE_SECONDS = 15;
// 최종 시안 목소리 파형(P06·P07·P12·P42) 막대 36개의 높이(px, 314×72 틀). 녹음 전·다 들은 뒤의 모양이고, 녹음 중에는 실제 소리 크기.
export const WAVE_BARS = [23, 40, 57, 21, 38, 55, 19, 36, 53, 17, 34, 51, 15, 32, 49, 13, 30, 47, 11, 28, 45, 62, 26, 43, 60, 24, 41, 58, 22, 39, 56, 20, 37, 54, 18, 35];
export const MIN_SECONDS = 5; // '녹음 완료'가 눌리는 최소 길이. 서버는 1~20초를 받는다

// 시간 영역 표본의 RMS.
export function rmsOf(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return data.length ? Math.sqrt(sum / data.length) : 0;
}

// RMS를 막대 높이 비율(0~1)로: −55 dBFS 이하는 0, −5 dBFS 이상은 1(말소리는 대개 −40~−10 dBFS).
export function levelOf(rms) {
  if (!(rms > 0)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 55) / 50));
}

// 몇 번째 칸까지 지났나(지금 칸의 번호). seconds초를 slots칸으로 나눈다.
export const slotAt = (elapsed, seconds, slots) => Math.min(slots, Math.floor((Math.max(0, elapsed) / seconds) * slots));

// 칸의 크기를 적는다: 지금 칸은 그 칸 동안 잰 소리의 평균(말과 쉼이 섞이면 낮아진다), 지난 칸은 손대지 않는다(멈춤).
export function record(meter, slot, level) {
  if (slot < 0 || slot >= meter.levels.length) return meter.levels;
  meter.sums[slot] += level;
  meter.counts[slot] += 1;
  meter.levels[slot] = meter.sums[slot] / meter.counts[slot];
  return meter.levels;
}

/**
 * 막대 그리기. 녹음 전(meter 없음)은 시안의 모양(ready 높이, 모두 켬). 녹음 중·뒤에는 지난 칸과 지금 칸이 잰 크기,
 * 앞으로 칸은 upcoming 높이(숫자 하나 또는 칸별 높이)로 꺼 둔다. 색·간격·둥근 끝은 부르는 쪽 CSS(.ob-wave) 그대로.
 */
export function voiceBars(meter, { className, slots, ready, min, max, upcoming }) {
  const now = meter ? slotAt(meter.elapsed(), meter.seconds, slots) : -1;
  const bars = Array.from({ length: slots }, (_, i) => {
    if (!meter) return h("i", { className: "on", style: `height:${ready[i % ready.length]}px` });
    if (i <= now && i < slots) return h("i", { className: "on", style: `height:${Math.round(min + (max - min) * meter.levels[i])}px` });
    return h("i", { style: `height:${Array.isArray(upcoming) ? upcoming[i % upcoming.length] : upcoming}px` });
  });
  return h("div", { className, "aria-hidden": "true" }, bars);
}

/**
 * 녹음 하나를 연다. onChange는 화면을 다시 그릴 때(약 0.1초마다, 그리고 끝날 때) 부른다.
 * 돌려주는 것: levels(칸별 0~1), elapsed()(초), done, stop()(마이크 놓기), finish()(→ {value, seconds, strong}, 값만), cancel().
 * strong은 두 번째 값(wespeaker, T169)의 약속이다 — 뒤에서 셈해 {embedder, vector, seconds} 또는 null로 끝난다.
 * 마이크를 열지 못하면 Error(.reason = "denied" | "unavailable")를 던진다.
 */
export async function startVoice({ slots, seconds = VOICE_SECONDS, onChange = () => {}, media = globalThis.navigator?.mediaDevices }) {
  let stream;
  try {
    stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    throw Object.assign(new Error(e?.name === "NotAllowedError" ? "마이크 권한이 없어 녹음할 수 없어요" : "이 기기에서는 마이크를 열 수 없어요"), { reason: e?.name === "NotAllowedError" ? "denied" : "unavailable" });
  }
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const probe = new Float32Array(analyser.fftSize);
  const collect = ctx.createScriptProcessor(4096, 1, 1); // 값을 만들 표본을 모은다(재는 것은 analyser)
  const mute = ctx.createGain();
  mute.gain.value = 0; // 처리 노드가 돌도록 출력에 잇되 소리는 내지 않는다
  const total = Math.round(seconds * ctx.sampleRate);
  const meter = { seconds, levels: new Float32Array(slots), sums: new Float32Array(slots), counts: new Uint16Array(slots), done: false, chunks: [], frames: 0, ticks: 0, rate: ctx.sampleRate };
  meter.elapsed = () => meter.frames / meter.rate;
  const stop = () => {
    if (meter.done) return;
    meter.done = true;
    clearInterval(meter.timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
  collect.onaudioprocess = (e) => {
    if (meter.done) return;
    const data = e.inputBuffer.getChannelData(0);
    const take = Math.min(data.length, total - meter.frames);
    if (take > 0) { meter.chunks.push(new Float32Array(data.subarray(0, take))); meter.frames += take; }
    if (meter.frames >= total) { stop(); onChange(); }
  };
  source.connect(analyser);
  source.connect(collect);
  collect.connect(mute);
  mute.connect(ctx.destination);
  await ctx.resume().catch(() => {});
  meter.timer = setInterval(() => {
    if (meter.done) return;
    analyser.getFloatTimeDomainData(probe);
    record(meter, slotAt(meter.elapsed(), seconds, slots), levelOf(rmsOf(probe)));
    if (++meter.ticks % 2 === 0) onChange(); // 0.05초마다 재고 0.1초마다 다시 그린다
  }, 50);
  meter.stop = stop;
  meter.cancel = () => { stop(); meter.chunks = []; };
  // 멈추고 이 기기 안에서 값으로 바꾼다. 표본은 값을 만든 뒤 버린다.
  meter.finish = async () => {
    stop();
    const all = new Float32Array(meter.frames);
    let at = 0;
    for (const c of meter.chunks) { all.set(c, at); at += c.length; }
    meter.chunks = [];
    const mono = await toMono16k(all, meter.rate);
    let vector;
    try { vector = embed(mono); } catch { throw new Error("소리가 너무 짧아요. 다시 녹음해 주세요."); }
    const seconds = mono.length / RATE;
    // 두 번째 값은 Worker에서 셈한다(표본은 그리로 옮겨지고 여기서는 비워진다). 1차 값을 기다리게 하지 않는다.
    return { value: voiceValue(vector, seconds), seconds, strong: strongValue(mono).catch(() => null) };
  };
  return meter;
}
