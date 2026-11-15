import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { fbank, withoutSilence } from "./wespeaker.js";

const vectors = JSON.parse(readFileSync(new URL("./wespeaker-vectors.json", import.meta.url)));

// 시험용 합성 소리(사람 목소리 아님): 음높이가 오르내리는 배음 + 약한 잡음, 16 kHz, 결정적(LCG).
function synth(seconds, seed) {
  const n = Math.round(seconds * 16000), out = new Float32Array(n);
  let s = seed >>> 0, phase = 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) - 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / 16000, f0 = 140 + 40 * Math.sin(2 * Math.PI * 0.7 * t) + 15 * Math.sin(2 * Math.PI * 3.1 * t);
    phase += (2 * Math.PI * f0) / 16000;
    let v = 0;
    for (let k = 1; k <= 12; k++) v += Math.sin(k * phase) / k * (1 + 0.5 * Math.sin(2 * Math.PI * (0.3 + 0.1 * k) * t));
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.3 * t) ** 2;
    out[i] = Math.max(-1, Math.min(1, 0.12 * v * env + 0.01 * rnd()));
  }
  return out;
}

test("fbank은 sherpa-onnx와 같은 틀(80 bins, 10 ms, 앞뒤 반사)로 골든값을 낸다", () => {
  const { feats, frames } = fbank(synth(3, 7));
  assert.equal(frames, vectors.frames, "3초 → (48000 + 80) / 160 = 300 프레임(snip_edges=false)");
  assert.equal(feats.length, frames * 80);
  let sum = 0;
  for (const v of feats) sum += v;
  assert.ok(Math.abs(sum - vectors.fbankSum) < 0.5, `합 ${sum}`);
  vectors.fbankAt.indices.forEach((i, k) => assert.ok(Math.abs(feats[i] - vectors.fbankAt.values[k]) < 1e-3, `칸 ${i}: ${feats[i]}`));
});

test("디지털 무음(10 ms 묶음이 모두 0)만 뺀다 — 차 withoutSilence와 같은 규칙", () => {
  const x = new Float32Array(160 * 5);
  x.fill(0.1, 160, 320); // 둘째 묶음만 소리
  x[160 * 3 + 7] = 0.001; // 넷째 묶음은 한 표본만 0이 아님 → 남김
  const out = withoutSilence(x);
  assert.equal(out.length, 320);
  assert.equal(out[0], Math.fround(0.1));
  assert.equal(out[160 + 7], Math.fround(0.001));
  assert.equal(withoutSilence(new Float32Array(1000)).length, 0);
});

// 모델(서버 이미지가 주는 25 MB)과 onnxruntime-web이 이 기기에 있을 때만: 브라우저와 같은 실행기로 셈해 sherpa-onnx 값과 견준다.
// WESPEAKER_MODEL=…/wespeaker.onnx WESPEAKER_ORT=…/node_modules/onnxruntime-web node --test frontend/web/wespeaker.test.mjs
const model = process.env.WESPEAKER_MODEL, ortDir = process.env.WESPEAKER_ORT;
test("onnxruntime-web 값이 sherpa-onnx 2.0.1(차) 값과 같다", { skip: !(model && ortDir && existsSync(model)) && "모델·실행기 없음(WESPEAKER_MODEL, WESPEAKER_ORT)" }, async () => {
  const ort = await import(`${ortDir}/dist/ort.node.min.mjs`);
  const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(model)));
  const { feats, frames } = fbank(synth(3, 7));
  const e = (await session.run({ feats: new ort.Tensor("float32", feats, [1, frames, 80]) })).embs.data;
  const r = vectors.sherpa;
  let dot = 0, ne = 0, nr = 0;
  for (let i = 0; i < 256; i++) { dot += e[i] * r[i]; ne += e[i] ** 2; nr += r[i] ** 2; }
  assert.ok(dot / Math.sqrt(ne * nr) > 0.9999, `cos ${dot / Math.sqrt(ne * nr)}`);
});
