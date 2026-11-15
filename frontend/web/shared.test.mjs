// shared.js의 api()가 토큰 머리말과 실패를 약속대로 다루는지 본다. 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { test } from "node:test";
import { api, needsVoice } from "./shared.js";

const answer = (status, body) => async (url, init) => ((answer.last = { url, init }), new Response(body === undefined ? null : JSON.stringify(body), { status }));

test("토큰은 Bearer 머리말로, JSON 본문에는 형식을 붙인다", async () => {
  globalThis.fetch = answer(200, { ok: 1 });
  assert.deepEqual(await api("PATCH", "/trips/ABC", { consent: true }, "t".repeat(43)), { ok: 1 });
  assert.equal(answer.last.url, "/api/trips/ABC");
  assert.deepEqual(answer.last.init.headers, { authorization: `Bearer ${"t".repeat(43)}`, "content-type": "application/json" });
  assert.equal(answer.last.init.body, '{"consent":true}');
});

test("토큰이 없으면 머리말도 없고, 사진(Blob)은 그대로 보낸다", async () => {
  globalThis.fetch = answer(204);
  const photo = new Blob(["x"], { type: "image/jpeg" });
  assert.equal(await api("PUT", "/profiles/me/photo", photo), null);
  assert.deepEqual(answer.last.init.headers, {});
  assert.equal(answer.last.init.body, photo);
});

test("304는 null, 거절은 서버의 이유와 status, 닿지 않으면 status 0", async () => {
  globalThis.fetch = answer(304);
  assert.equal(await api("GET", "/trips/ABC?v=3"), null);
  globalThis.fetch = answer(401, { error: "참가자 토큰이 필요함" });
  await assert.rejects(api("PATCH", "/trips/ABC/participants/p1", { consent: true }), { status: 401, message: "참가자 토큰이 필요함" });
  globalThis.fetch = async () => new Response("<html>", { status: 502 });
  await assert.rejects(api("GET", "/trips/ABC"), { status: 502 });
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(api("GET", "/trips/ABC"), { status: 0 });
});

test("화면이 닫히면 진행 중인 읽기 요청도 취소할 수 있다", async () => {
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const controller = new AbortController();
  const pending = api("GET", "/profiles/me/feed", null, "test-token", controller.signal);
  controller.abort();
  await assert.rejects(pending, { status: 0 });
});

test("거절의 reason·missing을 오류에 싣고, '목소리 먼저'(409 voice_required)를 가린다", async (t) => {
  const missing = [{ profileId: "kid", name: "하은", child: true }];
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "하은님의 목소리가 없어요", type: "conflict", reason: "voice_required", missing }, { status: 409 }));
  const e = await api("POST", "/trips", { groupId: "g" }, "t").catch((x) => x);
  assert.equal(e.status, 409);
  assert.equal(e.reason, "voice_required");
  assert.deepEqual(e.missing, missing);
  assert.equal(needsVoice(e), true);
  assert.equal(needsVoice({ status: 409, reason: "seat_taken" }), false, "다른 409는 아님");
});
