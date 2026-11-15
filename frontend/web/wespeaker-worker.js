// wespeaker 값 일꾼(wespeaker.js가 연다). 모델(약 25 MB)과 onnxruntime-web(WASM, 스레드 1)을 이 일꾼 안에서 올리고 셈한다 — 화면은 멈추지 않는다.
// 받는 것 {id, type: "warm"} — 모델만 올림, {id, type: "embed", samples: Float32Array(16 kHz, 무음 뺀 것)} → 돌려주는 것 {id, value: Float32Array(256) | null}.
// 모델·실행기가 없거나(404) 올리지 못하면 늘 null(부르는 쪽은 1차 값만 쓴다). 표본은 셈한 뒤 이 일꾼에서도 버린다(남기지 않음).
import { fbank, MODEL, ORT } from "./wespeaker.js";

let loading = null;
const ready = () => (loading ??= (async () => {
  const ort = await import(`${ORT}ort.wasm.min.mjs`);
  ort.env.wasm.wasmPaths = ORT;
  ort.env.wasm.numThreads = 1; // 교차 출처 격리(COOP/COEP)가 없어 스레드를 쓸 수 없다
  const res = await fetch(MODEL);
  if (!res.ok) return null;
  const session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  return { ort, session };
})().catch(() => null));

onmessage = async ({ data: { id, type, samples } }) => {
  let value = null;
  try {
    const m = await ready();
    if (m && type === "embed") {
      const { feats, frames } = fbank(samples);
      value = (await m.session.run({ feats: new m.ort.Tensor("float32", feats, [1, frames, 80]) })).embs.data;
    }
  } catch { value = null; }
  postMessage({ id, value });
};
