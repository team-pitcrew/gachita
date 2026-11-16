import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
function worker(fetch) {
  const handlers = new Map(), stored = new Map();
  const cache = { put: async (key, value) => stored.set(key, value), delete: async (key) => stored.delete(key) };
  vm.runInNewContext(source, {
    URL, URLSearchParams, Response, Date, fetch, location: { origin: "https://gachita.test", search: "" },
    addEventListener: (name, fn) => handlers.set(name, fn),
    caches: { open: async () => cache, match: async (key) => stored.get(key)?.clone() },
  });
  return {
    stored,
    async request(path) {
      let response;
      const pending = [];
      handlers.get("fetch")({ request: new Request(`https://gachita.test${path}`), respondWith: (value) => { response = value; }, waitUntil: (value) => pending.push(value) });
      const result = await response;
      await Promise.all(pending);
      return result;
    },
  };
}

test("오프라인에서도 오래된 여행 캐시를 나이 때문에 지우지 않는다", async () => {
  const app = worker(async () => { throw new Error("offline"); });
  const trip = { code: "TEST12", createdAt: Date.now() - 365 * 86400_000, generation: 2 };
  const key = "https://gachita.test/api/trips/TEST12";
  app.stored.set(key, Response.json(trip));
  assert.deepEqual(await (await app.request("/api/trips/TEST12")).json(), trip);
  assert.ok(app.stored.has(key));
});

test("서버가 삭제한 여행은 오래된 캐시로 되살리지 않는다", async () => {
  const app = worker(async () => new Response("deleted", { status: 404 }));
  const key = "https://gachita.test/api/trips/TEST12";
  app.stored.set(key, Response.json({ createdAt: 1 }));
  assert.equal((await app.request("/api/trips/TEST12")).status, 404);
  assert.equal(app.stored.has(key), false);
});

test("원음·자막·공유 API는 계속 캐시를 우회한다", async () => {
  const app = worker(async () => assert.fail("민감 API를 서비스 워커가 가로채면 안 됨"));
  for (const path of ["/api/trips/TEST12/recordings/moment", "/api/trips/TEST12/transcript", "/api/profiles/me/shares"]) {
    app.stored.set(`https://gachita.test${path}`, Response.json({ stale: true }));
    assert.equal(await app.request(path), undefined);
  }
});

test("app.js가 들여오는 화면 모듈은 모두 설치 때 받아 둔다(빠지면 끊긴 첫 화면이 모듈을 못 읽는다)", async () => {
  const shell = new Set(JSON.parse(source.match(/const SHELL = (\[.*?\]);/s)[1]));
  const seen = new Set(), todo = ["/app.js"];
  while (todo.length) {
    const path = todo.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = await readFile(new URL(`.${path}`, import.meta.url), "utf8");
    for (const [, spec] of text.matchAll(/^import [^;]*?from "(\.?\/[^"]+)"/gm)) todo.push(new URL(spec, `https://x${path}`).pathname);
  }
  assert.deepEqual([...seen].filter((p) => !shell.has(p)), []);
});

test("화자 모델·실행기(/models/, /vendor/)는 가로채지 않고 캐시 저장소에도 두지 않는다(브라우저 캐시가 맡음)", async () => {
  let fetched = 0;
  const app = worker(async () => (fetched++, new Response("x")));
  for (const path of ["/models/wespeaker-resnet34-v1.onnx", "/vendor/ort/1.27.0/ort-wasm-simd-threaded.wasm"]) assert.equal(await app.request(path), undefined, path);
  assert.equal(fetched, 0);
  assert.equal(app.stored.size, 0);
});

// ---- 화면 파일이 다른 주소(CDN의 커밋별 경로)에서 올 때(T180): app.js가 /sw.js?assets=<그 주소>로 등록한다 ----
const ASSETS = "https://media.test/public/web/abc123/";
const SHELL = JSON.parse(source.match(/const SHELL = (\[.*?\]);/s)[1]);
function assetWorker(fetch, { assets = ASSETS } = {}) {
  const handlers = new Map(), stored = new Map(), added = [];
  const url = (key) => new URL(key.url ?? key, "https://gachita.test").href;
  const cache = {
    put: async (key, value) => void stored.set(url(key), value), delete: async (key) => stored.delete(url(key)),
    match: async (key) => stored.get(url(key))?.clone(), keys: async () => [...stored.keys()].map((href) => ({ url: href })),
    add: async (key) => { added.push(key); stored.set(url(key), new Response("same-origin")); },
    addAll: async (keys) => { for (const key of keys) await cache.add(key); },
  };
  vm.runInNewContext(source, {
    URL, URLSearchParams, Response, Date, fetch, location: { origin: "https://gachita.test", search: assets ? `?assets=${encodeURIComponent(assets)}` : "" },
    addEventListener: (name, fn) => handlers.set(name, fn), skipWaiting: async () => {}, clients: { claim: async () => {} },
    caches: { open: async () => cache, match: async (key) => stored.get(url(key))?.clone() },
  });
  const lifecycle = async (name) => { let done; handlers.get(name)({ waitUntil: (p) => { done = p; } }); await done; };
  return {
    stored, added, install: () => lifecycle("install"), activate: () => lifecycle("activate"),
    async request(address, init) {
      let response;
      const pending = [];
      handlers.get("fetch")({ request: new Request(address, init), respondWith: (value) => { response = value; }, waitUntil: (value) => pending.push(value) });
      const result = await response;
      await Promise.all(pending);
      return result;
    },
  };
}

