// 임베더의 공유 시험 벡터(ADR-0023). 차량 앱(Kotlin)이 같은 수식을 차 안에서 돌리므로, 두 구현이 같은 값을 내는지
// voice-vectors.json 한 파일로 묶는다: 이 시험은 voice.js가 파일과 같은 값을 내는지, 차량 단위 시험은 Kotlin 구현이
// 같은 파일의 값을 허용 오차(tolerance) 안에서 내는지 본다.
// 임베더를 고쳤으면 EMBEDDER 이름을 올리고 `UPDATE_VOICE_VECTORS=1 node --test voice-vectors.test.js`로 파일을 다시 만든다.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { checkVector, DIMS, embed, EMBEDDER, similarity } from "./providers/voice.js";

const FILE = new URL("voice-vectors.json", import.meta.url);

// 입력 신호는 정수 연산만으로 만든다 — 언어가 달라도(sin의 마지막 자리 차이 없이) 표본이 똑같게.
// 톱니파(주기 period 표본, 진폭 amp; period 0이면 없음) + 선형 합동 잡음(±noise). 표본은 16비트 값 / 32768.
export function signal({ n, period, amp, noise, seed }) {
  const out = new Float32Array(n);
  let x = seed | 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    const saw = period ? Math.floor(((i % period) * 2 * amp) / period) - amp : 0;
    out[i] = (saw + (((x >>> 16) % (2 * noise + 1)) - noise)) / 32768;
  }
  return out;
}

const INPUTS = [
  { name: "낮은 목소리 120 Hz 2초", n: 32000, period: 133, amp: 12000, noise: 300, seed: 1 },
  { name: "가운데 220 Hz 2초", n: 32000, period: 73, amp: 12000, noise: 300, seed: 2 },
  { name: "높은 목소리 300 Hz 2초", n: 32000, period: 53, amp: 9000, noise: 300, seed: 3 },
  { name: "같은 120 Hz, 다른 잡음 3초", n: 48000, period: 133, amp: 12000, noise: 300, seed: 4 },
  { name: "짧은 발화 0.5초", n: 8000, period: 73, amp: 12000, noise: 300, seed: 5 },
  { name: "거의 무음(음높이 없음)", n: 16000, period: 0, amp: 0, noise: 3, seed: 6 },
];

if (process.env.UPDATE_VOICE_VECTORS) {
  writeFileSync(FILE, JSON.stringify({
    embedder: EMBEDDER, dims: DIMS, tolerance: 1e-6,
    signal: "x = (x*1103515245 + 12345) 32비트 넘침; saw = period ? floor((i % period)*2*amp/period) - amp : 0; 표본 = (saw + ((x >>> 16) % (2*noise+1)) - noise) / 32768",
    cases: INPUTS.map((input) => ({ ...input, vector: embed(signal(input)) })),
  }, null, 1) + "\n");
}

const fixture = JSON.parse(readFileSync(FILE, "utf8"));

test("임베더가 공유 시험 벡터와 같은 값을 낸다(ADR-0023)", () => {
  assert.equal(fixture.embedder, EMBEDDER, "임베더를 고쳤으면 이름을 올리고 파일을 다시 만든다");
  assert.equal(fixture.dims, DIMS);
  assert.deepEqual(fixture.cases.map(({ vector, ...input }) => input), INPUTS);
  for (const c of fixture.cases) {
    const v = embed(signal(c));
    assert.equal(v.length, DIMS);
    for (let i = 0; i < DIMS; i++) assert.ok(Math.abs(v[i] - c.vector[i]) <= fixture.tolerance, `${c.name} [${i}]`);
    assert.doesNotThrow(() => checkVector(c.vector), `${c.name}: 값 등록의 모양 검사를 통과`);
  }
  const [low, mid, high, low2, , quiet] = fixture.cases.map((c) => c.vector);
  assert.ok(similarity(low, low2) > 0.99, "같은 목소리");
  assert.ok(similarity(low, mid) < 0.9 && similarity(low, high) < 0.9 && similarity(mid, high) < 0.9, "다른 음높이는 기준 아래");
  assert.ok(quiet.slice(52).every((x) => x === 0), "음높이를 못 잡으면 그 묶음은 0");
});

test("기기가 올린 값의 모양을 본다", () => {
  const ok = fixture.cases[0].vector;
  for (const bad of [null, "x", ok.slice(1), [...ok.slice(1), NaN], ok.map((x) => x * 2), ok.map((x) => x + 0.01), new Array(DIMS).fill(0)])
    assert.throws(() => checkVector(bad), (e) => e.status === 400);
});
