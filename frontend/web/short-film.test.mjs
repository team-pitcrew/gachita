import assert from "node:assert/strict";
import test from "node:test";
import { CHARACTER_OPTIONS, characterKey, fitContain, filmSpeakers, filmTextLines, recordingFormat, exportShortFilm } from "./short-film.js";

test("원본 10유형의 큰·작은 20종을 선택하고 전신 비율을 유지한다", () => {
  assert.equal(CHARACTER_OPTIONS.length, 20);
  assert.equal(new Set(CHARACTER_OPTIONS.map(([key]) => key)).size, 20);
  assert.equal(characterKey("camping-small"), "camping-small");
  assert.equal(characterKey("../../other"), "basic");
  assert.deepEqual(fitContain(200, 400, { x: 0, y: 0, width: 300, height: 300 }), { x: 75, y: 0, width: 150, height: 300 });
});

test("지원 MIME을 확인해 MP4를 우선하고 WebM을 MP4로 이름 붙이지 않는다", () => {
  assert.equal(recordingFormat({ isTypeSupported: () => true }).mime, "video/mp4;codecs=avc1.42E01F,mp4a.40.2");
  assert.equal(recordingFormat({ isTypeSupported: (type) => type === "video/mp4" }).extension, "mp4");
  assert.equal(recordingFormat({ isTypeSupported: (type) => type === "video/webm" }).extension, "webm");
  assert.equal(recordingFormat({ isTypeSupported: () => false }), null);
});

test("실제 큐의 참가자만 말하는 사람으로 표시하고 미확인 화자에게 자리 이름을 붙이지 않는다", () => {
  const cast = [{ participantId: "a", name: "지우", seat: "ROW_1_LEFT" }, { participantId: "b", name: "지우", seat: "ROW_1_RIGHT" }, { participantId: "c", name: "하은" }];
  const scene = { cues: [{ start: 0, end: 2, participantId: "a" }, { start: 2, end: 4, participantId: "b" }, { start: 4, end: 6, participantId: "c" }, { start: 6, end: 8, participantId: null, seatArea: "ROW_1_LEFT" }] };
  assert.equal(filmSpeakers(cast, scene, 2.5).active, cast[1]);
  assert(filmSpeakers(cast, scene, 4.5).people.includes(cast[2]));
  assert.equal(filmSpeakers(cast, scene, 6.5).active.name, "말한 사람 미확인");
  assert.equal(filmSpeakers(cast, scene, 8).active, null);
});

test("한국어는 단어 경계로 줄을 바꾸고 긴 자막을 버리지 않는다", () => {
  const input = "함께 타는 오늘 아주아주긴단어도남겨요";
  const lines = filmTextLines(input, (s) => [...s].length, 8);
  assert.equal(lines.join("").replaceAll(" ", ""), input.replaceAll(" ", ""));
  assert(lines.every((line) => [...line].length <= 8));
  assert.equal(lines[0], "함께 타는 오늘");
});

function browserDoubles(t) {
  const keys = ["document", "Image", "HTMLCanvasElement", "AudioContext", "MediaStream", "MediaRecorder", "requestAnimationFrame", "cancelAnimationFrame"];
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const state = { tracks: [], contexts: [], recorders: [], decoded: 0 };
  const track = (kind) => { const item = { kind, stopped: false, stop() { this.stopped = true; } }; state.tracks.push(item); return item; };
  class Stream { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); } getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); } }
  const ctx = new Proxy({ measureText: (s) => ({ width: s.length * 16 }) }, { get: (target, key) => target[key] ?? (() => {}) });
  class Canvas { setAttribute() {} getContext() { return ctx; } captureStream() { return new Stream([track("video")]); } }
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, createElement: () => new Canvas() });
  globalThis.HTMLCanvasElement = Canvas;
  globalThis.Image = class { naturalWidth = 200; naturalHeight = 300; set src(_) { queueMicrotask(() => this.onload?.()); } };
  globalThis.MediaStream = Stream;
  globalThis.AudioContext = class {
    constructor() { state.contexts.push(this); this.started = performance.now(); this.destination = {}; }
    get currentTime() { return (performance.now() - this.started) / 1000; }
    resume() { return Promise.resolve(); } close() { this.closed = true; return Promise.resolve(); }
    decodeAudioData() { state.decoded++; return Promise.resolve({ duration: .03 }); }
    createMediaStreamDestination() { return { stream: new Stream([track("audio")]), disconnect() {} }; }
    createBufferSource() { let timer; return { connect() {}, disconnect() {}, start() { timer = setTimeout(() => this.onended?.(), 30); }, stop() { clearTimeout(timer); } }; }
  };
  globalThis.MediaRecorder = class {
    static isTypeSupported(type) { return type === "video/webm"; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; this.state = "inactive"; state.recorders.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["encoded-test-double"], { type: this.mimeType }) }); queueMicrotask(() => this.onstop?.()); }
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 2);
  globalThis.cancelAnimationFrame = clearTimeout;
  return state;
}

