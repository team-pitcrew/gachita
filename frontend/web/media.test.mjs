// 서명 주소(mediaUrl·photoUrl)가 있을 때와 없을 때의 갈래(T180, media.js).
import assert from "node:assert/strict";
import test from "node:test";
import { attachSigned, mediaOn, mediaResponse, setMediaBase, signedUrl } from "./media.js";

const CDN = "https://media.test/shorts/a/final.mp4?Expires=1&Signature=s&Key-Pair-Id=k";
const NEXT = "https://media.test/shorts/a/final.mp4?Expires=2&Signature=t&Key-Pair-Id=k";
const video = () => new Response("video", { headers: { "content-type": "video/mp4" } });
const direct = () => Promise.resolve(new Response("direct"));
function net(t, answer) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => { calls.push({ url, options }); return answer(url, calls.length); });
  return calls;
}

test("서명 주소로 쓰는 것은 절대 http(s) 주소뿐이다", () => {
  assert.equal(signedUrl(CDN), CDN);
  assert.equal(signedUrl("http://localhost:9000/x.mp4"), "http://localhost:9000/x.mp4");
  for (const value of [undefined, null, "", "/api/trips/A/short-assets/x/file", "javascript:alert(1)", "blob:https://x/1", 7, {}]) assert.equal(signedUrl(value), null);
});

test("서명 주소가 없으면 그 자리에서 지금 경로를 부르고 다른 요청은 하지 않는다", async (t) => {
  const calls = net(t, () => assert.fail("서명 주소 없이 다른 곳을 부르면 안 됨"));
  let called = 0;
  const pending = mediaResponse({ url: undefined, renew: () => assert.fail("다시 읽지 않는다"), direct: () => { called++; return direct(); } });
  assert.equal(called, 1, "기다리지 않고 바로 부른다(전과 같은 순간)");
  assert.equal(await (await pending).text(), "direct");
  assert.equal(calls.length, 0);
});

test("서명 주소가 있으면 권한 머리말·쿠키·Referer 없이 그 주소에서 받는다", async (t) => {
  const calls = net(t, video);
  const res = await mediaResponse({ url: CDN, direct: () => assert.fail("지금 경로를 타면 안 됨") });
  assert.equal(await res.text(), "video");
  assert.deepEqual(calls.map((c) => c.url), [CDN]);
  assert.equal(calls[0].options.headers, undefined, "토큰이 다른 출처로 나가면 안 된다");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
});

test("만료(403)면 목록을 다시 읽어 새 주소로 한 번 더 받는다", async (t) => {
  const calls = net(t, (url) => (url === CDN ? new Response("expired", { status: 403 }) : video()));
  let renewed = 0;
  const res = await mediaResponse({ url: CDN, renew: async () => { renewed++; return NEXT; }, direct: () => assert.fail("새 주소로 받았으면 지금 경로를 타지 않는다") });
  assert.equal(await res.text(), "video");
  assert.equal(renewed, 1);
  assert.deepEqual(calls.map((c) => c.url), [CDN, NEXT]);
});

for (const [name, renew] of [["새 주소도 만료", async () => NEXT], ["새 주소가 같음", async () => CDN], ["새 주소가 없음", async () => undefined], ["다시 읽기 실패", () => { throw new Error("offline"); }], ["다시 읽을 길이 없음", undefined]]) {
  test(`서명 주소로 끝내 못 받으면 지금 경로로 받는다(${name})`, async (t) => {
    const calls = net(t, () => new Response("expired", { status: 403 }));
    const res = await mediaResponse({ url: CDN, renew, direct });
    assert.equal(await res.text(), "direct");
    assert.ok(calls.length <= 2, "새 주소는 한 번만 다시 해 본다");
  });
}

test("CDN에 닿지 못하거나(CORS 포함) 형식이 다르면 지금 경로로 받는다", async (t) => {
  net(t, () => { throw new TypeError("Failed to fetch"); });
  assert.equal(await (await mediaResponse({ url: CDN, direct })).text(), "direct");
  t.mock.restoreAll();
  net(t, () => new Response("<Error/>", { headers: { "content-type": "application/xml" } }));
  assert.equal(await (await mediaResponse({ url: CDN, direct, accept: (r) => r.headers.get("content-type") === "video/mp4" })).text(), "direct");
});

