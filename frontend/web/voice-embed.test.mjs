// 폰 임베더(voice-embed.js)가 서버(providers/voice.js)·차(Voice.kt)와 같은 값을 내는지 공유 시험 벡터로 본다(ADR-0023 4절).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decimate, DIMS, embed, EMBEDDER, quantize, RATE, voiceValue } from "./voice-embed.js";

const fixture = JSON.parse(readFileSync(new URL("../../backend/api/voice-vectors.json", import.meta.url), "utf8"));

// voice-vectors.test.js의 signal()과 같은 정수 연산(언어·기기가 달라도 표본이 같다).
function signal({ n, period, amp, noise, seed }) {
  const out = new Float32Array(n);
  let x = seed | 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    const saw = period ? Math.floor(((i % period) * 2 * amp) / period) - amp : 0;
    out[i] = (saw + (((x >>> 16) % (2 * noise + 1)) - noise)) / 32768;
  }
  return out;
}

test("폰 임베더가 공유 시험 벡터와 성분마다 1e-6 안에서 같다", () => {
  assert.equal(fixture.embedder, EMBEDDER);
  assert.equal(fixture.dims, DIMS);
  assert.ok(fixture.cases.length >= 6);
  for (const c of fixture.cases) {
    const v = embed(signal(c));
    assert.equal(v.length, DIMS, c.name);
    v.forEach((x, i) => assert.ok(Math.abs(x - c.vector[i]) <= fixture.tolerance, `${c.name} [${i}] ${x} ≠ ${c.vector[i]}`));
  }
});

test("16비트 눈금으로 맞춘 표본은 시험 신호를 바꾸지 않는다", () => {
  const s = signal(fixture.cases[0]);
  assert.deepEqual(quantize(s), s);
});

test("16 kHz로 줄이면 길이가 표본율 비만큼 줄고 평균을 남긴다", () => {
  const s = new Float32Array(48000).fill(0.25);
  const out = decimate(s, 48000);
  assert.equal(out.length, RATE);
  assert.ok(out.every((x) => Math.abs(x - 0.25) < 1e-7));
});

test("올리는 본문은 임베더 이름·값·초(소수 둘째 자리)", () => {
  const v = embed(signal(fixture.cases[1]));
  assert.deepEqual(voiceValue(v, 15.0049), { embedder: "logmel-pitch-1", vector: v, seconds: 15 });
});

test("소리가 프레임 하나보다 짧으면 서버와 같은 400 모양으로 거절한다", () => {
  assert.throws(() => embed(new Float32Array(100)), (e) => e.status === 400);
});
