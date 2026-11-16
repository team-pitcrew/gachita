// 콘텐츠 기록의 재생·내보내기: 항목에 서명 주소(mediaUrl, T178)가 있을 때와 없을 때(T180). 실제 contents.js를 돌리고 DOM·네트워크만 대신한다.
import assert from "node:assert/strict";
import test from "node:test";
import { createContents } from "./contents.js";

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.plays = 0; this.open = false; }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  set src(v) { this.attrs.src = v; }
  get src() { return this.attrs.src ?? ""; }
  set poster(v) { this.attrs.poster = v; }
  get poster() { return this.attrs.poster ?? ""; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] ?? []).filter((f) => f !== fn); }
  emit(name) { return Promise.all((this.listeners[name] ?? []).map((fn) => fn({ preventDefault() {} }))); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  play() { this.plays++; return Promise.resolve(); }
  pause() {}
  click() {}
  remove() {}
}
const walk = (el) => [el, ...el.children.filter((c) => c instanceof El).flatMap(walk)];
const text = (el) => (el instanceof El ? el.children.map(text).join("") : String(el));
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

const CDN = "https://media.test/shorts/c1/final.mp4?Expires=1&Signature=a&Key-Pair-Id=k";
const NEXT = "https://media.test/shorts/c1/final.mp4?Expires=2&Signature=b&Key-Pair-Id=k";
const FILE = "/api/trips/TRIP12/short-assets/c1/file";

async function fixture(t, { mediaUrl, thumbnailMediaUrl } = {}) {
  const body = new El("body"), calls = [], shared = [], tokens = [];
  const content = { id: "c1", at: 1_800_000_000_000, title: "바다가 보여", seconds: 32, kind: "device", url: FILE, thumbnailUrl: null, cast: [], ...(mediaUrl && { mediaUrl }), ...(thumbnailMediaUrl && { thumbnailMediaUrl }) };
  const state = { trips: () => [{ code: "TRIP12", title: "강릉", createdAt: content.at, me: { consent: true }, places: [], members: [], contents: [content] }], cdn: () => new Response("cdn-video", { headers: { "content-type": "video/mp4" } }) };
  const globals = { document: { body, hidden: false, getElementById: () => new El("p"), createElement: (tag) => new El(tag) }, addEventListener: () => {}, navigator: { canShare: () => true, share: async ({ files }) => void shared.push(files[0]) } };
  const before = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => { for (const [key, d] of before) { if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key]; } });
  t.mock.method(globalThis, "setInterval", () => 0);
  t.mock.method(URL, "createObjectURL", () => "blob:local-1");
  t.mock.method(URL, "revokeObjectURL", () => {});
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "/api/profiles/me/trips") return Response.json({ items: state.trips() });
    if (String(url) === FILE) return new Response("api-video", { headers: { "content-type": "video/mp4" } });
    return state.cdn(String(url));
  });
  const contents = createContents({ getProfileToken: () => "profile-token", getTrip: () => null, getParticipant: () => null, getParticipantToken: () => null,
    tokenFor: async (code) => { tokens.push(code); return "trip-token"; }, avatar: () => new El("span"), onHome() {}, onRide() {}, onTalk() {} });
  t.after(() => contents.close());
  await contents.open({ view: "player", selected: "c1" });
  await settle();
  const dialog = body.children[0];
  return {
    calls, shared, tokens, state, content,
    video: () => walk(dialog).find((el) => el.tag === "video"),
    files: () => calls.filter((c) => c.url !== "/api/profiles/me/trips"),
    lists: () => calls.filter((c) => c.url === "/api/profiles/me/trips").length,
    press: async (label) => { const b = walk(dialog).find((el) => el.tag === "button" && text(el).startsWith(label)); assert.ok(b, `단추 ${label}`); b.onclick(); await settle(); },
  };
}

test("서명 주소가 없으면 전처럼 그 여행의 참가자 토큰으로 파일을 받아 blob으로 튼다", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.files().map((c) => c.url), [FILE]);
  assert.equal(f.files()[0].options.headers.authorization, "Bearer trip-token");
  assert.equal(f.files()[0].options.cache, "no-store");
  assert.deepEqual(f.tokens, ["TRIP12"]);
  assert.equal(f.video().src, "blob:local-1");
  assert.equal(f.video().plays, 1);
});

test("서명 주소가 있으면 받아 두지 않고 <video>에 바로 건다(파일 요청도, 참가자 토큰도 쓰지 않는다)", async (t) => {
  const f = await fixture(t, { mediaUrl: CDN, thumbnailMediaUrl: "https://media.test/shorts/c1/thumbnail.png?Signature=p" });
  assert.equal(f.video().src, CDN);
  assert.equal(f.video().poster, "https://media.test/shorts/c1/thumbnail.png?Signature=p");
  assert.equal(f.video().plays, 1);
  assert.deepEqual(f.files(), []);
  assert.deepEqual(f.tokens, []);
});

test("서명이 만료돼 못 틀면 목록을 다시 읽어 새 주소로 한 번, 그래도 안 되면 전의 방식으로 받는다", async (t) => {
  const f = await fixture(t, { mediaUrl: CDN });
  const video = f.video(), lists = f.lists();
  f.content.mediaUrl = NEXT; // 다시 읽으면 서버가 새 서명을 준다
  await video.emit("error");
  await settle();
  assert.equal(f.lists(), lists + 1);
  assert.equal(video.src, NEXT);
  assert.deepEqual(f.files(), []);
  await video.emit("error"); // 새 주소도 안 됨(CDN 장애 등)
  await settle();
  assert.equal(f.lists(), lists + 1, "다시 읽기는 한 번만");
  assert.deepEqual(f.files().map((c) => c.url), [FILE]);
  assert.equal(f.files()[0].options.headers.authorization, "Bearer trip-token");
  assert.equal(video.src, "blob:local-1");
});

test("내보내기 파일은 서명 주소에서 권한 머리말 없이 받는다(토큰이 다른 출처로 나가지 않는다)", async (t) => {
  const f = await fixture(t, { mediaUrl: CDN });
  await f.press("영상 내보내기");
  await f.press("내 계정으로 폰에 저장");
  assert.deepEqual(f.files().map((c) => c.url), [CDN]);
  assert.equal(f.files()[0].options.headers, undefined);
  assert.equal(f.files()[0].options.credentials, "omit");
  assert.equal(f.shared.length, 1);
  assert.equal(f.shared[0].type, "video/mp4");
  assert.equal(await f.shared[0].text(), "cdn-video");
  assert.deepEqual(f.tokens, []);
});

test("내보내기에서 서명 주소가 만료됐고 새 주소도 없으면 참가자 토큰 경로로 받는다", async (t) => {
  const f = await fixture(t, { mediaUrl: CDN });
  f.state.cdn = () => new Response("expired", { status: 403 });
  await f.press("영상 내보내기");
  await f.press("내 계정으로 폰에 저장");
  assert.deepEqual(f.files().map((c) => c.url), [CDN, FILE]);
  assert.equal(f.files()[0].options.headers, undefined);
  assert.equal(f.files()[1].options.headers.authorization, "Bearer trip-token");
  assert.equal(await f.shared[0].text(), "api-video");
});
