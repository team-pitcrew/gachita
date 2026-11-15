// 폰 목소리 등록의 두 번째 값(T169): 차의 강한 화자 모델과 같은 wespeaker resnet34(256차원) 값을 이 기기 안에서 만든다.
// 소리는 폰을 떠나지 않고 값만 올린다(ADR-0023). 1차 값(voice-embed.js, logmel-pitch-1)은 그대로 먼저 올리고, 이 값은 뒤에서 셈해 따로 올린다.
// - 특징: sherpa-onnx 2.0.1(차 StrongVoice.kt)이 이 모델에 쓰는 kaldi fbank를 그대로 옮겼다 — 80 bins, 25/10 ms, snip_edges=false(앞뒤 반사),
//   dither 0, DC 빼기, 프리엠퍼시스 0.97, povey 창, 512 FFT, 멜 20–7600 Hz, log(max(e, FLT_EPSILON)), 표본 ×32768(모델 메타 normalize_samples=0),
//   평균 빼기(CMN) 없음. 맥에서 sherpa-onnx와 견준 값: cos 0.99999999999, 원소 최대 차이 7.7e-7(wespeaker.test.mjs의 합성 시험 벡터).
// - 실행: onnxruntime-web(WASM, 스레드 1)을 Worker에서 돌려 화면이 멈추지 않게 한다(중급 폰 어림 15초 소리 ≈ 8초).
// - 모델·실행기는 저장소에 없다. 서버 이미지가 공식 릴리스에서 받아 같은 출처로 준다(MODEL, ORT). 없거나(404) 못 돌면 null — 1차 값만 쓴다.
// - 데이터 절약 모드면 받지 않는다(모델 25 MB + 실행기 13 MB).

export const STRONG = "wespeaker-resnet34-v1";
export const MODEL = `/models/${STRONG}.onnx`; // sha256 e9848563…c39012(차와 같은 파일, wespeaker_en_voxceleb_resnet34_LM)
export const ORT = "/vendor/ort/1.27.0/";
const RATE = 16000;

const N = 400, SHIFT = 160, FFT = 512, BINS = 80, EPS = 1.1920928955078125e-7;
const melOf = (f) => 1127 * Math.log(1 + f / 700);
const win = Float64Array.from({ length: N }, (_, i) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)), 0.85));
const banks = Array.from({ length: BINS }, (_, m) => {
  const lo = melOf(20), d = (melOf(8000 - 400) - lo) / (BINS + 1), l = lo + m * d, c = l + d, r = c + d, w = new Float64Array(FFT / 2);
  for (let i = 0; i < FFT / 2; i++) { const mel = melOf((RATE / FFT) * i); if (mel > l && mel < r) w[i] = mel <= c ? (mel - l) / (c - l) : (r - mel) / (r - c); }
  return w;
});
const cosT = Float64Array.from({ length: FFT / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / FFT));
const sinT = Float64Array.from({ length: FFT / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / FFT));
function fft(re, im) {
  for (let i = 1, j = 0; i < FFT; i++) { let bit = FFT >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= FFT; len <<= 1) {
    const step = FFT / len;
    for (let i = 0; i < FFT; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = cosT[k * step], wi = sinT[k * step], a = i + k, b = a + len / 2;
      const vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
    }
  }
}

/** 16 kHz 모노(−1~1) → 로그 멜 fbank. 돌려주는 것: { feats: Float32Array(T×80), frames: T }. */
export function fbank(samples) {
  const n = samples.length, T = Math.floor((n + SHIFT / 2) / SHIFT), feats = new Float32Array(T * BINS);
  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  const at = (s) => samples[s < 0 ? -s - 1 : s >= n ? 2 * n - 1 - s : s] * 32768; // snip_edges=false: 앞뒤는 반사
  for (let t = 0; t < T; t++) {
    const start = t * SHIFT + SHIFT / 2 - N / 2;
    let mean = 0;
    for (let i = 0; i < N; i++) { re[i] = at(start + i); mean += re[i]; }
    mean /= N;
    for (let i = 0; i < N; i++) re[i] -= mean;
    for (let i = N - 1; i > 0; i--) re[i] -= 0.97 * re[i - 1];
    re[0] -= 0.97 * re[0];
    for (let i = 0; i < N; i++) re[i] *= win[i];
    re.fill(0, N); im.fill(0);
    fft(re, im);
    for (let m = 0; m < BINS; m++) {
      const w = banks[m]; let e = 0;
      for (let i = 0; i < FFT / 2; i++) if (w[i]) e += w[i] * (re[i] * re[i] + im[i] * im[i]);
      feats[t * BINS + m] = Math.log(Math.max(e, EPS));
    }
  }
  return { feats, frames: T };
}

/** 디지털 무음(10 ms 묶음이 모두 0)을 뺀다 — 차 StrongVoice.kt withoutSilence와 같은 규칙(같은 값을 내려면 같은 소리를 넣는다). */
export function withoutSilence(samples) {
  const out = new Float32Array(samples.length);
  let n = 0;
  for (let i = 0; i < samples.length; i += 160) {
    const part = samples.subarray(i, i + 160);
    if (part.some((v) => v !== 0)) { out.set(part, n); n += part.length; }
  }
  return out.slice(0, n);
}

// 일꾼(wespeaker-worker.js) 하나를 이 페이지에서 나눠 쓴다. 다 쓰고 1분 동안 부르지 않으면 닫아 메모리(약 130 MB)를 돌려준다.
let worker = null, idle = 0, seq = 0;
const waiting = new Map();
const saveData = () => globalThis.navigator?.connection?.saveData === true;
function ask(message, transfer = []) {
  if (!globalThis.Worker || saveData()) return Promise.resolve(null);
  if (!worker) {
    worker = new Worker(new URL("./wespeaker-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => { waiting.get(data.id)?.(data.value ?? null); waiting.delete(data.id); };
    worker.onerror = () => { for (const done of waiting.values()) done(null); waiting.clear(); worker?.terminate(); worker = null; };
  }
  clearTimeout(idle);
  const id = ++seq;
  return new Promise((done) => {
    waiting.set(id, (v) => { done(v); idle = setTimeout(() => { if (!waiting.size) { worker?.terminate(); worker = null; } }, 60_000); });
    worker.postMessage({ id, ...message }, transfer);
  });
}

/** 녹음 화면(P06·아이 P12)에 들어오면 모델을 미리 받아 둔다. 실패는 조용히 넘긴다. */
export const warmStrong = () => { if (!worker) ask({ type: "warm" }); }; // 화면을 다시 그릴 때마다 불러도 일꾼이 있으면 그대로

/** 16 kHz 모노 → POST /profiles/me/voice 본문 {embedder, vector, seconds}, 못 만들면 null. 표본은 일꾼으로 옮겨져 이쪽에서는 비워진다. */
export async function strongValue(mono) {
  const voice = withoutSilence(mono);
  if (voice.length < RATE / 2) return null; // 0.5초보다 짧으면 값을 내지 않는다(차와 같음)
  const seconds = Math.round((voice.length / RATE) * 100) / 100; // 옮기기 전에 잰다(옮기면 이쪽 배열은 비워진다)
  const vector = await ask({ type: "embed", samples: voice }, [voice.buffer]);
  return vector ? { embedder: STRONG, vector: Array.from(vector), seconds } : null;
}
