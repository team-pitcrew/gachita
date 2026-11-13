import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { server } from "./server.js";

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test("공개 설정은 로그인 전에 Client ID만 주고, 교환 설정이 없으면 로그인을 열지 않는다", async () => {
  const names = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ASR_TOKEN"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.GOOGLE_CLIENT_ID = "test-public-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-private-client-value";
    process.env.ASR_TOKEN = "test-unrelated-private-value";
    const configured = await fetch(`${base}/api/config`);
    assert.equal(configured.status, 200);
    assert.equal(configured.headers.get("cache-control"), "no-store");
    assert.deepEqual(await configured.json(), { googleClientId: process.env.GOOGLE_CLIENT_ID });

    for (const [client, secret] of [[undefined, "configured"], ["configured", undefined], ["", "configured"], ["configured", "  "], ["  ", "configured"]]) {
      if (client === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = client;
      if (secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
      else process.env.GOOGLE_CLIENT_SECRET = secret;
      const disabled = await fetch(`${base}/api/config`);
      assert.equal(disabled.status, 200);
      assert.deepEqual(await disabled.json(), { googleClientId: "" });
    }

    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.equal((await fetch(`${base}/api/config`, { method })).status, 405);
    }
    assert.equal((await fetch(`${base}/api/config/private`)).status, 404);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