test("취소를 무시한 늦은 소리 응답은 영상 생성을 되살리지 않고 오디오 컨텍스트를 닫는다", async (t) => {
  const state = browserDoubles(t), controller = new AbortController();
  let release, started;
  const fetching = new Promise((resolve) => { started = resolve; });
  const result = exportShortFilm({ title: "합성 검증", cast: [], scene: { seconds: 1, cues: [] }, signal: controller.signal, canRead: () => true, checkAccess: async () => {}, getAudio: () => { started(); return new Promise((resolve) => { release = resolve; }); } });
  await fetching; controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  release(new ArrayBuffer(8)); await Promise.resolve();
  assert.equal(state.contexts[0].closed, true);
  assert.equal(state.decoded, 0);
  assert.equal(state.recorders.length, 0);
});

test("녹화에 소리·화면 트랙을 함께 넣고 실제 MIME으로 파일을 만든 뒤 트랙을 정리한다", async (t) => {
  const state = browserDoubles(t), controller = new AbortController();
  const file = await exportShortFilm({ title: "합성 검증", cast: [], scene: { label: "합성/장면", seconds: .03, cues: [] }, signal: controller.signal, canRead: () => true, checkAccess: async () => {}, getAudio: async () => new ArrayBuffer(8) });
  assert.equal(file.name, "합성_장면.webm"); assert.equal(file.type, "video/webm"); assert(file.size > 0);
  assert.deepEqual(state.recorders[0].stream.getTracks().map((t) => t.kind), ["video", "audio"]);
  assert(state.tracks.every((t) => t.stopped)); assert(state.contexts[0].closed);
});

test("녹화 도중 권한이 사라지면 파일을 반환하지 않고 소리·화면 트랙을 정리한다", async (t) => {
  const state = browserDoubles(t), controller = new AbortController();
  let allowed = true;
  const result = exportShortFilm({ title: "합성 검증", cast: [], scene: { seconds: .03, cues: [] }, signal: controller.signal, canRead: () => allowed, checkAccess: async () => {}, getAudio: async () => new ArrayBuffer(8), onProgress: () => { allowed = false; } });
  await assert.rejects(result, { name: "AbortError" });
  assert(state.tracks.every((t) => t.stopped)); assert(state.contexts[0].closed);
});

for (const stage of ["권한 조회", "클립 다운로드"]) {
  test(`${stage} 대기 중 화면을 떠나면 즉시 취소하고 돌아와도 늦은 응답으로 녹화를 시작하지 않는다`, async (t) => {
    const state = browserDoubles(t), controller = new AbortController();
    let release, reached, requestSignal;
    const ready = new Promise((resolve) => { reached = resolve; });
    const waiting = (signal) => { requestSignal = signal; reached(); return new Promise((resolve) => { release = resolve; }); };
    const result = exportShortFilm({ title: "합성 검증", cast: [], scene: { seconds: 1, cues: [] }, signal: controller.signal, canRead: () => true,
      checkAccess: stage === "권한 조회" ? waiting : async () => {}, getAudio: stage === "클립 다운로드" ? waiting : async () => new ArrayBuffer(8) });
    await ready;
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
    await assert.rejects(result, /화면을 벗어나/);
    assert(requestSignal.aborted); assert.equal(controller.signal.aborted, false);
    assert.equal(state.contexts[0].closed, true); assert.equal(state.recorders.length, 0);
    release(stage === "클립 다운로드" ? new ArrayBuffer(8) : undefined); await Promise.resolve();
    assert.equal(state.decoded, 0); assert.equal(state.recorders.length, 0);
  });
}

test("이미 숨겨진 화면에서는 권한 조회나 녹화를 시작하지 않는다", async (t) => {
  const state = browserDoubles(t), controller = new AbortController();
  document.hidden = true;
  let called = false;
  await assert.rejects(exportShortFilm({ title: "합성 검증", cast: [], scene: { seconds: 1, cues: [] }, signal: controller.signal, canRead: () => true,
    checkAccess: async () => { called = true; }, getAudio: async () => new ArrayBuffer(8) }), /화면을 벗어나/);
  assert.equal(called, false); assert.equal(state.recorders.length, 0); assert(state.contexts[0].closed);
});
