// 폰에서 하는 목소리 등록(T142, ADR-0023): 브라우저가 녹음한 소리를 이 기기 안에서 대조 값(112차원)으로 바꾸고 값만 올린다.
// 아래 fft()와 embed()는 backend/api/providers/voice.js를 그대로 옮긴 것이다 — 수식을 고치지 않는다.
// 서버·차(Voice.kt)와 같은 값을 내는지는 voice-embed.test.mjs가 backend/api/voice-vectors.json(허용 오차 1e-6)으로 본다.
// 수식을 바꿔야 하면 voice.js에서 이름(EMBEDDER)을 올리고 파일을 다시 만든 뒤 여기와 Voice.kt를 함께 고친다.

export const EMBEDDER = "logmel-pitch-1";
const PITCH_BINS = 20;
const MEL_BANDS = 26;
export const DIMS = MEL_BANDS * 2 + PITCH_BINS * 3;
export const RATE = 16000;

// 자리 교체 없는 반복 radix-2 FFT(길이는 2의 거듭제곱).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

const FRAME = 512; // 32 ms @ 16 kHz
const HOP = 160; // 10 ms
const melCenters = Array.from({ length: MEL_BANDS + 2 }, (_, i) => {
  const mel = (hz) => 2595 * Math.log(1 + hz / 700);
  const low = mel(50);
  const high = mel(7600);
  return 700 * (Math.exp((low + ((high - low) * i) / (MEL_BANDS + 1)) / 2595) - 1);
});
const hzToBin = (hz) => Math.round((hz / 16000) * FRAME);

// 샘플을 대조용 벡터로 바꾼다. 로그멜(평균·분산) + 음높이 통계(무게 3배) → L2 정규화.
export function embed(samples) {
  const frames = [];
  const window = Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  for (let off = 0; off + FRAME <= samples.length; off += HOP) {
    const re = new Float64Array(FRAME);
    const im = new Float64Array(FRAME);
    let mean = 0;
    for (let i = 0; i < FRAME; i++) mean += samples[off + i];
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) re[i] = (samples[off + i] - mean) * window[i];
    fft(re, im);
    const power = new Float64Array(FRAME / 2);
    for (let i = 0; i < FRAME / 2; i++) power[i] = (re[i] * re[i] + im[i] * im[i]) / FRAME;
    const mel = new Float64Array(MEL_BANDS);
    for (let b = 0; b < MEL_BANDS; b++) {
      const lo = hzToBin(melCenters[b]);
      const mid = hzToBin(melCenters[b + 1]);
      const hi = hzToBin(melCenters[b + 2]);
      let e = 0;
      for (let i = Math.max(1, lo); i <= Math.min(FRAME / 2 - 1, hi); i++) {
        const up = (i - lo) / (mid - lo || 1);
        const down = (hi - i) / (hi - mid || 1);
        e += power[i] * Math.max(0, Math.min(up, down));
      }
      mel[b] = Math.log10(e + 1e-10);
    }
    frames.push(mel);
  }
  if (!frames.length) throw { status: 400, error: "소리가 너무 짧음" };
  const dim = frames[0].length;
  const mean = new Array(dim).fill(0);
  for (const f of frames) for (let i = 0; i < dim; i++) mean[i] += f[i];
  for (let i = 0; i < dim; i++) mean[i] /= frames.length;
  const std = new Array(dim).fill(0);
  for (const f of frames) for (let i = 0; i < dim; i++) std[i] += (f[i] - mean[i]) ** 2;
  for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i] / frames.length);

  // 음높이: 4배 간추린 신호의 자기상관(60~400 Hz)에서 유성 프레임의 주파수를 모은다.
  const decim = [];
  for (let i = 0; i + 3 < samples.length; i += 4) decim.push((samples[i] + samples[i + 1] + samples[i + 2] + samples[i + 3]) / 4);
  const LAG_MIN = Math.floor(4000 / 400);
  const LAG_MAX = Math.floor(4000 / 60);
  const pitches = [];
  for (let off = 0; off + LAG_MAX * 2 <= decim.length; off += LAG_MAX) {
    let e0 = 0;
    for (let i = 0; i < LAG_MAX; i++) e0 += decim[off + i] ** 2;
    if (e0 < 1e-6) continue;
    let bestLag = 0;
    let bestR = 0;
    for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
      let r = 0;
      for (let i = 0; i < LAG_MAX; i++) r += decim[off + i] * decim[off + i + lag];
      const norm = r / e0;
      if (norm > bestR) {
        bestR = norm;
        bestLag = lag;
      }
    }
    if (bestR > 0.35 && bestLag) pitches.push(4000 / bestLag);
  }
  // 음높이 히스토그램(60~500 Hz, 로그 눈금 20구간 — 반음 두 개쯤 간격). 프레임별 음높이가
  // 흩어져도 같은 사람이면 같은 구간에 모인다 — 아이와 어른은 아예 다른 구간에 온다.
  const pitchFeat = new Array(PITCH_BINS).fill(0);
  for (const p of pitches) {
    const bin = Math.min(PITCH_BINS - 1, Math.max(0, Math.floor((Math.log2(p / 60) / Math.log2(500 / 60)) * PITCH_BINS)));
    pitchFeat[bin]++;
  }
  const total = pitches.length || 1;
  for (let i = 0; i < PITCH_BINS; i++) pitchFeat[i] /= total;

  // 그룹별로 평균을 빼고(상수 성분 — 로그멜 오프셋, 유성 비율 1 — 이 코사인을 무조건
  // 높이는 것을 막는다) 단위 길이로 만들어 잇는다. 음높이는 사람을 가르는 가장 강한
  // 단서라 무게를 3배로 둔다(참조 임베더의 선택).
  const group = (arr) => {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    let n = 0;
    for (const v of arr) n += (v - m) ** 2;
    n = Math.sqrt(n) || 1;
    return arr.map((v) => (v - m) / n);
  };
  const gMean = group(mean);
  const gStd = group(std);
  const gPitch = group([...pitchFeat, ...pitchFeat, ...pitchFeat]);
  return [...gMean, ...gStd, ...gPitch];
}


// 마이크가 준 표본(기기의 표본율, 보통 48 kHz)을 16 kHz로 줄인다. OfflineAudioContext가 거르고 줄이며,
// 없으면(오래된 브라우저) 구간 평균으로 줄인다. 끝으로 16비트 값으로 맞춘다 — 차(pcmSamples)·서버(wavMono)와 같은 /32768 눈금.
export async function toMono16k(samples, rate) {
  let out = samples;
  if (rate !== RATE) {
    const Offline = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (Offline) {
      const ctx = new Offline(1, Math.max(1, Math.ceil((samples.length * RATE) / rate)), RATE);
      const buffer = ctx.createBuffer(1, samples.length, rate);
      buffer.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start();
      out = (await ctx.startRendering()).getChannelData(0);
    } else out = decimate(samples, rate);
  }
  return quantize(out);
}

export function decimate(samples, rate) {
  const n = Math.floor((samples.length * RATE) / rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * rate) / RATE);
    const b = Math.max(a + 1, Math.floor(((i + 1) * rate) / RATE));
    let s = 0;
    for (let j = a; j < b && j < samples.length; j++) s += samples[j];
    out[i] = s / (b - a);
  }
  return out;
}

export function quantize(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767) / 32768;
  return out;
}

// POST /api/profiles/me/voice의 본문(ADR-0023): 이름, 값, 길이(초).
export const voiceValue = (vector, seconds) => ({ embedder: EMBEDDER, vector, seconds: Math.round(seconds * 100) / 100 });
