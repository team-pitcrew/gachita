import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
function worker(fetch) {
  const handlers = new Map(), stored = new Map();
  const cache = { put: async (key, value) => stored.set(key, value), delete: async (key) => stored.delete(key) };
  vm.runInNewContext(source, {
    URL, Response, Date, fetch, location: { origin: "https://gachita.test" },
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
