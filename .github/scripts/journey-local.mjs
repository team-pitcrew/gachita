#!/usr/bin/env node
// 로컬 전용: 임시 Postgres + S3/ASR HTTP 대역 + 실제 서버 모듈. 외부 자격/서비스를 사용하지 않는다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { runJourney, wave } from "./journey-e2e.mjs";

const root = resolve(process.argv[2] ?? ".");
const scenario = process.argv[3] ?? "ready";
assert.ok(["ready", "asr-missing", "asr-disabled", "storage-missing"].includes(scenario), "scenario: ready | asr-missing | asr-disabled | storage-missing");
const id = `gachita-journey-${process.pid}-${randomUUID().slice(0, 6)}`;
const objects = new Map();
const seen = { puts: 0, gets: 0, deletes: 0, asr: 0 };
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const listen = async (handler) => { const server = createServer(handler); await new Promise((ok) => server.listen(0, "127.0.0.1", ok)); return server; };
const read = async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); };
const close = (server) => server && new Promise((ok) => server.close(ok));
let api, stores, s3, asr, result;
try {
  docker("run", "-d", "--name", id, "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=gachita", "-e", "POSTGRES_PASSWORD=gachita", "-e", "POSTGRES_DB=gachita", "postgres:17");
  const deadline = Date.now() + 60000;
  for (;;) {
    try { docker("exec", id, "pg_isready", "-h", "127.0.0.1", "-U", "gachita", "-q"); break; } catch { assert.ok(Date.now() < deadline, "Postgres 시작 시간 초과"); await sleep(300); }
  }
  const port = docker("port", id, "5432/tcp").split(":").at(-1);
  s3 = await listen(async (req, res) => {
    const body = await read(req);
    const url = new URL(req.url, "http://localhost");
    const key = decodeURIComponent(url.pathname).replace(/^\/clips\//, "");
    if (req.method === "PUT") { objects.set(key, body); seen.puts++; res.end(); return; }
    if (req.method === "POST" && url.searchParams.has("delete")) {
      for (const [, k] of body.toString().matchAll(/<Key>(.*?)<\/Key>/g)) { objects.delete(k); seen.deletes++; }
      res.writeHead(200, { "content-type": "application/xml" }); res.end("<DeleteResult></DeleteResult>"); return;
    }
    if (req.method === "GET" && objects.has(key)) { seen.gets++; res.end(objects.get(key)); return; }
    res.writeHead(404, { "content-type": "application/xml" }); res.end("<Error><Code>NoSuchKey</Code></Error>");
  });
  asr = await listen(async (req, res) => {
    const body = JSON.parse((await read(req)).toString());
    const prompt = body.messages?.[0]?.content?.[0]?.text ?? "";
    const draft = /draft from another recognizer \(may contain errors\): "(.*)"\. Context:/.exec(prompt)?.[1];
    if (!draft || req.headers.authorization !== "Bearer journey-fixture") { res.writeHead(400); res.end(); return; }
    seen.asr++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: draft.replace(/서와/g, "서아") + "." } }] }));
  });
  for (const key of ["PROFILES_DATABASE_URL", "TRIPS_DATABASE_URL", "ASR_URL", "ASR_TOKEN", "CLIPS_BUCKET", "AWS_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL"]) delete process.env[key];
  Object.assign(process.env, {
    DATABASE_URL: `postgres://gachita:gachita@127.0.0.1:${port}/gachita`,
    AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${s3.address().port}`, AWS_REGION: "ap-northeast-2", AWS_ACCESS_KEY_ID: "journey-fixture", AWS_SECRET_ACCESS_KEY: "journey-fixture",
    ...(scenario !== "storage-missing" ? { CLIPS_BUCKET: "clips" } : {}),
    ...(!scenario.startsWith("asr-") ? { ASR_URL: `http://127.0.0.1:${asr.address().port}/asr/v1`, ASR_TOKEN: "journey-fixture", ASR_GAP_MS: "20" } : {}),
  });
  const load = (name) => import(pathToFileURL(join(root, "backend/api", name)).href);
  (await load("log.js")).captureLog(() => {});
  api = await load("server.js"); stores = await load("db.js");
  await api.migrate();
  await new Promise((ok) => api.server.listen(0, "127.0.0.1", ok));
  result = await runJourney(`http://127.0.0.1:${api.server.address().port}`, { asr: scenario === "asr-disabled" ? "unverified" : "required", storage: "fixture", waitMs: scenario === "asr-missing" ? 800 : 10000, onStep: (name) => console.error(`✓ ${name}`) });
  // 클립 철회는 비동기 정리다. API 404뿐 아니라 HTTP 저장소 대역에서 실제 바이트가 없어졌는지 확인한다.
  const until = Date.now() + 5000;
  while (objects.size && Date.now() < until) await sleep(100);
  assert.equal(objects.size, 0, "finally 이후 저장소에 시험 클립이 남음");
  // 버킷 설정이 없으면 DELETE도 503이다. API 결과를 failed로 유지하고 아래 DB/객체 수로 잔존 여부를 따로 검증한다.
  assert.equal(result.cleanup.failures.length, scenario === "storage-missing" ? 1 : 0, "예상하지 않은 정리 실패");
  if (scenario === "storage-missing") {
    assert.equal(result.cleanup.failures[0].label, "클립");
    assert.match(result.cleanup.failures[0].message, /503/);
  }
  const residuals = (await stores.profilesDb().query(`SELECT
    (SELECT count(*)::int FROM profiles) AS profiles,
    (SELECT count(*)::int FROM tokens) AS tokens,
    (SELECT count(*)::int FROM voice_prints) AS voices,
    (SELECT count(*)::int FROM profile_moments) AS album,
    (SELECT count(*)::int FROM utterances) AS utterances,
    (SELECT count(*)::int FROM recordings WHERE deleted_at IS NULL) AS live_clips`)).rows[0];
  for (const [kind, count] of Object.entries(residuals)) assert.equal(count, 0, `정리 후 ${kind}가 남음`);
  result.cleanup.localDatabaseRowsRemaining = residuals;
  if (scenario === "ready") {
    assert.equal(result.status, "passed", JSON.stringify(result.failure));
    assert.ok(seen.puts >= 2 && seen.gets >= 1 && seen.deletes >= 2 && seen.asr >= 1, "S3·ASR HTTP 경로가 실제로 불려야 함");
    // 공용 DB나 시스템 시계를 바꾸지 않는다. 이 실행에서 만든 여행 한 줄의 시각만 앞당긴다.
    const base = `http://127.0.0.1:${api.server.address().port}`;
    const call = async (method, path, status, { body, raw, token } = {}) => {
      const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { "content-type": "application/json" } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(10000) });
      assert.equal(res.status, status, `만료 시험 ${method}: ${status} 기대`);
      const text = await res.text();
      return text && res.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null;
    };
    const profile = await call("POST", "/api/profiles", 201, { body: { name: "E2E 만료" } });
    // 프로필은 목소리까지 등록해야 여행에 들어간다(T173)
    await call("POST", "/api/profiles/me/voice", 200, { token: profile.token, body: { embedder: "logmel-pitch-1", vector: JSON.parse(readFileSync(new URL("../../backend/api/voice-vectors.json", import.meta.url), "utf8")).cases[0].vector, seconds: 7 } });
    const expiring = await call("POST", "/api/trips", 201, { body: { title: "E2E 만료 여정" } });
    const path = `/api/trips/${expiring.code}`;
    const rider = await call("POST", `${path}/participants`, 201, { token: profile.token, body: { seat: "ROW_1_LEFT", consent: true } });
    const moment = await call("POST", `${path}/moments`, 201, { token: rider.token, body: { at: expiring.createdAt, label: "E2E 만료 장면" } });
    await call("POST", `${path}/recordings?moment=${moment.id}&generation=1&from=${expiring.createdAt}`, 201, { token: rider.token, raw: wave(210, 3) });
    assert.equal(objects.size, 1);
    await stores.tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [expiring.code]);
    await api.sweep();
    const expiryDeadline = Date.now() + 5000;
    while (objects.size && Date.now() < expiryDeadline) await sleep(100);
    assert.equal(objects.size, 0, "만료 치우기 뒤 저장소 바이트가 남음");
    await call("GET", path, 404);
    assert.equal((await stores.tripsDb().query("SELECT count(*)::int AS n FROM recordings WHERE trip_code = $1", [expiring.code])).rows[0].n, 0);
    const album = await call("GET", "/api/profiles/me/feed", 200, { token: profile.token });
    assert.ok(album.items.some((x) => x.kind === "moment" && x.id === moment.id), "여행 만료 뒤에도 사람이 남긴 앨범 복사본은 보존");
    await call("DELETE", "/api/profiles/me", 204, { token: profile.token });
    result.expiry = "isolated-db-clock-advanced: trip 404, clip row/object 0, selected album preserved";
  } else if (scenario === "asr-disabled") {
    assert.equal(result.status, "partial"); assert.equal(seen.asr, 0, "ASR 설정이 없으면 외부로 보내지 않음");
  } else {
    assert.equal(result.status, "failed", "없는 필수 기능은 성공 처리하면 안 됨");
    assert.match(result.failure?.message ?? "", scenario === "asr-missing" ? /ASR 결과/ : /503/);
  }
  result.fixture = { scenario, observedHttpCalls: seen, objectsRemaining: objects.size, expectedFailure: scenario.endsWith("missing"), expectedPartial: scenario === "asr-disabled" };
} catch (error) {
  result ??= { status: "failed" };
  result.status = "failed"; result.harnessFailure = error.message; process.exitCode = 1;
} finally {
  await close(api?.server);
  await stores?.endStores();
  await close(s3); await close(asr);
  try { docker("rm", "-f", id); if (result?.cleanup) { result.cleanup.retainedTrips = []; result.cleanup.databaseRemoved = true; } } catch { result.status = "failed"; result.harnessFailure ??= "임시 DB 컨테이너 제거 실패"; process.exitCode = 1; }
  console.log(JSON.stringify(result, null, 2));
}
