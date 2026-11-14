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
