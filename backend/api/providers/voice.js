// 화자 대조(T38, ADR-0019). 등록 음성·발화 음성을 대조용 값(벡터)으로 바꾼다.
// 표준 라이브러리만 쓴다 — 서버의 원칙(의존성 pg 하나)을 지키기 위해서다.
//
// 1차 구현은 참조 임베더다: WAV(16 kHz PCM)를 읽어 로그멜 평균·분산과 음높이 통계를
// 묶어 L2 정규화 벡터를 만든다(에뮬레이터 E2E의 간이 대조기 — 음높이+MFCC — 와 같은 종류).
// 계약(등록·대조 API 모양)을 이 임베더로 고정하고, 정확도 표(지환 시험 음성)로 검증한 뒤
// ECAPA-TDNN 같은 학습된 모델로 갈아끼운다(ADR-0019). 원본 음성은 어디에도 저장하지 않는다.

// WAV(RIFF)를 모노 샘플로 푼다. 차량 앱의 표본율 16 kHz만 받는다(ADR-0008).
export function wavMono(buf) {
  const fail = (msg) => {
    throw { status: 400, error: msg };
  };
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") fail("WAV만 됨");
  let pos = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      // 형식 태그 1(PCM)만, 머리가 잘린 파일은 거절한다(읽다가 범위를 넘으면 500이 된다).
      if (size < 16 || pos + 24 > buf.length || buf.readUInt16LE(pos + 8) !== 1) fail("16비트 PCM WAV만 됨");
      channels = buf.readUInt16LE(pos + 10);
      rate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === "data") {
      data = buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length));
    }
    pos += 8 + size + (size % 2);
  }
  if (!data || !rate || !channels || bits !== 16) fail("16비트 PCM WAV만 됨");
  if (rate !== 16000) fail("표본율은 16000이어야 함");
  const frames = Math.floor(data.length / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    samples[i] = sum / channels / 32768;
  }
  return { samples, channels };
}

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

// 임베더의 이름과 벡터 모양. 차량 앱이 같은 수식을 차 안에서 돌려 값만 올린다(ADR-0023) —
// 수식을 바꾸면 이름을 올리고 voice-vectors.json을 다시 만든다(차량 단위 시험이 같은 파일을 읽는다).
export const EMBEDDER = "logmel-pitch-1";
const PITCH_BINS = 20;
const MEL_BANDS = 26;
export const DIMS = MEL_BANDS * 2 + PITCH_BINS * 3;

// 등록할 값의 모양을 본다(기기가 계산해 올린 값과 서버가 등록 음성에서 계산한 값 모두): 길이, 유한한 수, 세 묶음(로그멜 평균·분산·음높이)이 각각 평균 0·길이 1.
// 음높이를 못 잡은 소리는 음높이 묶음이 모두 0이다.
export function checkVector(v) {
  const bad = (msg) => {
    throw { status: 400, error: `vector: ${msg}` };
  };
  if (!Array.isArray(v) || v.length !== DIMS) bad(`수 ${DIMS}개`);
  if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) bad("유한한 수만");
  for (const [from, to, mayBeZero] of [[0, MEL_BANDS, false], [MEL_BANDS, MEL_BANDS * 2, false], [MEL_BANDS * 2, DIMS, true]]) {
    const g = v.slice(from, to);
    const norm = Math.sqrt(g.reduce((s, x) => s + x * x, 0));
    // 무음처럼 프레임마다 로그멜이 같은 소리는 로그멜 묶음의 길이가 0이다. 누구와도 맞지 않는 값이라 등록하지 않는다(ADR-0023) —
    // 음성으로 등록하든 값으로 등록하든 같은 기준, 같은 문구.
    if (!mayBeZero && norm === 0) throw { status: 400, error: "말소리가 없어 등록할 수 없음" };
    if (Math.abs(g.reduce((s, x) => s + x, 0)) > 1e-6 || !(Math.abs(norm - 1) < 1e-6 || (mayBeZero && norm === 0))) bad("이 임베더의 정규화가 아님");
  }
  return v;
}

const FRAME = 512; // 32 ms @ 16 kHz
const HOP = 160; // 10 ms
const melCenters = Array.from({ length: MEL_BANDS + 2 }, (_, i) => {
  const mel = (hz) => 2595 * Math.log(1 + hz / 700);
  const low = mel(50);
  const high = mel(7600);
  return 700 * (Math.exp((low + ((high - low) * i) / (MEL_BANDS + 1)) / 2595) - 1);
});
const SILENT_FRAME = 1e-10; // 프레임의 평균 제곱이 이보다 작으면 무음(약 −100 dBFS)
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
    // 완전한 무음 프레임(디지털 0 — 에뮬레이터에 넣는 소리의 앞뒤·사이, 차가 원음 자리에 채운 무음)은 건너뛴다.
    // 넣으면 로그멜이 바닥값(−10)으로 찍혀 평균·분산이 크게 틀어진다: 15초 등록 음성 앞뒤에 0.3초만 있어도 같은 사람의 유사도가 0.45~0.9로 떨어졌다(11/15 실제 목소리).
    // 실제 마이크 소리에는 이런 프레임이 없어(16비트 최소 잡음도 1e-9쯤) 값이 바뀌지 않는다 — 시험 벡터도 그대로다.
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += (samples[off + i] - mean) ** 2;
    if (energy / FRAME < SILENT_FRAME) continue;
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
  if (!frames.length) throw { status: 400, error: samples.length >= FRAME ? "말소리가 없어 등록할 수 없음" : "소리가 너무 짧음" };
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

// 코사인 유사도. 저장된 벡터(double precision[])와 갓 만든 벡터를 비교한다.
export function similarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// 확신 기준. 초안 값 — 지환 시험 음성의 정확도 표로 조정한다(ADR-0019).
export const matchThreshold = () => Number(process.env.VOICE_MATCH_THRESHOLD ?? 0.9);

// 기기에서 하는 판정(차 안 대조)의 여백 규칙. 절대 기준 하나로는 실제 목소리가 잘 갈리지 않는다: 유사도가 전체로 낮게 나오는 소리는
// 누구와도 기준을 못 넘고, 높게 나오는 소리는 두 사람이 함께 넘어 틀린다. 그래서 후보가 둘 이상이면
// '가장 비슷한 사람이 바닥(floor) 이상이고 두 번째 사람보다 여백(margin) 이상 앞설 때'만 붙인다. 후보가 한 명이면 위의 절대 기준을 쓴다.
// 값은 실제 차 안 목소리 한 녹음의 조각 118개로 골랐다(11/15: 절대 기준 0.85 → 맞힘 55·틀림 14·모름 49, 이 규칙 → 69·12·37).
// 다른 목소리에서는 다를 수 있어 환경 변수로 둔다.
export const matchFloor = () => Number(process.env.VOICE_MATCH_FLOOR ?? 0.6);
export const matchMargin = () => Number(process.env.VOICE_MATCH_MARGIN ?? 0.06);