test("주소가 없으면(같은 출처로 줄 때) 전처럼 같은 출처의 목록을 그대로 받아 둔다", async () => {
  const app = assetWorker(async () => assert.fail("다른 주소에서 받으면 안 됨"), { assets: null });
  await app.install();
  assert.deepEqual(app.added, SHELL);
});

test("화면 파일이 다른 주소에서 오면 설치 때 그 주소에서 받아 둔다(같은 출처 사본을 다시 받지 않는다)", async () => {
  const fetched = [];
  const app = assetWorker(async (address, options) => { fetched.push({ address, options }); return new Response("cdn"); });
  await app.install();
  assert.deepEqual(app.added, ["/", "/manifest.webmanifest"], "같은 출처에서는 첫 화면과 매니페스트만");
  assert.deepEqual(fetched.map((f) => f.address).sort(), SHELL.filter((p) => !app.added.includes(p)).map((p) => ASSETS + p.slice(1)).sort());
  for (const f of fetched) assert.deepEqual({ ...f.options }, { mode: "cors", credentials: "omit" }, f.address);
  assert.equal(app.stored.size, SHELL.length);
  assert.ok(app.stored.has(`${ASSETS}app.js`) && app.stored.has(`${ASSETS}chars/basic.webp`) === false);
});

test("받아 두지 못한 파일이 있으면 설치가 실패한다(반쪽짜리 화면을 두지 않는다)", async () => {
  const app = assetWorker(async (address) => new Response("없음", { status: address.endsWith("/app.js") ? 404 : 200 }));
  await assert.rejects(app.install());
});

test("그 주소 아래 요청은 캐시 먼저, 없으면 CORS로 받아 둔다(끊겨도 다시 열린다)", async () => {
  let fetched = 0, online = true;
  const app = assetWorker(async (address, options) => {
    if (!online) throw new TypeError("offline");
    fetched++;
    assert.equal(options.mode, "cors");
    assert.equal(options.credentials, "omit");
    return new Response(`cdn ${address}`);
  });
  // <img>의 no-cors 요청도 CORS로 받아 둔다
  assert.equal(await (await app.request(`${ASSETS}chars/basic.webp`, { mode: "no-cors" })).text(), `cdn ${ASSETS}chars/basic.webp`);
  assert.equal(fetched, 1);
  online = false;
  assert.equal(await (await app.request(`${ASSETS}chars/basic.webp`)).text(), `cdn ${ASSETS}chars/basic.webp`);
  await assert.rejects(app.request(`${ASSETS}chars/cap.webp`), "받아 둔 적 없는 파일은 끊기면 실패");
});

test("브라우저 캐시의 CORS 없는 사본 때문에 실패하면 한 번은 새로 받고, 그래도 CORS로 못 받으면 요청 그대로 보내고 두지 않는다", async () => {
  const seen = [];
  const app = assetWorker(async (address, options) => {
    seen.push(address instanceof Request ? "요청 그대로" : options.cache ?? "기본");
    if (address instanceof Request) return new Response("opaque");
    if (!address.endsWith("ok.svg") || options.cache !== "reload") throw new TypeError("CORS");
    return new Response("fresh");
  });
  assert.equal(await (await app.request(`${ASSETS}ok.svg`)).text(), "fresh");
  assert.deepEqual(seen, ["기본", "reload"]);
  assert.ok(app.stored.has(`${ASSETS}ok.svg`));
  seen.length = 0;
  assert.equal(await (await app.request(`${ASSETS}no-cors.png`, { mode: "no-cors" })).text(), "opaque");
  assert.deepEqual(seen, ["기본", "reload", "요청 그대로"]);
  assert.equal(app.stored.has(`${ASSETS}no-cors.png`), false);
});

test("그 주소 밖의 다른 출처(서명 미디어·글꼴 등)와 구간 요청은 가로채지 않는다", async () => {
  const app = assetWorker(async () => assert.fail("가로채면 안 됨"));
  for (const address of ["https://media.test/shorts/a/final.mp4?Expires=1&Signature=s", "https://media.test/public/web/old999/app.js", "https://cdn.jsdelivr.net/gh/x/y.css"]) assert.equal(await app.request(address), undefined, address);
  assert.equal(await app.request(`${ASSETS}app.js`, { headers: { range: "bytes=0-99" } }), undefined);
  assert.equal(await app.request(`${ASSETS}app.js`, { method: "POST" }), undefined);
});

test("켜질 때 옛 판의 화면 파일만 지운다(같은 출처의 첫 화면·여행과 지금 판은 남긴다)", async () => {
  const app = assetWorker(async () => new Response("x"));
  for (const key of ["https://gachita.test/", "https://gachita.test/api/trips/TEST12", `${ASSETS}app.js`, "https://media.test/public/web/old999/app.js", "https://media.test/public/web/old999/chars/basic.webp"]) app.stored.set(key, new Response("x"));
  await app.activate();
  assert.deepEqual([...app.stored.keys()], ["https://gachita.test/", "https://gachita.test/api/trips/TEST12", `${ASSETS}app.js`]);

  const plain = assetWorker(async () => new Response("x"), { assets: null });
  for (const key of ["https://gachita.test/", `${ASSETS}app.js`]) plain.stored.set(key, new Response("x"));
  await plain.activate();
  assert.deepEqual([...plain.stored.keys()], ["https://gachita.test/"], "다시 같은 출처로 주게 되면 다른 주소의 사본을 모두 지운다");
});