test("취소하면 다시 읽거나 지금 경로로 넘어가지 않는다", async (t) => {
  net(t, () => { throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(mediaResponse({ url: CDN, renew: () => assert.fail("다시 읽지 않는다"), direct: () => assert.fail("지금 경로를 타지 않는다") }), { name: "AbortError" });
});

test("미디어 CDN이 켜졌는지는 서버 설정(mediaBase)이 있을 때만 참이다", () => {
  assert.equal(mediaOn(), false);
  setMediaBase("https://media.test");
  assert.equal(mediaOn(), true);
  setMediaBase(undefined);
  assert.equal(mediaOn(), false);
});

// <video>·<audio>·<img> 대역: src를 걸고 error를 일으킬 수 있다.
function element(extra = {}) {
  const handlers = new Map();
  return Object.assign({
    currentTime: 0, paused: true, ended: false, plays: 0, attrs: {},
    set src(v) { this.attrs.src = v; }, get src() { return this.attrs.src ?? ""; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name) => handlers.delete(name),
    play() { this.plays++; return Promise.resolve(); },
    fail: () => handlers.get("error")?.(), loaded: () => handlers.get("loadeddata")?.(),
  }, extra);
}

test("요소에 서명 주소를 바로 건다. Referer를 보내지 않는다", () => {
  const img = element({ referrerPolicy: "" });
  attachSigned(img, CDN);
  assert.equal(img.src, CDN);
  assert.equal(img.referrerPolicy, "no-referrer");
});

test("재생 중 못 받으면 새 주소를 받아 보던 자리에서 잇고, 또 못 받으면 지금 경로로 넘긴다", async () => {
  const el = element();
  let renewed = 0, fallback = 0;
  attachSigned(el, CDN, { renew: async () => { renewed++; return NEXT; }, fallback: () => fallback++ });
  Object.assign(el, { currentTime: 12.5, paused: false });
  await el.fail();
  assert.equal(el.src, NEXT);
  assert.equal(el.currentTime, 12.5);
  assert.equal(el.plays, 1);
  assert.equal(fallback, 0);
  await el.fail();
  assert.equal(renewed, 1, "새 주소는 한 번만 받는다");
  assert.equal(fallback, 1);
  await el.fail();
  assert.equal(fallback, 1, "넘긴 뒤에는 더 지켜보지 않는다");
});

test("처음부터 만료된 주소였어도 재생을 걸어 둔 것이면 새 주소에서 재생하고, 멈춰 둔 것은 멈춘 채로 둔다", async () => {
  const playing = element({ paused: false });
  attachSigned(playing, CDN, { renew: async () => NEXT });
  await playing.fail();
  assert.equal(playing.src, NEXT);
  assert.equal(playing.plays, 1);

  const stopped = element({ paused: true, currentTime: 3 });
  attachSigned(stopped, CDN, { renew: async () => NEXT });
  stopped.currentTime = 3;
  await stopped.fail();
  assert.equal(stopped.src, NEXT);
  assert.equal(stopped.currentTime, 3);
  assert.equal(stopped.plays, 0);
});

test("새 주소가 실제로 받아진 뒤 또 만료되면 다시 한 번 새 주소를 받는다(연달아 실패할 때만 지금 경로로)", async () => {
  const el = element();
  const urls = [NEXT, "https://media.test/shorts/a/final.mp4?Expires=3&Signature=u&Key-Pair-Id=k"];
  let fallback = 0;
  attachSigned(el, CDN, { renew: async () => urls.shift(), fallback: () => fallback++ });
  await el.fail();
  assert.equal(el.src, NEXT);
  el.loaded(); // 새 주소로 재생이 됐다
  await el.fail(); // 한참 뒤 또 만료
  assert.match(el.src, /Expires=3/);
  assert.equal(fallback, 0);
  await el.fail(); // 받아진 적 없이 연달아 실패
  assert.equal(fallback, 1);
});

test("새 주소를 못 얻으면 바로 지금 경로로 넘기고, 그만 보라고 한 뒤의 실패는 무시한다", async () => {
  const el = element();
  let fallback = 0;
  attachSigned(el, CDN, { renew: async () => { throw new Error("offline"); }, fallback: () => fallback++ });
  await el.fail();
  assert.equal(fallback, 1);
  assert.equal(el.src, CDN);

  const other = element();
  const stop = attachSigned(other, CDN, { renew: () => assert.fail("그만 본 뒤에는 다시 읽지 않는다"), fallback: () => assert.fail("넘기지 않는다") });
  stop();
  await other.fail();
});
