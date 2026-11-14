// 목소리 등록 파형(voice-meter.js): 막대가 실제 들어온 소리 크기를 따르고, 지난 칸은 멈추고, 같은 소리로 값을 만든다.
import assert from "node:assert/strict";
import test from "node:test";
import { levelOf, record, rmsOf, slotAt, startVoice } from "./voice-meter.js";
import { DIMS } from "./voice-embed.js";

test("RMS와 막대 높이 비율: 무음은 0, −5 dBFS 이상은 1, 그 사이는 dB에 비례", () => {
  assert.equal(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
  assert.equal(levelOf(0), 0);
  assert.equal(levelOf(0.001), 0); // −60 dBFS
  assert.equal(levelOf(0.6), 1);
  assert.ok(Math.abs(levelOf(0.01) - 0.3) < 1e-9); // −40 dBFS
});

test("칸 번호와 기록: 지금 칸은 잰 소리의 평균, 범위 밖 칸은 무시", () => {
  assert.equal(slotAt(0, 15, 30), 0);
  assert.equal(slotAt(7.5, 15, 30), 15);
  assert.equal(slotAt(99, 15, 30), 30);
  const m = { levels: new Float32Array(3), sums: new Float32Array(3), counts: new Uint16Array(3) };
  record(m, 0, 0.4); record(m, 0, 0.2); record(m, 1, 0.5); record(m, 5, 1);
  assert.deepEqual([...m.levels].map((x) => Math.round(x * 10) / 10), [0.3, 0.5, 0]);
});

// 브라우저 대신 쓰는 가짜 Web Audio: 분석기는 지금 소리(amp)의 사인파를, 처리 노드는 부를 때 넣은 표본을 준다.
function fakeAudio() {
  const state = { amp: 0, stopped: 0, closed: false, collect: null };
  class Ctx {
    sampleRate = 16000;
    destination = {};
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData(a) { for (let i = 0; i < a.length; i++) a[i] = state.amp * Math.sin(i / 3); } }; }
    createScriptProcessor() { state.collect = { connect() {}, onaudioprocess: null }; return state.collect; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { state.closed = true; return Promise.resolve(); }
  }
  globalThis.AudioContext = Ctx;
  const media = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => state.stopped++ }] }) };
  const feed = (seconds) => {
    // 0.1초 단위로 처리 노드에 120 Hz 톱니파를 넣는다(말소리 대신, 값 만들기용)
    for (let k = 0; k < seconds * 10; k++) {
      const data = new Float32Array(1600).map((_, i) => state.amp * (((i % 133) / 66.5) - 1));
      state.collect.onaudioprocess({ inputBuffer: { getChannelData: () => data } });
    }
  };
  return { state, media, feed };
}

test("녹음: 막대 칸이 들어온 소리를 따르고 15초에 멈추며, 값(112차원)만 만든다", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const tick = () => t.mock.timers.tick(50);
  const { state, media, feed } = fakeAudio();
  let changes = 0;
  const meter = await startVoice({ slots: 30, seconds: 15, media, onChange: () => changes++ });
  state.amp = 0.3; feed(0.4); tick(); tick(); // 0.4초: 첫 칸(0~0.5초)에 큰 소리
  const loud = meter.levels[0];
  assert.ok(loud > 0.6, `첫 칸이 큰 소리를 따른다(${loud})`);
  state.amp = 0.001; feed(0.6); tick(); // 1.0초: 셋째 칸에 거의 무음
  assert.ok(meter.levels[2] < 0.1, "조용하면 낮다");
  state.amp = 0.5; tick(); tick(); // 지금 칸은 소리를 따라 오르고, 지난 칸은 멈춰 있다
  assert.ok(meter.levels[2] > 0.4);
  assert.equal(meter.levels[0], loud);
  assert.equal(meter.levels[5], 0, "앞으로 칸은 비어 있다");
  state.amp = 0.3; feed(14);
  assert.equal(meter.done, true);
  assert.equal(meter.elapsed(), 15);
  assert.equal(state.stopped, 1);
  assert.ok(changes > 0);
  const { value, seconds } = await meter.finish();
  assert.equal(value.embedder, "logmel-pitch-1");
  assert.equal(value.vector.length, DIMS);
  assert.equal(seconds, 15);
  delete globalThis.AudioContext;
});

test("마이크를 열지 못하면 이유를 알린다(권한 거부)", async () => {
  const media = { getUserMedia: async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); } };
  await assert.rejects(startVoice({ slots: 30, media }), (e) => e.reason === "denied" && /권한/.test(e.message));
});
