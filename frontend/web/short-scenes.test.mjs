import test from "node:test";
import assert from "node:assert/strict";
import { createScenePicker, sceneClipPath } from "./short-scenes.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.plays = 0; }
  append(...children) { for (const child of children) { child?.remove?.(); if (child instanceof Element) child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children.forEach((child) => { if (child instanceof Element) child.parent = null; }); this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; delete this[key]; }
  addEventListener() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  play() { this.plays++; return Promise.resolve(); }
  pause() {}
  load() {}
}
const elements = (el) => [el, ...el.children.filter((child) => child instanceof Element).flatMap(elements)];
const content = (el) => el instanceof Element ? el.children.map(content).join(" ") : String(el);
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const body = new Element("body"), toast = new Element("aside"), urls = [], revoked = [], calls = [], chosen = [], local = [];
  const descriptors = new Map(["document", "addEventListener"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.document = { body, hidden: false, getElementById: () => toast, createElement: (tag) => new Element(tag) };
  globalThis.addEventListener = () => {};
  for (const name of ["setTimeout", "setInterval", "clearTimeout", "clearInterval"]) t.mock.method(globalThis, name, () => 0);
  t.mock.method(URL, "createObjectURL", (blob) => { urls.push(blob); return `blob:scene-${urls.length}`; });
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  t.after(() => { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const trip = { code: "TRIP12", title: "함께한 여행", status: "parked", generation: 1, moments: [{ id: "scene", label: "바다가 보여", at: 1_800_000_000_000 }] };
  const me = { id: "me", consent: true };
  const source = { generation: 1, cast: [{ participantId: "me", name: "나", character: "basic" }], scenes: [{ momentId: "scene", label: "바다가 보여", clip: "/api/trips/TRIP12/recordings/scene", startAt: trip.moments[0].at, seconds: 24, cues: [{ device: "car", seq: 1, participantId: "me", start: 0, end: 3, text: "바다가 보여" }] }] };
  const data = { source, clip: () => Promise.resolve(new Response(new Blob(["wave"], { type: "audio/wav" }))) };
  t.mock.method(globalThis, "fetch", async (path, options) => { calls.push({ path, options }); return path.endsWith("/shortform") ? Response.json(data.source) : data.clip(); });
  const picker = createScenePicker({ getTrip: () => trip, getParticipant: () => me, getToken: () => "participant-token", onChoose: (id) => chosen.push(id), onLocal: (id) => local.push(id), onCandidates() {}, onCaptions() {} });
  t.after(() => picker.close());
  return { picker, body, trip, me, data, source, calls, urls, revoked, chosen, local, button: (label) => elements(body).find((el) => el.tag === "button" && content(el) === label) };
}

test("원음 주소는 현재 여행과 장면의 인증 경로만 허용한다", () => {
  const scene = { momentId: "scene", clip: "/api/trips/TRIP12/recordings/scene" };
  assert.equal(sceneClipPath("TRIP12", scene), scene.clip);
  assert.throws(() => sceneClipPath("OTHER1", scene));
  assert.throws(() => sceneClipPath("TRIP12", { ...scene, clip: "https://example.com/clip.wav" }));
});

test("원음은 인증해서 받은 뒤 장면을 재확인하고 같은 장면 ID로 제작한다", async (t) => {
  const f = fixture(t);
  await f.picker.open({ momentId: "scene" });
  await f.button("원음 듣기").onclick();
  assert.equal(f.urls.length, 1);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].options.headers.authorization, "Bearer participant-token");
  assert.equal(f.calls[1].options.cache, "no-store");
  assert.equal(elements(f.body).find((el) => el.tag === "audio").plays, 1);
  f.button("이 장면으로 쇼츠 만들기").onclick();
  assert.deepEqual(f.chosen, ["scene"]);
  assert.deepEqual(f.revoked, ["blob:scene-1"]);
  assert.equal(f.body.children.length, 0);
});

for (const change of ["close", "consent", "participant", "generation"]) {
  test(`원음 다운로드 중 ${change} 변경은 늦은 파일과 화면을 되살리지 않는다`, async (t) => {
    const f = fixture(t), response = defer(); f.data.clip = () => response.promise;
    await f.picker.open({ momentId: "scene" });
    const pending = f.button("원음 듣기").onclick();
    if (change === "close") f.picker.close();
    if (change === "consent") f.me.consent = false;
    if (change === "participant") f.me.id = "someone-else";
    if (change === "generation") f.trip.generation++;
    response.resolve(new Response(new Blob(["late wave"])));
    await pending;
    assert.equal(f.urls.length, 0);
    assert.equal(f.calls.length, 2, "닫힌 요청은 추가 인증 조회를 보내지 않음");
    assert.equal(f.body.children.length, 0);
  });
}

for (const removed of [false, true]) {
  test(`다운로드 뒤 ${removed ? "장면 삭제" : "자막 변경"} 시 원음을 재생하지 않는다`, async (t) => {
    const f = fixture(t);
    await f.picker.open({ momentId: "scene" });
    f.data.source = { ...f.source, scenes: removed ? [] : [{ ...f.source.scenes[0], cues: [{ ...f.source.scenes[0].cues[0], text: "새 자막", editVersion: 1 }] }] };
    await f.button("원음 듣기").onclick();
    assert.equal(f.urls.length, 0);
    assert.ok(content(f.body).includes("장면이 바뀌었어요"));
    f.picker.close();
  });
}

test("원음이 없는 장면은 제작 버튼을 제공하지 않고 기다릴 상태를 표시한다", async (t) => {
  const f = fixture(t); f.data.source.scenes = [];
  await f.picker.open({ momentId: "scene" });
  assert.equal(f.button("이 장면으로 쇼츠 만들기"), undefined);
  assert.ok(content(f.body).includes("아직 준비된 원음이 없어요"));
});

test("AI 길이에 맞지 않는 짧은 장면도 같은 장면의 기본 영상으로 이어진다", async (t) => {
  const f = fixture(t); f.source.scenes[0].seconds = 8;
  await f.picker.open({ momentId: "scene" });
  f.button("기본 영상으로 만들기").onclick();
  assert.deepEqual(f.local, ["scene"]);
  assert.deepEqual(f.chosen, []);
});
