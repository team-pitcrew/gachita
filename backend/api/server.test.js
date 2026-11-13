// 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { classify, migrate, server, sweep, verifyGoogleLink } from "./server.js";
import { captureLog } from "./log.js";
import { cues, suggest } from "./scenes.js";
import { endStores, profilesDb, tripsDb } from "./db.js";

let base;
let fakeProvider; // 가짜 구글(T21). code가 곧 사용자 번호다. 특수 code로 장애 상황도 낸다.
let tokenCalls = 0; // 가짜 구글이 받은 토큰 교환 수
let fakeS3; // 가짜 클립 버킷(T76). SDK의 표준 설정(AWS_ENDPOINT_URL_S3)으로 꽂는다 — IP 주소라 SDK가 경로 방식으로 부른다.
const s3 = { objects: new Map(), down: false, onPut: null, onDelete: null }; // onPut·onDelete: 올리거나 지우는 도중에 끼워 넣을 일(한 번)
let fakeAsr; // 가짜 Nemotron(T75). 초안의 '서와'를 '서아'로 고치고 마침표를 붙인다. 초안 낱말로 장애를 낸다
const asr = { calls: [], onCall: null }; // onCall: 첫 요청을 받은 뒤 답하기 전에 끼워 넣을 일(시험이 정함)
captureLog(() => {}); // 서버의 구조화 로그는 시험 출력에 섞지 않는다(T71 시험은 따로 받아 본다)
before(async () => {
  fakeProvider = createServer(async (req, res) => {
    const send = (status, body, raw) => {
      res.writeHead(status, { "content-type": raw ? "text/plain" : "application/json" });
      res.end(raw ?? JSON.stringify(body));
    };
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/token" && req.method === "POST") {
      tokenCalls++;
      const raw = await new Promise((ok) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => ok(body));
      });
      const code = new URLSearchParams(raw).get("code") ?? "";
      if (code === "bad-client") return send(400, { error: "invalid_client" });
      if (code === "bad-json") return send(200, null, "JSON이 아닌 응답");
      if (code === "down") return send(503, { error: "unavailable" });
      if (code === "overloaded") return send(429, { error: "rate_limited" });
      if (code === "no-token") return send(200, {});
      if (code === "slow") await new Promise((ok) => setTimeout(ok, 400));
      if (!code || code.startsWith("bad")) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: `at-${code}` });
    }
    if (url.pathname === "/userinfo" && req.method === "GET") {
      const at = /^Bearer at-(.+)$/.exec(req.headers.authorization ?? "");
      if (!at) return send(401, { error: "unauthorized" });
      if (at[1] === "no-info") return send(500, { error: "internal" });
      if (at[1] === "no-sub") return send(200, { name: "번호 없음" });
      return send(200, { sub: at[1], name: `구글-${at[1]}` });
    }
    send(404, {});
  });
  await new Promise((ok) => fakeProvider.listen(0, "127.0.0.1", ok));
  fakeS3 = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const key = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(/^\/clips\//, "");
    if (s3.down) return void (res.writeHead(503), res.end());
    if (req.method === "PUT") {
      s3.objects.set(key, Buffer.concat(chunks));
      await s3.onPut?.();
    }
    if (req.method === "POST" && req.url.includes("delete")) {
      // DeleteObjects: 본문의 <Key>들을 지운다
      const hook = s3.onDelete;
      s3.onDelete = null;
      await hook?.();
      for (const [, k] of Buffer.concat(chunks).toString().matchAll(/<Key>(.*?)<\/Key>/g)) s3.objects.delete(k);
      return void (res.writeHead(200, { "content-type": "application/xml" }), res.end("<DeleteResult></DeleteResult>"));
    }
    if (req.method === "GET" && !s3.objects.has(key)) return void (res.writeHead(404, { "content-type": "application/xml" }), res.end("<Error><Code>NoSuchKey</Code></Error>"));
    res.writeHead(200);
    res.end(req.method === "GET" ? s3.objects.get(key) : undefined);
  });
  await new Promise((ok) => fakeS3.listen(0, "127.0.0.1", ok));
  fakeAsr = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages[0].content[0].text;
    const draft = /draft from another recognizer \(may contain errors\): "(.*)"\. Context:/.exec(prompt)[1];
    asr.calls.push({ path: req.url, auth: req.headers.authorization, body, prompt, draft });
    const hook = asr.onCall;
    asr.onCall = null;
    await hook?.();
    const reply = (status, content) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : { error: {} })));
    if (draft.includes("고장")) return reply(500);
    if (draft.includes("붐빔") && asr.calls.filter((c) => c.draft === draft).length === 1) return reply(429);
    if (draft.includes("되풀이")) return reply(200, "되풀이 되풀이 되풀이 되풀이 되풀이 되풀이 되풀이 되풀이 ");
    if (draft === "가자") return reply(200, "싫어"); // 짧은 말인데 글자가 다 다름
    reply(200, `<spk:0> ${draft.replace(/서와/g, "서아")}.`);
  });
  await new Promise((ok) => fakeAsr.listen(0, "127.0.0.1", ok));
  Object.assign(process.env, { CLIPS_BUCKET: "clips", AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${fakeS3.address().port}`, AWS_REGION: "ap-northeast-2", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" });
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${fakeProvider.address().port}/token`;
  process.env.GOOGLE_USERINFO_URL = `http://127.0.0.1:${fakeProvider.address().port}/userinfo`;
  // 프로필 저장소를 여행 저장소와 다른 DB에 둔다(T23). 주소를 정하기 전에 그 DB을 만든다.
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const name = `${admin.database}_profiles`;
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.PROFILES_DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/?]*(\?.*)?$/, `/${name}`);
  await migrate();
  await migrate(); // 여러 번 실행해도 같아야 한다
  // 예전에 한 DB에 같이 두던 표가 남았으면 치운다.
  await tripsDb().query("DROP TABLE IF EXISTS voice_prints, profiles"); // make run(한 DB)이면 목소리 값이 프로필을 가리킨다(외래 키째 다시 만들어짐)
  await tripsDb().query("TRUNCATE trips");
  await profilesDb().query("TRUNCATE profiles CASCADE"); // 목소리 값(voice_prints)은 외래 키로 함께
  await new Promise((ok) => server.listen(0, () => ok((base = `http://localhost:${server.address().port}`))));
});
after(async () => {
  server.close();
  fakeProvider.close();
  fakeS3.close();
  fakeAsr.close();
  await endStores();
});

const OURS = "https://gachita.mangowhois.ai/auth/google"; // 구글이 코드를 돌려줄 우리 주소(T27)
const call = async (method, path, body, token) => {
  const res = await fetch(base + path, { method, body: body && JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  return [res.status, res.status === 304 || res.status === 204 ? null : await res.json()];
};
const join = (code, name, seat, consent = true) => call("POST", `/api/trips/${code}/participants`, { name, seat, consent });

test("여행 하나의 흐름: 참가, 자리, 동의와 기록, 부탁, 장면", async () => {
  const [created, trip] = await call("POST", "/api/trips", { title: "양양" });
  assert.equal(created, 201);
  assert.match(trip.code, /^[A-Z2-9]{6}$/);
  const t = `/api/trips/${trip.code}`;

  // 참가와 자리
  const [, driver] = await join(trip.code, "민준", "ROW_1_LEFT", true);
  assert.deepEqual(Object.keys(driver).sort(), ["consent", "id", "name", "seat", "token"], "좌석·공조 선호는 없음(11/13 계획)");
  assert.equal((await join(trip.code, "지우", "ROW_1_LEFT"))[0], 409, "같은 자리에는 한 사람만");
  const [, rider] = await join(trip.code, "지우", "ROW_1_RIGHT", false);
  assert.equal((await join(trip.code, "", "ROW_2_LEFT"))[0], 400, "이름이 비면 거절");
  assert.equal((await join(trip.code, "하늘", "TRUNK"))[0], 400, "없는 자리는 거절");

  // 한 명이라도 동의하지 않으면 주행을 시작해도 기록하지 않는다
  assert.equal((await call("PATCH", t, { status: "driving" }))[1].recording, false);
  assert.equal((await call("PATCH", t, { recording: true }))[0], 409);
  await call("PATCH", `${t}/participants/${rider.id}`, { consent: true }, rider.token);
  assert.equal((await call("PATCH", t, { recording: true }))[1].recording, true);

  // 자리는 토큰 없이 옮긴다(차 화면이 고름, T46)
  const [, moved] = await call("PATCH", `${t}/participants/${rider.id}`, { seat: "ROW_2_LEFT" });
  assert.equal(moved.seat, "ROW_2_LEFT");

  // 부탁: 두 건을 남기고 하나는 취소, 하나는 내비 반영까지
  const [, toilet] = await call("POST", `${t}/requests`, { by: rider.id, text: "화장실 가고 싶어" });
  const [, coffee] = await call("POST", `${t}/requests`, { by: driver.id, text: "쉴 때 커피도 사자" });
  assert.equal((await call("POST", `${t}/requests`, { by: "nobody", text: "x" }))[0], 400, "참가자만 부탁을 남김");
  assert.equal((await call("PATCH", `${t}/requests/${coffee.id}`, { status: "cancelled" }))[1].status, "cancelled");
  assert.equal((await call("PATCH", `${t}/requests/${coffee.id}`, { status: "held" }))[0], 409, "취소한 부탁은 되살리지 않음");
  assert.equal((await call("PATCH", `${t}/requests/${toilet.id}`, { status: "reflected" }))[0], 409, "수락 전에는 반영 완료가 아님");
  for (const status of ["proposed", "accepted", "held", "proposed", "accepted", "reflected", "done"]) {
    assert.equal((await call("PATCH", `${t}/requests/${toilet.id}`, { status }))[1].status, status);
  }

  // 장면의 시각과 위치
  assert.equal((await call("POST", `${t}/moments`, { lat: 37.75, lng: 128.87, label: "휴게소 농담" }))[0], 201);
  assert.equal((await call("POST", `${t}/moments`, { lat: 137, lng: 0 }))[0], 400);

  // 주차하면 기록을 마감한다. 바뀐 것이 없으면 304
  const [, parked] = await call("PATCH", t, { status: "parked" });
  assert.deepEqual([parked.recording, parked.moments.length, parked.requests.length], [false, 1, 2]);
  assert.equal((await call("PATCH", t, { recording: true }))[0], 409, "주차 뒤에는 기록하지 않음");
  assert.equal((await call("GET", `${t}?v=${parked.version}`))[0], 304);
  assert.equal((await call("GET", `/api/trips/${trip.code.toLowerCase()}`))[0], 200, "코드는 대소문자를 가리지 않음");

  // 위치 없는 장면도 저장한다(ADR-0007): 목록에는 있고 지도에는 없다
  assert.equal((await call("POST", `${t}/moments`, { label: "어두운 터널" }))[0], 201);
  assert.equal((await call("POST", `${t}/moments`, { lat: 37.7 }))[0], 400, "좌표는 둘 다 있거나 둘 다 없음");
});

test("동의 켜기는 본인의 참가자 토큰으로만, 끄기와 자리는 누구나(T68)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, a] = await join(trip.code, "민준", "ROW_2_LEFT", false);
  const [, b] = await join(trip.code, "하늘", "ROW_2_RIGHT", false);
  const on = (p, token, extra) => call("PATCH", `${t}/participants/${p.id}`, { consent: true, ...extra }, token);

  const [s401, e401] = await on(a);
  assert.deepEqual([s401, e401.type], [401, "unauthenticated"], "토큰 없이 켜지 못함");
  assert.equal((await on(a, "z".repeat(43)))[0], 401, "이 여행의 참가자 토큰이 아님");
  const [s403, e403] = await on(a, b.token);
  assert.deepEqual([s403, e403.type], [403, "forbidden"], "남의 토큰으로 켜지 못함");
  assert.equal((await on(a, b.token, { seat: "ROW_1_LEFT" }))[0], 403);
  assert.equal((await call("GET", t))[1].participants.find((p) => p.id === a.id).seat, "ROW_2_LEFT", "거절되면 자리도 그대로");
  const [s200, mine] = await on(a, a.token);
  assert.deepEqual([s200, mine.consent], [200, true], "본인 토큰으로 켬");

  // 끄기와 자리는 토큰 없이. 켜져 있던 동의를 끄면 세대가 오른다
  assert.deepEqual((await call("PATCH", `${t}/participants/${a.id}`, { consent: false }))[1].consent, false);
  assert.equal((await call("GET", t))[1].generation, 2);
  assert.equal((await call("PATCH", `${t}/participants/${b.id}`, { seat: "ROW_1_RIGHT" }))[0], 200);
  assert.equal((await call("PATCH", `${t}/participants/nobody`, { consent: true }, a.token))[0], 404);

  // 다시 참가해도 앞 기기의 토큰은 산다: 가장 최근 것과 그 앞의 4개
  const [, me] = await call("POST", "/api/profiles", { name: "엄마" });
  const [, first] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: false }, me.token);
  const tokens = [first.token];
  for (let i = 0; i < 5; i++) tokens.push((await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT" }, me.token))[1].token);
  assert.equal(new Set(tokens).size, 6, "기기마다 다른 토큰");
  for (const i of [5, 4, 1]) assert.equal((await on(first, tokens[i]))[0], 200, `토큰 ${i}`);
  assert.equal((await on(first, tokens[0]))[0], 401, "다섯 번 전에 받은 토큰은 밀려남");
  // 옛 파드(배포 중·되돌린 이미지)는 tokenHash만 읽는다: 거기 가장 최근 토큰이 있다
  const doc = (await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
  assert.equal(doc.participants.find((p) => p.id === first.id).tokenHash, createHash("sha256").update(tokens[5]).digest("hex"));
});

test("프로필: 발급, 토큰으로 본인 확인, 프로필로 참가하면 이름과 동의 기본값을 가져온다", async () => {
  const [created, me] = await call("POST", "/api/profiles", { name: "지우", prefs: { passenger: { tempC: 23 } }, consentDefault: true });
  assert.equal(created, 201);
  assert.match(me.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(me.prefs, undefined, "좌석·공조 선호는 받지도 돌려주지도 않는다(옛 클라이언트가 보내도 무시)");

  // 서버에는 토큰이 아니라 해시만 남는다(기기 토큰 표, T45)
  const { rows } = await profilesDb().query("SELECT t.token_hash FROM tokens t JOIN profiles p ON p.id = t.profile_id WHERE p.id = $1", [me.id]);
  assert.equal(rows[0].token_hash.length, 32);
  assert.ok(!rows[0].token_hash.toString("latin1").includes(me.token));

  assert.equal((await call("GET", "/api/profiles/me"))[0], 401, "토큰이 없으면 거절");
  assert.equal((await call("GET", "/api/profiles/me", null, "x".repeat(43)))[0], 401, "모르는 토큰은 거절");
  const [, seen] = await call("GET", "/api/profiles/me", null, me.token);
  assert.deepEqual([seen.name, seen.token], ["지우", undefined], "토큰은 발급할 때만 준다");

  // 프로필로 참가: 이름·동의를 프로필에서 가져온다
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [joined, p] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT" }, me.token);
  assert.deepEqual([joined, p.name, p.consent, p.prefs], [201, "지우", true, undefined]);
  const [again, same] = await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT" }, me.token);
  assert.deepEqual([again, same.id, same.seat], [200, p.id, "ROW_1_RIGHT"], "같은 프로필이 다시 참가하면 있던 참가자를 돌려준다");
  assert.equal((await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT" }, "y".repeat(43)))[0], 401);

  // 저장은 Postgres에 한다: 서버가 돌려준 것과 표의 문서가 같다.
  // 참가자 토큰 해시는 문서 안에만 있는다(응답에는 절대 안 나간다).
  const stored = (await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
  for (const p of stored.participants) delete p.tokenHash, delete p.olderTokenHashes;
  assert.deepEqual(stored, (await call("GET", t))[1]);

  // 고치기와 지우기
  const [, patched] = await call("PATCH", "/api/profiles/me", { name: "지우개", prefs: { rear: { vent: 7 } } }, me.token);
  assert.deepEqual([patched.name, patched.prefs], ["지우개", undefined], "선호는 보내도 무시");
  assert.equal((await call("DELETE", "/api/profiles/me", null, me.token))[0], 204);
  assert.equal((await call("GET", "/api/profiles/me", null, me.token))[0], 401, "지운 프로필의 토큰은 못 쓴다");
});

test("잘못된 요청은 서버를 죽이지 않고 거절한다", async () => {
  assert.equal((await call("GET", "/api/trips/ZZZZZZ"))[0], 404);
  assert.equal((await fetch(`${base}/api/trips`, { method: "POST", body: "{" })).status, 400);
  assert.equal((await fetch(`${base}/api/trips`, { method: "POST", body: "x".repeat(20_000) })).status, 413);
  assert.equal((await fetch(`${base}/..%2F..%2Fbackend%2Fapi%2Fserver.js`)).status, 404, "웹앱 폴더 밖은 내보내지 않음");
  assert.equal((await call("GET", "/healthz"))[0], 200);
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /가치타/);
});

test("여행 저장소와 프로필 저장소가 서로 다른 DB에 있다(T23)", async () => {
  assert.equal((await tripsDb().query("SELECT to_regclass('profiles')")).rows[0].to_regclass, null, "여행 DB에 프로필 표가 없다");
  assert.equal((await profilesDb().query("SELECT to_regclass('trips')")).rows[0].to_regclass, null, "프로필 DB에 여행 표가 없다");
});

test("주소가 같아도 저장소마다 풀을 따로 둔다", async () => {
  // DATABASE_URL 하나만 쓰는 실행에서 프로필 조회가 여행 풀의 연결을 빌리면,
  // 여행 줄을 잠근 채 연결을 기다려 서버가 멈춘다(리뷰 재현). 풀이 나뉘면 고리가 안 생긴다.
  const saved = process.env.PROFILES_DATABASE_URL;
  delete process.env.PROFILES_DATABASE_URL;
  delete process.env.TRIPS_DATABASE_URL;
  const fresh = await import("./db.js?same-url"); // 쿼리를 붙여 새 모듈로 만든다. 풀은 첫 호출 때 만들어진다
  assert.notEqual(fresh.tripsDb(), fresh.profilesDb());
  await fresh.endStores();
  process.env.PROFILES_DATABASE_URL = saved;
});

test("구글 OAuth: 기기 프로필에 연결하고, 다른 기기에서 계정으로 이어 받는다(T21)", async () => {
  const link = (body, token) => call("POST", "/api/profiles/me/links/google", body, token);

  // 기기 프로필에 연결한다. 이름은 그대로, 토큰은 새로 주지 않는다.
  const [, me] = await call("POST", "/api/profiles", { name: "민준" });
  const [linked, after] = await link({ code: "code-1", redirectUri: "http://localhost:5173/cb" }, me.token);
  assert.equal(linked, 200);
  assert.deepEqual([after.name, after.links], ["민준", ["google"]]);
  assert.equal(after.token, undefined, "연결할 때는 토큰을 새로 주지 않는다");

  // 이미 다른 프로필에 연결된 계정은 거절한다.
  const [, other] = await call("POST", "/api/profiles", { name: "다른 사람" });
  assert.equal((await link({ code: "code-1", redirectUri: OURS }, other.token))[0], 409);

  // 토큰 없이 같은 계정으로 찾아 들어가면 같은 프로필과 이 기기 토큰을 준다.
  // 기기마다 토큰이 따로이므로 앞선 기기의 토큰도 그대로 쓸 수 있다(T45, ADR-0009).
  const [status, again] = await link({ code: "code-1", redirectUri: OURS });
  assert.equal(status, 200);
  assert.equal(again.id, after.id);
  assert.match(again.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(again.token, me.token);
  assert.equal((await call("GET", "/api/profiles/me", null, me.token))[0], 200, "앞선 기기의 토큰도 그대로 쓸 수 있음");

  // 그 토큰으로 여행에 참가한다(티켓의 완료 기준).
  const [, trip] = await call("POST", "/api/trips", {});
  const [joined, p] = await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_1_LEFT" }, again.token);
  assert.deepEqual([joined, p.name], [201, "민준"]);

  // 처음 보는 계정이면 프로필을 새로 만든다. 이름은 제공자가 준 값을 쓴다.
  const [created, fresh] = await link({ code: "code-2", redirectUri: OURS });
  assert.deepEqual([created, fresh.name, fresh.links], [201, "구글-code-2", ["google"]]);

  // 연결을 끊는다. 끊은 뒤 다시 끊으면 404.
  assert.equal((await call("DELETE", "/api/profiles/me/links/google", null, again.token))[0], 204);
  const [, cut] = await call("GET", "/api/profiles/me", null, again.token);
  assert.deepEqual(cut.links, []);
  assert.equal((await call("DELETE", "/api/profiles/me/links/google", null, again.token))[0], 404);

  // 제공자가 거절한 코드는 401.
  assert.equal((await link({ code: "bad-1", redirectUri: OURS }))[0], 401);
});

test("제공자 오류를 코드 거절과 장애으로 나눠 알린다(T21)", async () => {
  const link = (code) => call("POST", "/api/profiles/me/links/google", { code, redirectUri: OURS });
  assert.deepEqual(await link("bad-grant").then(([, b]) => b.error), "제공자가 코드를 거절함");
  assert.equal((await link("down"))[0], 503, "제공자 503은 일시 장애");
  assert.equal((await link("overloaded"))[0], 503, "제공자 429도 일시 장애");
  assert.equal((await link("bad-client"))[0], 500, "클라이언트 설정 오류는 사용자 잘못이 아님");
  assert.equal((await link("bad-json"))[0], 502, "읽을 수 없는 응답");
  assert.equal((await link("no-token"))[0], 502, "접근 토큰이 없는 응답");
  assert.equal((await link("no-info"))[0], 502, "사용자 정보 조회 실패");
  assert.equal((await link("no-sub"))[0], 502, "사용자 번호가 없는 응답");
  // 코드를 돌려받는 주소는 우리 출처만: 구글을 부르기 전에 거절한다(T27). 정상 코드여도 400
  const via = (redirectUri) => call("POST", "/api/profiles/me/links/google", { code: "code-77", redirectUri }).then(([s]) => s);
  const before = tokenCalls;
  for (const bad of [
    "https://evil.example/cb", "http://gachita.mangowhois.ai/cb", "https://gachita.mangowhois.ai.evil.example/cb", "https://gachita.mangowhois.ai@evil.example/cb",
    "https://user:pw@gachita.mangowhois.ai/cb", "blob:https://gachita.mangowhois.ai/x", "https://GACHITA.mangowhois.ai/cb", "https://gachita.mangowhois.ai",
    "http://localhost.evil.example/cb", "http://evil.example@localhost/", "http:localhost/cb", "https://localhost/cb", "http://[::1]/", "javascript:alert(1)", "x",
  ]) {
    assert.equal(await via(bad), 400, bad);
  }
  assert.equal(tokenCalls, before, "거절한 주소로는 구글을 부르지 않는다");
  assert.equal(await via("http://127.0.0.1:8787/"), 201, "로컬 개발 주소");
  // 시간 제한을 짧게 두고 제공자가 늦게 답하면 504, 아예 연결이 안 되면 503.
  process.env.GOOGLE_TIMEOUT_MS = "150";
  try {
    assert.equal((await link("slow"))[0], 504, "늦은 응답은 시간 초과");
    const saved = process.env.GOOGLE_TOKEN_URL;
    process.env.GOOGLE_TOKEN_URL = "http://127.0.0.1:9/token";
    assert.equal((await link("code-3"))[0], 503, "연결 실패는 일시 장애");
    process.env.GOOGLE_TOKEN_URL = saved;
  } finally {
    delete process.env.GOOGLE_TIMEOUT_MS;
  }
});

test("조회 뒤 구글 연결이 바뀌면 오래된 계정으로 토큰을 받지 못한다(T21)", async () => {
  const [, me] = await call("POST", "/api/profiles", { name: "주인" });
  const [, after] = await call("POST", "/api/profiles/me/links/google", { code: "code-9", redirectUri: OURS }, me.token);
  // 찾아 들어가기 요청이 연결 확인을 마친 뒤, 소유자가 다른 구글 계정으로 갈아끼운 상황(결정적 재현).
  await profilesDb().query("UPDATE profiles SET provider_user_id = 'code-B' WHERE id = $1", [after.id]);
  assert.equal(await verifyGoogleLink(after.id, "code-9"), null, "연결이 바뀌었으면 확인은 0행");
  assert.ok((await verifyGoogleLink(after.id, "code-B"))?.id, "지금 연결된 계정으로는 확인됨");
  // 바뀐 뒤 오래된 계정이 다시 로그인하면 새 프로필이 만들어진다(그 계정의 연결은 없으므로).
  const [s, again] = await call("POST", "/api/profiles/me/links/google", { code: "code-9", redirectUri: OURS });
  assert.deepEqual([s, again.links], [201, ["google"]]);
  assert.notEqual(again.id, after.id);
});

test("발화를 기록본으로 저장하고 프로필 피드로 읽는다(T39)", async () => {
  const [, trip] = await call("POST", "/api/trips", { title: "강릉" });
  const t = `/api/trips/${trip.code}`;
  const at = (s) => trip.createdAt + s * 1000;
  // 화자는 서버의 대조(T38)만 붙인다. 이 시험에서는 그 결과를 표에 바로 적는다.
  const speak = (seqs, profileId) =>
    tripsDb().query("UPDATE utterances SET profile_id = $3 WHERE trip_code = $1 AND seq = ANY($2::bigint[])", [trip.code, seqs, profileId]);

  // 참가자 토큰: 프로필·손님 모두 참가 응답에 한 번씩 받는다(ADR-0007)
  const [, meA] = await call("POST", "/api/profiles", { name: "아빠" });
  const [, meB] = await call("POST", "/api/profiles", { name: "아들" });
  const [ja, pa] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, meA.token);
  const [jb, pb] = await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT", consent: true }, meB.token);
  const [jg, pg] = await join(trip.code, "민준", "ROW_2_RIGHT", true);
  assert.ok([ja, jb, jg].every((s) => [200, 201].includes(s)));
  for (const p of [pa, pb, pg]) assert.match(p.token, /^[A-Za-z0-9_-]{43}$/);

  // 발화 묶음: 순서는 섞여도 좋고 다시 보내도 중복되지 않는다(멱등). 올리는 쪽이 붙인 profileId는 받지 않는다.
  const items = [
    { seq: 3, at: at(3), text: "바다는 왜 짜?", seatArea: "ROW_2_LEFT", profileId: meA.id, confidence: 0.9, lat: 37.7, lng: 128.9 },
    { seq: 1, at: at(1), text: "강릉 얼마나 남았어?", seatArea: "ROW_1_LEFT" },
    { seq: 2, at: at(2), text: "휴게소 가자", seatArea: null },
  ];
  const [u1, r1] = await call("POST", `${t}/utterances`, { device: "car", generation: 1, items }, pa.token);
  assert.deepEqual([u1, r1.lastSeq], [200, 3], "1~3을 다 받으면 마지막 순번은 3. 좌석 구역을 모르는 발화도 받는다");
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [items[1]] }, pa.token);
  // 순번 1이 빠진 기기는 빠짐없이 받은 마지막이 0이다
  const [, r2] = await call("POST", `${t}/utterances`, { device: "car-2", items: [{ seq: 5, at: at(5), text: "콜라 사줘", seatArea: "ROW_2_RIGHT", generation: 1 }] }, pg.token);
  assert.equal(r2.lastSeq, 0);
  await speak([1, 2], meA.id);
  await speak([3], meB.id);

  // 인증과 검증
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [] }))[0], 401, "토큰 없이는 못 올림");
  assert.equal((await call("GET", `${t}/utterances`))[0], 401);
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 6, at: 1, text: "x", lat: 37 }] }, pa.token))[0], 400, "좌표는 둘 다 있거나 둘 다 없음");
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", items: [{ seq: 6, at: 1, text: "x" }] }, pa.token))[0], 400, "세대는 꼭 적는다");
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 2, items: [{ seq: 6, at: 1, text: "x" }] }, pa.token))[0], 400, "아직 없는 세대");
  assert.equal((await call("GET", `${t}/utterances?device=car&after=abc`, null, pa.token))[0], 400);
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 6, at: 1.5, text: "x" }] }, pa.token))[0], 400, "시각은 정수(epoch ms)");
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [] }, pg.token))[0], 403, "기기 이름은 처음 올린 참가자의 것");

  // 64 KB가 넘는 묶음도 조각 경계에서 한글이 깨지지 않는다
  const long = Array.from({ length: 300 }, (_, i) => ({ seq: i + 1, at: at(10), text: "가".repeat(200), generation: 1 }));
  assert.equal((await call("POST", `${t}/utterances`, { device: "car2", items: long }, pa.token))[1].lastSeq, 300);
  const [, car2] = await call("GET", `${t}/utterances?device=car2`, null, pa.token);
  assert.ok(car2.items.every((u) => u.text === "가".repeat(200)), "글자가 그대로");
  await tripsDb().query("DELETE FROM utterances WHERE trip_code = $1 AND device = 'car2'", [trip.code]);

  // 기록본: 발화 시간순 + 부탁 함께. 도착 할 일은 아직 비어 있다
  const [, q] = await call("POST", `${t}/requests`, { by: pg.id, text: "화장실 가고 싶어" });
  assert.ok(q.id);
  const [, tr] = await call("GET", `${t}/transcript`, null, pa.token);
  assert.deepEqual(tr.utterances.map((u) => u.text), ["강릉 얼마나 남았어?", "휴게소 가자", "바다는 왜 짜?", "콜라 사줘"]);
  assert.deepEqual(tr.utterances[2], { device: "car", seq: 3, at: at(3), text: "바다는 왜 짜?", seatArea: "ROW_2_LEFT", profileId: meB.id, confidence: 0.9, lat: 37.7, lng: 128.9 });
  assert.equal(tr.utterances[1].seatArea, null);
  assert.equal(tr.requests.length, 1);
  assert.deepEqual(tr.todos, []);

  // 다시 참가하면(다른 기기) 이 기기의 참가자 토큰을 더 받고, 앞 기기의 토큰도 그대로 쓴다(T68)
  const [again, same] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT" }, meA.token);
  assert.deepEqual([again, same.id], [200, pa.id]);
  assert.notEqual(same.token, pa.token);
  assert.equal((await call("GET", `${t}/utterances`, null, pa.token))[0], 200, "앞 기기의 토큰도 산다");
  const freshA = same.token;

  // 피드: 자기 발화만, 최신순
  const [, feedA] = await call("GET", "/api/profiles/me/feed", null, meA.token);
  const [, feedB] = await call("GET", "/api/profiles/me/feed", null, meB.token);
  assert.deepEqual(feedA.items.filter((i) => i.kind === "utterance").map((i) => i.text), ["휴게소 가자", "강릉 얼마나 남았어?"]);
  assert.deepEqual(feedB.items.map((i) => i.text), ["바다는 왜 짜?"]);

  // 장면 확정: 고른 사람(참가자 토큰의 주인)의 앨범에만 복사된다(ADR-0014). 본문으로 남을 고른 사람으로 만들 수 없다
  const [, mom] = await call("POST", `${t}/moments`, { at: at(2.5), lat: 37.75, lng: 128.9, label: "휴게소 농담", by: pb.id }, freshA);
  const [, feedA2] = await call("GET", "/api/profiles/me/feed", null, meA.token);
  assert.deepEqual([feedA2.items[0].kind, feedA2.items[0].label, feedA2.items[0].tripCode], ["moment", "휴게소 농담", trip.code]);
  const [, feedB2] = await call("GET", "/api/profiles/me/feed", null, meB.token);
  assert.ok(feedB2.items.every((i) => i.kind === "utterance"), "고른 사람의 앨범에만");
  assert.equal((await call("POST", `${t}/moments`, { label: "터널" }, "x".repeat(43)))[0], 401, "틀린 참가자 토큰은 거절");
  assert.equal((await call("POST", `${t}/moments`, { label: "터널" }))[0], 201, "토큰 없이 남긴 장면은 여행에만");
  const [, feedA3] = await call("GET", "/api/profiles/me/feed", null, meA.token);
  assert.equal(feedA3.items.filter((i) => i.kind === "moment").length, 1);

  // 앨범의 장면 복사본을 지운다. 여행의 moments는 그대로다
  assert.equal((await call("DELETE", `/api/profiles/me/moments/${mom.id}`, null, meA.token))[0], 204);
  assert.equal((await call("DELETE", `/api/profiles/me/moments/${mom.id}`, null, meA.token))[0], 404);
  const [, tripNow] = await call("GET", t);
  assert.equal(tripNow.moments.length, 2);

  // 동의 철회: 세대가 오르고 옛 세대 발화는 폐기된다. 철회 전에 받아 적은 발화는 저장하지 않되
  // 받은 것으로 쳐서 확인 순번이 앞으로 간다 — 차량이 같은 묶음을 끝없이 다시 보내지 않는다(ADR-0007)
  await call("PATCH", `${t}/participants/${pb.id}`, { consent: false });
  const [, gone] = await call("GET", `${t}/utterances`, null, freshA);
  assert.deepEqual([gone.items.length, gone.generation], [0, 2], "철회 전에 받은 발화는 폐기됨");
  await call("PATCH", `${t}/participants/${pb.id}`, { consent: false });
  assert.equal((await call("GET", t))[1].generation, 2, "이미 꺼진 동의를 다시 꺼도 세대는 그대로");
  assert.equal((await call("GET", `${t}/transcript`, null, pb.token))[0], 403, "녹음에 동의한 참가자만 읽음");
  const late = [
    { seq: 4, generation: 1 }, // 철회 전에 받아 적은 것: 차량은 내용을 버리고 순번만 보낸다
    { seq: 5, at: at(11), text: "다시 시작", generation: 2 },
    { seq: 6, at: at(12), text: "응 좋아", generation: 2 },
  ];
  const [s403] = await call("POST", `${t}/utterances`, { device: "car", items: late }, freshA);
  assert.equal(s403, 403, "동의하지 않은 탑승자가 있는 동안은 받지 않는다");
  await call("PATCH", `${t}/participants/${pb.id}`, { consent: true }, pb.token);
  assert.equal((await call("GET", t))[1].generation, 2, "동의를 다시 켜도 세대는 그대로");
  const [s3, r3] = await call("POST", `${t}/utterances`, { device: "car", items: late }, freshA);
  assert.deepEqual([s3, r3.lastSeq, r3.generation], [200, 6, 2], "확인 순번은 지워진 줄을 넘어 앞으로만 간다");
  const [, kept] = await call("GET", `${t}/utterances?device=car&after=0`, null, freshA);
  assert.deepEqual(kept.items.map((u) => u.text), ["다시 시작", "응 좋아"]);
  await speak([5], meA.id);
  await speak([6], meB.id);

  // 자기 글 지우기: 손님은 못 지우고, 프로필 참가자는 자기 발화만. 다른 사람의 글과 확인 순번은 그대로다
  assert.equal((await call("DELETE", `${t}/utterances`, null, pg.token))[0], 403);
  const [del, delBody] = await call("DELETE", `${t}/utterances`, null, freshA);
  assert.deepEqual([del, delBody.deleted], [200, 1]);
  const [, tr2] = await call("GET", `${t}/transcript`, null, freshA);
  assert.deepEqual(tr2.utterances.map((u) => u.text), ["응 좋아"], "다른 사람의 글은 남는다");
  const [, feedA4] = await call("GET", "/api/profiles/me/feed", null, meA.token);
  assert.equal(feedA4.items.filter((i) => i.kind === "utterance").length, 0);
  const [, r4] = await call("POST", `${t}/utterances`, { device: "car", generation: 2, items: [{ seq: 7, at: at(13), text: "다음" }] }, freshA);
  assert.equal(r4.lastSeq, 7, "지운 뒤에도 확인 순번은 뒤로 가지 않는다");
  // 지운 글은 같은 순번이 늦게 다시 올라와도 되살아나지 않는다(순번에 빈자리가 있던 기기의 재전송)
  await call("POST", `${t}/utterances`, { device: "car", generation: 2, items: [{ seq: 5, at: at(11), text: "다시 시작" }] }, freshA);
  assert.deepEqual((await call("GET", `${t}/transcript`, null, freshA))[1].utterances.map((u) => u.text), ["응 좋아", "다음"]);
  // 여행 하나의 발화는 2만 줄까지(48시간 지우기가 2초 안에 끝나게)
  await tripsDb().query(
    "INSERT INTO utterances (trip_code, device, seq, at, text, generation) SELECT $1, 'bulk', g, g, 'x', 2 FROM generate_series(1, 19999) g",
    [trip.code]
  );
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 2, items: [{ seq: 8, at: at(14), text: "넘침" }] }, freshA))[0], 409);
  await tripsDb().query("DELETE FROM utterances WHERE trip_code = $1 AND device = 'bulk'", [trip.code]);

  // 48시간이 지나면 발화와 확인 순번은 지워지고 앨범에 확정해 둔 장면만 남는다(기준 문서: 선택한 장면만 개인 앨범에)
  const [, mom2] = await call("POST", `${t}/moments`, { label: "바다" }, freshA);
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [trip.code]);
  await call("POST", "/api/trips", {}); // 여행 만들기가 묵은 여행과 발화를 치운다
  const left = await tripsDb().query(
    "SELECT (SELECT count(*) FROM utterances WHERE trip_code = $1)::int AS u, (SELECT count(*) FROM utterance_acks WHERE trip_code = $1)::int AS a",
    [trip.code]
  );
  assert.deepEqual(left.rows[0], { u: 0, a: 0 }, "발화는 여행과 같은 시계에 지워짐");
  assert.equal((await call("GET", `${t}/utterances`, null, freshA))[0], 404, "여행이 닫혔다");
  const [, feedA5] = await call("GET", "/api/profiles/me/feed", null, meA.token);
  assert.deepEqual(feedA5.items.map((i) => i.id), [mom2.id]);
});

test("가족 그룹과 초대: 대표·아이·수락, 기기 토큰(T45)", async () => {
  // 대표가 가족 그룹을 만든다
  const [, mom] = await call("POST", "/api/profiles", { name: "엄마", character: "bunny" });
  const [cg, g] = await call("POST", "/api/groups", { kind: "family", name: "우리가족" }, mom.token);
  assert.equal(cg, 201);
  assert.deepEqual([g.kind, g.name, g.ownerId === mom.id, g.members.length], ["family", "우리가족", true, 1]);

  // 계정 없는 아이 프로필을 대표가 만든다(토큰 없음)
  const [ck, kid] = await call("POST", `/api/groups/${g.id}/members`, { name: "아들", character: "bear" }, mom.token);
  assert.deepEqual([ck, kid.name, kid.character], [201, "아들", "bear"]);
  assert.equal((await call("POST", `/api/groups/${g.id}/members`, { name: "x" }))[0], 401, "대표 토큰이 필요함");

  // 초대를 만들면 QR에 담을 주소가 돌아온다
  const [ci, inv] = await call("POST", `/api/groups/${g.id}/invites`, { expiresInMinutes: 60, maxUses: 2 }, mom.token);
  assert.equal(ci, 201);
  assert.match(inv.url, /^https:\/\/gachita\.mangowhois\.ai\/j\/[A-Za-z0-9_-]{16,}$/);
  const code = inv.url.split("/").pop();

  // 거절된 수락은 횟수를 쓰지 않는다
  assert.equal((await call("POST", `/api/j/${code}`, {}))[0], 400, "이름 없음");
  assert.equal((await call("POST", `/api/j/${code}`, { name: "x" }, "A".repeat(43)))[0], 401, "틀린 토큰");

  // 수락 1: 계정이 없는 사람 — 새 프로필과 이 기기 토큰을 받고 구성원이 된다
  const [ca, a] = await call("POST", `/api/j/${code}`, { name: "아빠", device: "phone" });
  assert.deepEqual([ca, a.group.name, a.profile.name, a.profile.character], [200, "우리가족", "아빠", ""]);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call("POST", `/api/j/${code}`, {}, a.token))[0], 200, "이미 구성원이면 QR을 다시 찍어도 횟수를 쓰지 않음");

  // 수락 2: 프로필이 있는 사람(토큰 헤더) — 있던 프로필로 구성원이 된다
  const [, uncle] = await call("POST", "/api/profiles", { name: "삼촌" });
  const [cb, b] = await call("POST", `/api/j/${code}`, {}, uncle.token);
  assert.equal(cb, 200);
  assert.equal(b.profile.id, uncle.id);
  assert.equal(b.token, undefined, "있던 프로필이면 토큰을 새로 주지 않음");

  // 횟수(2)가 다 찼다
  assert.equal((await call("POST", `/api/j/${code}`, { name: "다른 사람" }))[0], 409, "다 찬 초대");

  // 취소와 만료
  const [, inv2] = await call("POST", `/api/groups/${g.id}/invites`, { expiresInMinutes: 60 }, mom.token);
  assert.equal((await call("DELETE", `/api/groups/${g.id}/invites/${inv2.code}`, null, mom.token))[0], 204);
  assert.equal((await call("POST", `/api/j/${inv2.code}`, { name: "누구" }))[0], 409, "취소된 초대");
  await profilesDb().query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE code = $1", [inv2.code]);
  assert.equal((await call("POST", `/api/j/${inv2.code}`, { name: "누구" }))[0], 409, "만료된 초대");
  assert.equal((await call("POST", "/api/j/ZZZZZZZZ", { name: "x" }))[0], 404, "없는 초대");

  // 같은 프로필의 두 기기 토큰은 서로를 끊지 않는다(티켓 완료 기준)
  const [ct, car] = await call("POST", "/api/profiles/me/tokens", { device: "car" }, mom.token);
  assert.equal(ct, 201);
  const [, fromCar] = await call("GET", "/api/profiles/me", null, car.token);
  const [, fromPhone] = await call("GET", "/api/profiles/me", null, mom.token);
  assert.deepEqual([fromCar.id, fromCar.character, fromPhone.id], [mom.id, "bunny", mom.id]);

  // 그룹 여행: 대표가 만들면(그룹 지정) 수락한 사람은 여행 코드를 받아 자리만 골라 참가한다. 아이 프로필로도 참가시킨다
  const [ctr, trip] = await call("POST", "/api/trips", { title: "마트", groupId: g.id }, mom.token);
  assert.equal(ctr, 201);
  assert.equal((await call("POST", "/api/trips", { groupId: g.id }, uncle.token))[0], 403, "대표만 그룹 여행을 만듦");
  const [ckj, kp] = await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_LEFT", profileId: kid.profileId }, mom.token);
  assert.deepEqual([ckj, kp.name, kp.consent], [201, "아들", false], "아이는 동의 기본값 꺼짐");
  const [, stranger] = await call("POST", "/api/profiles", { name: "모르는 사람" });
  assert.equal((await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_RIGHT", profileId: stranger.id }, mom.token))[0], 403, "내 그룹의 구성원만");
  assert.equal((await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_RIGHT", profileId: uncle.id }, mom.token))[0], 403, "계정 있는 어른의 자리와 동의는 그 사람이 정함");
  const [ckj2, kp2] = await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_RIGHT", profileId: kid.profileId }, mom.token);
  assert.deepEqual([ckj2, kp2.id, kp2.seat], [200, kp.id, "ROW_2_LEFT"], "같은 아이를 다시 참가시키면 두 자리가 아니라 있던 참가자와 새 토큰(T68)");
  assert.equal((await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_RIGHT", profileId: "x" }, mom.token))[0], 400);
  await call("PATCH", `/api/trips/${trip.code}/participants/${kp.id}`, { consent: true }, kp.token); // 아이의 참가자 토큰은 참가시킨 보호자의 기기에
  assert.equal((await call("PATCH", `/api/trips/${trip.code}`, { status: "driving", recording: true }))[1].recording, true);
  const [, inv3] = await call("POST", `/api/groups/${g.id}/invites`, {}, mom.token);
  const [, joiner] = await call("POST", `/api/j/${inv3.code}`, { name: "이웃" });
  assert.deepEqual(joiner.trip, { code: trip.code }, "진행 중 그룹 여행의 코드만 받는다");
  assert.equal((await call("GET", `/api/trips/${trip.code}`))[1].participants.length, 1, "자리를 대신 고르지 않는다");
  const [cj, jp] = await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_RIGHT" }, joiner.token);
  assert.deepEqual([cj, jp.consent], [201, false]);
  assert.equal((await call("GET", `/api/trips/${trip.code}`))[1].recording, false, "동의하지 않은 사람이 타면 기록이 멈춘다");

  // 구성원 내보내기와 스스로 나가기. 기록본은 프로필 소유라 그대로다
  assert.equal((await call("DELETE", `/api/groups/${g.id}/members/${kid.profileId}`, null, uncle.token))[0], 403, "대표만 내보냄");
  assert.equal((await call("DELETE", `/api/groups/${g.id}/members/not-a-uuid`, null, mom.token))[0], 404);
  assert.equal((await call("DELETE", `/api/groups/${g.id}/members/${b.profile.id}`, null, uncle.token))[0], 204, "스스로 나감");
  assert.equal((await call("DELETE", `/api/groups/${g.id}/members/${mom.id}`, null, mom.token))[0], 409, "대표는 그룹을 지워야 나감");

  // 프로필 사진: 형식을 확인해 다시 저장하고, 사진이 있는지 프로필에 보인다
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const put = await fetch(`${base}/api/profiles/me/photo`, { method: "PUT", headers: { authorization: `Bearer ${mom.token}` }, body: png });
  assert.equal(put.status, 204);
  assert.equal((await fetch(`${base}/api/profiles/me/photo`, { method: "PUT", headers: { authorization: `Bearer ${mom.token}` }, body: Buffer.from("not-image") })).status, 400, "PNG·JPEG만 됨");
  const got = await fetch(`${base}/api/profiles/me/photo`, { headers: { authorization: `Bearer ${mom.token}` } });
  assert.deepEqual([got.status, got.headers.get("content-type"), got.headers.get("x-content-type-options")], [200, "image/png", "nosniff"]);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(png), "받은 그대로");
  const [, seen] = await call("GET", "/api/profiles/me", null, mom.token);
  assert.equal(seen.hasPhoto, true);
  assert.equal((await call("DELETE", "/api/profiles/me/photo", null, mom.token))[0], 204);
  assert.equal((await fetch(`${base}/api/profiles/me/photo`, { headers: { authorization: `Bearer ${mom.token}` } })).status, 404, "지운 뒤에는 없음");

  // 그룹을 지워도 계정 있는 구성원의 앨범은 프로필 소유라 그대로 남는다. 대표가 만든 아이 프로필은 함께 지운다(ADR-0009)
  const [, mp] = await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_1_RIGHT", consent: true }, mom.token);
  await call("POST", `/api/trips/${trip.code}/moments`, { label: "마지막 농담", at: trip.createdAt + 5000 }, mp.token);
  assert.equal((await call("DELETE", `/api/groups/${g.id}`, null, mom.token))[0], 204);
  assert.equal((await call("GET", `/api/groups/${g.id}`, null, mom.token))[0], 404, "지워진 그룹");
  const count = async (sql, args) => (await profilesDb().query(`SELECT count(*)::int AS n FROM ${sql}`, args)).rows[0].n;
  assert.equal(await count("profile_moments WHERE profile_id = $1", [mom.id]), 1, "대표의 앨범은 그대로");
  assert.equal(await count("profiles WHERE id = $1", [kid.profileId]), 0, "아이 프로필은 함께 지워짐");

  // 대표가 아이를 내보내면 프로필째 지운다. 대표가 자기 프로필을 지우면 대표인 그룹과 아이 프로필도 함께 지운다
  const [, g2] = await call("POST", "/api/groups", { kind: "family" }, mom.token);
  const [, kid2] = await call("POST", `/api/groups/${g2.id}/members`, { name: "딸" }, mom.token);
  const [, kid3] = await call("POST", `/api/groups/${g2.id}/members`, { name: "막내" }, mom.token);
  assert.equal((await call("DELETE", `/api/groups/${g2.id}/members/${kid3.profileId}`, null, mom.token))[0], 204);
  assert.equal(await count("profiles WHERE id = $1", [kid3.profileId]), 0, "내보낸 아이 프로필");
  assert.equal((await call("DELETE", "/api/profiles/me", null, mom.token))[0], 204);
  assert.equal(await count("groups WHERE id = $1", [g2.id]), 0, "대표인 그룹");
  assert.equal(await count("profiles WHERE id = $1", [kid2.profileId]), 0, "만든 아이 프로필");
});

test("이전 판(프로필마다 토큰 하나)으로 되돌려도 프로필이 읽히고, 다시 올리면 그 토큰이 옮겨진다(T45)", async () => {
  // 옛 칸 token_hash를 남겨 두므로 옛 코드의 쓰기(INSERT … token_hash)가 그대로 된다
  const token = "B".repeat(43);
  const id = "11111111-2222-4333-8444-555555555555";
  await profilesDb().query("INSERT INTO profiles (id, token_hash, name, consent_default) VALUES ($1, $2, '옛 판', false)", [
    id,
    createHash("sha256").update(token).digest(),
  ]);
  // 배포 중(옛 파드가 만든 프로필, 새 파드는 아직 다시 기동하지 않음)에도 옛 칸으로 읽힌다
  assert.equal((await call("GET", "/api/profiles/me", null, token))[1].id, id);
  await migrate(); // 다시 올림: 옛 칸의 토큰을 tokens로 옮긴다
  const [st, me] = await call("GET", "/api/profiles/me", null, token);
  assert.deepEqual([st, me.id], [200, id]);
  // 새 코드가 만든 프로필도 첫 토큰을 옛 칸에 적어, 이전 이미지로 되돌려도 읽힌다
  const [, fresh] = await call("POST", "/api/profiles", { name: "새 판" });
  const { rows } = await profilesDb().query("SELECT token_hash FROM profiles WHERE id = $1", [fresh.id]);
  assert.ok(rows[0].token_hash.equals(createHash("sha256").update(fresh.token).digest()));
});

// 16 kHz 모노 16비트 WAV 합성 — 기본음+배음이 다른 두 '사람'
const wav = (freq, seconds) => {
  const n = Math.floor(seconds * 16000);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / 16000;
    const v = 0.6 * Math.sin(2 * Math.PI * freq * t + Math.sin(t * 3)) + 0.25 * Math.sin(2 * Math.PI * freq * 2 * t) + 0.1 * Math.sin(2 * Math.PI * freq * 3 * t + 1);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 20000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};
const postRaw = (path, buf, token) => fetch(base + path, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: buf });

test("목소리 등록으로 발화의 화자를 프로필에 붙인다(T38)", async () => {

  // 등록: 원본은 어디에도 남기지 않고 대조용 값만
  const [, mom] = await call("POST", "/api/profiles", { name: "엄마" });
  const [, dad] = await call("POST", "/api/profiles", { name: "아빠" });
  const reg = await postRaw("/api/profiles/me/voice", wav(210, 3), mom.token);
  assert.equal(reg.status, 200);
  const regBody = await reg.json();
  assert.deepEqual([regBody.seconds, regBody.dims > 50], [3, true]);
  assert.equal((await postRaw("/api/profiles/me/voice", wav(210, 2), mom.token)).status, 200, "다시 등록하면 값을 바꿈");
  assert.equal((await postRaw("/api/profiles/me/voice", wav(340, 2), dad.token)).status, 200);
  assert.equal((await postRaw("/api/profiles/me/voice", wav(210, 3))).status, 401, "토큰 없이는 등록 못 함");
  assert.equal((await fetch(`${base}/api/profiles/me/voice`, { method: "POST", headers: { authorization: `Bearer ${mom.token}` }, body: Buffer.from("not-wav") })).status, 400, "WAV만 받음");
  const raws = await profilesDb().query("SELECT count(*)::int AS n FROM voice_prints");
  assert.equal(raws.rows[0].n, 2, "등록값 두 개(원본 음성은 표에 없음)");

  // 여행: 두 사람이 다른 자리에 앉고, 발화를 올려 둔다
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, pm] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, mom.token);
  const [, pd] = await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT", consent: true }, dad.token);
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 1, at: trip.createdAt + 1000, text: "바다 보인다", seatArea: "ROW_1_LEFT" }] }, pm.token);

  // 대조: 앞줄(row=1)의 발화 음성은 엄마로, 뒷줄에 앉은 아빠의 소리는 앞줄 후보에 없어 '모름'
  const m1 = await postRaw(`${t}/voice-match?row=1&device=car&seq=1`, wav(210, 1.5), pm.token);
  assert.equal(m1.status, 200);
  const r1 = await m1.json();
  assert.deepEqual([r1.participantId, r1.profileId, r1.applied], [pm.id, mom.id, true], "엄마 목소리는 엄마로");
  const m2 = await postRaw(`${t}/voice-match?row=1&device=car&seq=1`, wav(340, 1.5), pm.token);
  const r2 = await m2.json();
  assert.deepEqual([r2.participantId, r2.profileId, r2.applied], [null, null, false], "다른 줄의 목소리는 모름");
  assert.ok(r1.confidence > r2.confidence, "같은 목소리의 확신이 더 높다");
  assert.ok(r1.confidence >= r1.threshold, "같은 목소리는 기준을 넘는다");

  // 발화 줄에 화자가 붙는다(기록본·피드에 나온다)
  const [, tr] = await call("GET", `${t}/transcript`, null, pm.token);
  assert.deepEqual([tr.utterances[0].participantId, tr.utterances[0].profileId], [pm.id, mom.id]);
  const [, feed] = await call("GET", "/api/profiles/me/feed", null, mom.token);
  assert.equal(feed.items.filter((i) => i.kind === "utterance").length, 1, "화자가 붙은 발화는 피드에 나옴");

  // 등록을 지우면 그 자리는 후보가 없어 모름
  assert.equal((await call("DELETE", "/api/profiles/me/voice", null, dad.token))[0], 204);
  const m3 = await postRaw(`${t}/voice-match?row=2`, wav(340, 1.5), pd.token);
  const r3 = await m3.json();
  assert.deepEqual([r3.profileId, r3.confidence], [null, 0], "등록이 없으면 모름");
  assert.equal((await postRaw(`${t}/voice-match?row=1`, wav(210, 1.5))).status, 401, "참가자 토큰이 필요함");
  assert.equal((await postRaw(`${t}/voice-match?row=3`, wav(210, 1), pm.token)).status, 400, "없는 줄은 거절");

  // 화자는 그 발화를 올린 기기(참가자)만, 아직 화자가 없는 줄에만 붙인다
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 2, at: trip.createdAt + 2000, text: "응" }] }, pm.token);
  const notMine = await (await postRaw(`${t}/voice-match?device=car&seq=2`, wav(210, 1.5), pd.token)).json();
  assert.deepEqual([notMine.profileId, notMine.applied], [mom.id, false], "남이 올린 줄에는 붙이지 못함");
  const relabel = await (await postRaw(`${t}/voice-match?device=car&seq=1`, wav(210, 1.5), pm.token)).json();
  assert.equal(relabel.applied, false, "이미 화자가 있는 줄은 바꾸지 않음");
  assert.equal((await postRaw(`${t}/voice-match`, wav(210, 11), pm.token)).status, 400, "대조 음성은 10초까지");
  const [, guest] = await call("POST", `${t}/participants`, { seat: "ROW_2_RIGHT", name: "손님", consent: false });
  assert.equal((await postRaw(`${t}/voice-match`, wav(210, 1.5), guest.token)).status, 403, "동의하지 않은 참가자는 대조 못 함");
  await call("PATCH", `${t}/participants/${guest.id}`, { consent: true }, guest.token);

  // 좌석 구역을 모르면 이 여행의 참가자 모두가 후보다
  const m4 = await (await postRaw(`${t}/voice-match`, wav(210, 1.5), pd.token)).json();
  assert.equal(m4.profileId, mom.id, "구역 없이도 엄마를 찾음");

  // 대조는 여행 줄을 잠그지 않는다: 같은 여행에 대조가 몰려도, 그사이 동의를 바꿔도 모두 응답한다(리뷰 재현)
  const jobs = Array.from({ length: 15 }, () => postRaw(`${t}/voice-match?row=1&device=car&seq=1`, wav(210, 1.5), pm.token));
  const [consent] = await call("PATCH", `${t}/participants/${pd.id}`, { consent: true }, pd.token);
  assert.deepEqual([consent, ...(await Promise.all(jobs)).map((r) => r.status)], Array(16).fill(200));

  // 아이(계정 없는 구성원)의 목소리는 그 아이를 만든 대표가 대신 등록한다
  const [, g] = await call("POST", "/api/groups", { kind: "family" }, mom.token);
  const [, kid] = await call("POST", `/api/groups/${g.id}/members`, { name: "민준" }, mom.token);
  const kidVoice = `/api/groups/${g.id}/members/${kid.profileId}/voice`;
  assert.equal((await postRaw(kidVoice, wav(300, 2), dad.token)).status, 403, "대표만");
  assert.equal((await postRaw(`/api/groups/${g.id}/members/${dad.id}/voice`, wav(300, 2), mom.token)).status, 404, "대표가 만든 구성원만");
  assert.equal((await postRaw(kidVoice, wav(300, 2), mom.token)).status, 200);
  const prints = async (id) => (await profilesDb().query("SELECT count(*)::int AS n FROM voice_prints WHERE profile_id = $1", [id])).rows[0].n;
  assert.equal(await prints(kid.profileId), 1);

  // 프로필을 지우면 목소리 값도 함께 지운다. 대표가 지우면 대표가 만든 아이의 값도
  assert.equal((await call("DELETE", "/api/profiles/me", null, mom.token))[0], 204);
  assert.deepEqual([await prints(mom.id), await prints(kid.profileId)], [0, 0]);
});

test("녹음 클립: 고른 장면의 원음을 받고, 재생하고, 바로 지운다(T76)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, mom] = await join(trip.code, "엄마", "ROW_1_LEFT");
  const [, son] = await join(trip.code, "아들", "ROW_2_LEFT");
  const [, m1] = await call("POST", `${t}/moments`, { label: "웃음" });
  const [, m2] = await call("POST", `${t}/moments`, {});
  const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});
  const from = Date.now() - 5000; // 클립 첫 표본의 시각(구간 없는 장면은 at 앞 20초~뒤 10초 안이어야 함)
  const up = (moment, body, token, generation = 1) => fetch(`${base}${t}/recordings?moment=${moment}&generation=${generation}&from=${from}`, { method: "POST", headers: auth(token), body });
  const play = (id, token) => fetch(`${base}${t}/recordings/${id}`, { headers: auth(token) });
  const del = (id, token) => fetch(`${base}${t}/recordings/${id}`, { method: "DELETE", headers: auth(token) });
  // 버킷 지우기는 기다리지 않고 돈다. 남은 객체가 left개가 될 때까지 잠깐 기다린다
  const gone = async (left = 0) => {
    for (let i = 0; i < 100 && s3.objects.size > left; i++) await new Promise((ok) => setTimeout(ok, 10));
    return s3.objects.size === left;
  };
  const clip = wav(200, 2);

  // 올리기: 장면 하나에 클립 하나. 다시 보내면 저장하지 않고 같은 값
  const first = await up(m1.id, clip, mom.token);
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { id: m1.id, momentId: m1.id, startAt: from, seconds: 2, bytes: clip.length });
  const again = await up(m1.id, clip, son.token);
  assert.deepEqual([again.status, (await again.json()).id, s3.objects.size], [200, m1.id, 1]);

  // 재생: 받은 그대로, 캐시하지 않게
  const heard = await play(m1.id, son.token);
  assert.deepEqual([heard.status, heard.headers.get("content-type"), heard.headers.get("cache-control")], [200, "audio/wav", "private, no-store"]);
  assert.deepEqual(Buffer.from(await heard.arrayBuffer()), clip);

  // 인증: 토큰이 없거나 다른 여행의 토큰이면 401(참가자 토큰은 여행에 묶임)
  const [, other] = await call("POST", "/api/trips", {});
  const [, stranger] = await join(other.code, "남", "ROW_1_LEFT");
  assert.deepEqual([(await up(m2.id, clip)).status, (await up(m2.id, clip, stranger.token)).status, (await play(m1.id, stranger.token)).status, (await del(m1.id)).status], [401, 401, 401, 401]);

  // 형식·크기·장면·세대
  const stereo = Buffer.from(clip);
  stereo.writeUInt16LE(2, 22);
  assert.equal((await up(m2.id, Buffer.from("not-wav"), mom.token)).status, 400, "WAV만");
  assert.equal((await up(m2.id, stereo, mom.token)).status, 400, "모노만");
  assert.equal((await up(m2.id, Buffer.alloc(5_000_001), mom.token)).status, 413, "5 MB까지");
  assert.equal((await up("nope", clip, mom.token)).status, 404, "그 여행의 장면만");
  assert.equal((await fetch(`${base}${t}/recordings?moment=${m2.id}&from=${from}`, { method: "POST", headers: auth(mom.token), body: clip })).status, 400, "세대가 필요");
  assert.equal((await fetch(`${base}${t}/recordings?moment=${m2.id}&generation=1`, { method: "POST", headers: auth(mom.token), body: clip })).status, 400, "클립 시작 시각이 필요");
  assert.equal((await up(m2.id, clip, mom.token, 2)).status, 400, "아직 없는 세대");
  // 사람이 확정한 장면 구간의 소리만(구간 없는 장면은 at 앞 20초~뒤 10초, 앞뒤 1초 여유)
  const outside = (start, body) => fetch(`${base}${t}/recordings?moment=${m2.id}&generation=1&from=${start}`, { method: "POST", headers: auth(mom.token), body });
  assert.equal((await outside(m2.at - 25_000, clip)).status, 400, "구간 앞의 소리");
  assert.equal((await outside(m2.at - 20_000, wav(200, 40))).status, 400, "구간보다 긴 소리");
  assert.equal(s3.objects.size, 1, "거절한 소리는 버킷에 남지 않음");

  // 지우기: 버킷에서 바로, 다시 올려도 되살아나지 않음. 장면은 그대로
  const dropped = await del(m1.id, son.token);
  assert.deepEqual([dropped.status, s3.objects.size], [204, 0]);
  assert.deepEqual([(await play(m1.id, mom.token)).status, (await del(m1.id, mom.token)).status, (await up(m1.id, clip, mom.token)).status], [404, 404, 409]);
  assert.ok((await call("GET", t))[1].moments.some((x) => x.id === m1.id), "장면은 남음");

  // 버킷에 닿지 못하면 503이고, 지운 표시도 남지 않아 다시 하면 된다
  assert.equal((await up(m2.id, clip, mom.token)).status, 201);
  s3.down = true;
  assert.equal((await del(m2.id, mom.token)).status, 503);
  s3.down = false;
  assert.equal((await play(m2.id, mom.token)).status, 200);

  // 저장소가 없는 환경(로컬·E2E)은 정직하게 503
  delete process.env.CLIPS_BUCKET;
  assert.deepEqual([(await up(m2.id, clip, mom.token)).status, (await play(m2.id, mom.token)).status], [503, 503]);
  process.env.CLIPS_BUCKET = "clips";

  // 같은 장면을 동시에 두 번 올려도 하나만 남고, 진 쪽은 제 소리를 버린다
  const [, m3] = await call("POST", `${t}/moments`, {});
  const both = await Promise.all([up(m3.id, clip, mom.token), up(m3.id, clip, son.token)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 201]);
  await gone(2);
  assert.equal(s3.objects.size, 2, "m2와 m3 하나씩");

  // 버킷에 둘 수 없으면 503이고 줄도 생기지 않는다
  const [, m4] = await call("POST", `${t}/moments`, {});
  s3.down = true;
  assert.equal((await up(m4.id, clip, mom.token)).status, 503);
  s3.down = false;
  assert.equal((await play(m4.id, mom.token)).status, 404);

  // 동의하지 않은 사람은 올리지도 듣지도 못하고, 그런 탑승자가 있는 동안은 아무도 올리지 못한다. 지우기는 참가자 누구나
  const [, guest] = await join(trip.code, "손님", "ROW_2_RIGHT", false);
  assert.deepEqual([(await up(m4.id, clip, guest.token)).status, (await play(m2.id, guest.token)).status, (await up(m4.id, clip, mom.token)).status], [403, 403, 403]);
  assert.equal((await del(m3.id, guest.token)).status, 204);
  assert.equal(s3.objects.size, 1);

  // 동의 철회: 그 여행의 클립을 모두 지우고, 철회 전의 소리(옛 세대)는 받지 않는다 — 철회한 본인이 올려도 '버림'(409)
  assert.equal((await call("PATCH", `${t}/participants/${son.id}`, { consent: false }))[0], 200);
  assert.ok(await gone(), "철회하면 버킷에서 지움");
  assert.equal((await play(m2.id, mom.token)).status, 404);
  assert.equal((await up(m4.id, clip, son.token, 1)).status, 409, "철회한 본인의 옛 세대도 409");
  await call("PATCH", `${t}/participants/${son.id}`, { consent: true }, son.token);
  await call("PATCH", `${t}/participants/${guest.id}`, { consent: true }, guest.token);
  assert.equal((await up(m4.id, clip, mom.token, 1)).status, 409, "철회 전 세대");
  assert.equal((await up(m4.id, clip, mom.token, 2)).status, 201);

  // 올리는 도중에 동의를 철회하면 둔 소리를 지우고 409
  const [, m5] = await call("POST", `${t}/moments`, {});
  s3.onPut = () => call("PATCH", `${t}/participants/${son.id}`, { consent: false });
  assert.equal((await up(m5.id, clip, mom.token, 2)).status, 409);
  s3.onPut = null;
  assert.ok(await gone(), "철회가 지운 m4와, 올리다 거절된 m5 모두 버킷에 없음");

  // 철회 때 버킷에 닿지 못해도 지울 키가 남아 다음 치우기가 지운다
  await call("PATCH", `${t}/participants/${son.id}`, { consent: true }, son.token);
  assert.equal((await up(m5.id, clip, mom.token, 3)).status, 201);
  s3.down = true;
  await call("PATCH", `${t}/participants/${son.id}`, { consent: false });
  await new Promise((ok) => setTimeout(ok, 300));
  s3.down = false;
  assert.equal(s3.objects.size, 1, "아직 남음");
  await sweep();
  assert.ok(await gone(), "다음 치우기가 지움");

  // 48시간: 여행을 치울 때 그 여행의 클립도 버킷에서 지운다
  await call("PATCH", `${t}/participants/${son.id}`, { consent: true }, son.token);
  const [, m6] = await call("POST", `${t}/moments`, {});
  assert.equal((await up(m6.id, clip, mom.token, 4)).status, 201);
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [trip.code]);
  await sweep();
  assert.ok(await gone(), "치운 여행의 클립이 버킷에 남지 않음");
  assert.equal((await tripsDb().query("SELECT (SELECT count(*) FROM recordings WHERE trip_code = $1) + (SELECT count(*) FROM clip_trash) AS n", [trip.code])).rows[0].n, "0");
});

test("사람이 지운 클립은 철회·다시 동의 뒤에도 받지 않고, 지우는 사이 새로 올라온 클립은 건드리지 않는다(T76)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, mom] = await join(trip.code, "엄마", "ROW_1_LEFT");
  const [, son] = await join(trip.code, "아들", "ROW_2_LEFT");
  const [, m1] = await call("POST", `${t}/moments`, {});
  const [, m2] = await call("POST", `${t}/moments`, {});
  const from = Date.now() - 5000;
  const up = (m, generation) => fetch(`${base}${t}/recordings?moment=${m.id}&generation=${generation}&from=${from}`, { method: "POST", headers: { authorization: `Bearer ${mom.token}` }, body: wav(200, 1) });
  const del = (m) => fetch(`${base}${t}/recordings/${m.id}`, { method: "DELETE", headers: { authorization: `Bearer ${son.token}` } });
  const consent = (on) => call("PATCH", `${t}/participants/${son.id}`, { consent: on }, on ? son.token : undefined);

  // 지운 표시는 동의 철회로 사라지지 않는다
  assert.equal((await up(m1, 1)).status, 201);
  assert.equal((await del(m1)).status, 204);
  await consent(false);
  await consent(true);
  assert.equal((await up(m1, 2)).status, 409, "사람이 지운 장면은 다시 받지 않음");

  // 지우는 사이(버킷을 기다리는 동안) 철회 → 다시 동의 → 같은 장면을 새로 올리면, 새 클립은 남고 409
  assert.equal((await up(m2, 2)).status, 201);
  let again;
  s3.onDelete = async () => {
    await consent(false);
    await consent(true);
    again = (await up(m2, 3)).status;
  };
  assert.equal((await del(m2)).status, 409);
  assert.equal(again, 201);
  const heard = await fetch(`${base}${t}/recordings/${m2.id}`, { headers: { authorization: `Bearer ${mom.token}` } });
  assert.equal(heard.status, 200, "새 클립은 지운 표시 없이 들린다");
  assert.equal((await del(m2)).status, 204, "다시 지우면 됨");

  // 지우는 사이(버킷을 기다리는 동안) 동의 철회가 줄을 먼저 지워도 지운 표시는 남는다 — 다시 동의해도 그 장면은 409
  const [, m3] = await call("POST", `${t}/moments`, {});
  assert.equal((await up(m3, 3)).status, 201);
  s3.onDelete = () => consent(false);
  assert.equal((await del(m3)).status, 204);
  await consent(true);
  assert.equal((await up(m3, 4)).status, 409, "철회와 겹친 지우기도 표시를 남김");
});

test("장면 후보는 말이 몰린 구간을 규칙으로 고르고, 숏폼은 클립과 자막 큐로 내준다(T43)", async () => {
  const [, trip] = await call("POST", "/api/trips", { title: "속초" });
  const t = `/api/trips/${trip.code}`;
  const [, momProfile] = await call("POST", "/api/profiles", { name: "엄마", character: "토끼" });
  const [, mom] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, momProfile.token);
  const [, son] = await join(trip.code, "아들", "ROW_2_LEFT");
  // 여행을 10분 전에 만든 셈으로 둔다(장면 시각은 여행을 만든 뒤 ~ 지금+1분만 받는다)
  const t0 = Date.now() - 600_000; // 시험 대화의 0초
  await tripsDb().query("UPDATE trips SET doc = jsonb_set(doc, '{createdAt}', to_jsonb($2::bigint)) WHERE code = $1", [trip.code, t0 - 1000]);
  const said = [
    // A: 20초에 6번, 두 사람이 번갈아
    ...[0, 4, 8, 12, 16, 20].map((s, i) => [s, i % 2 ? "ROW_2_LEFT" : "ROW_1_LEFT", i % 2 ? "엄마 저기 바다 보여" : "그래 정말 예쁘다"]),
    [60, "ROW_1_LEFT", "휴게소 들를까"], // 띄엄띄엄한 말은 후보가 아니다
    [100, "ROW_2_LEFT", "응"],
    // B: 25초에 5번, 한 사람
    ...[200, 206, 212, 218, 224].map((s) => [s, "ROW_2_LEFT", "노래 틀어 주세요"]),
    // C: 말은 몰렸지만 차에서 이미 장면으로 표시한 구간
    ...[300, 303, 306, 309].map((s, i) => [s, i % 2 ? "ROW_2_LEFT" : "ROW_1_LEFT", "하하하"]),
  ];
  const items = said.map(([s, seatArea, text], i) => ({ seq: i + 1, at: t0 + s * 1000, text, seatArea, generation: 1 }));
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", items }, mom.token))[0], 200);
  await tripsDb().query("UPDATE utterances SET profile_id = $2 WHERE trip_code = $1 AND seat_area = 'ROW_1_LEFT'", [trip.code, momProfile.id]); // 화자 대조(T38)가 붙인 셈
  await call("POST", `${t}/moments`, { at: t0 + 305_000, label: "웃음" });

  assert.equal((await call("GET", `${t}/scene-suggestions`))[0], 401);
  const [status, { items: found }] = await call("GET", `${t}/scene-suggestions`, null, son.token);
  assert.equal(status, 200);
  assert.deepEqual(
    found.map((c) => [c.from - t0, c.to - t0, c.why, c.lines.length]),
    [
      [-1000, 24_000, "30초에 말이 6번, 2명이 말함", 6],
      [199_000, 228_000, "30초에 말이 5번", 5],
    ],
    "말이 몰린 구간만, 이미 남긴 장면과 겹치는 구간은 빼고, 시각 순"
  );

  // 사람이 후보를 고르면 구간째 장면으로 남는다. 구간은 at을 품고 60초 안
  const [a] = found;
  assert.equal((await call("POST", `${t}/moments`, { at: a.at, from: a.from }))[0], 400, "from, to는 함께");
  assert.equal((await call("POST", `${t}/moments`, { at: a.at, from: a.at + 1, to: a.at + 2 }))[0], 400, "from ≤ at");
  assert.equal((await call("POST", `${t}/moments`, { at: a.at, from: a.from, to: a.from + 60_001 }))[0], 400, "60초 안");
  assert.equal((await call("POST", `${t}/moments`, { at: a.at, from: a.at, to: a.at }))[0], 400, "1초 이상");
  const [made, moment] = await call("POST", `${t}/moments`, { at: a.at, from: a.from, to: a.to, label: "바다" });
  assert.deepEqual([made, moment.from, moment.to], [201, a.from, a.to]);
  assert.deepEqual((await call("GET", `${t}/scene-suggestions`, null, son.token))[1].items.map((c) => c.from - t0), [199_000], "남긴 장면은 다시 추천하지 않음");

  // 숏폼: 클립이 올라온 장면만. 자막 큐는 클립 첫 표본에서 잰 초, 말한 사람은 화자 대조로 붙은 참가자만
  const clip = wav(200, 25);
  assert.equal((await fetch(`${base}${t}/recordings?moment=${moment.id}&generation=1&from=${a.from}`, { method: "POST", headers: { authorization: `Bearer ${son.token}` }, body: clip })).status, 201);
  const [ok, form] = await call("GET", `${t}/shortform`, null, mom.token);
  assert.equal(ok, 200);
  assert.equal(form.title, "속초");
  assert.deepEqual(form.cast.map((c) => [c.participantId, c.name, c.character]), [[mom.id, "엄마", "토끼"], [son.id, "아들", ""]]);
  const [scene] = form.scenes;
  assert.deepEqual([form.scenes.length, scene.momentId, scene.label, scene.clip, scene.startAt, scene.seconds], [1, moment.id, "바다", `${t}/recordings/${moment.id}`, a.from, 25]);
  assert.deepEqual(scene.cues.map((c) => [c.start, c.participantId, c.seatArea]), [
    [1, mom.id, "ROW_1_LEFT"], [5, null, "ROW_2_LEFT"], [9, mom.id, "ROW_1_LEFT"], [13, null, "ROW_2_LEFT"], [17, mom.id, "ROW_1_LEFT"], [21, null, "ROW_2_LEFT"],
  ]);
  assert.deepEqual(scene.cues.slice(0, 2).map((c) => c.end), [2.35, 6.65], "끝은 글자 수로 어림(글자당 0.15초, 1~6초): 9자·11자");
  assert.ok(scene.cues.every((c, i) => c.end <= (scene.cues[i + 1]?.start ?? scene.seconds)), "다음 자막·클립 끝을 넘지 않음(4초 간격)");
  assert.equal((await call("GET", `${t}/shortform`))[0], 401);
});

test("장면 규칙의 가장자리: 한 순간에 몰린 2만 줄, 같은 시각의 두 말, 일부만 붙은 화자(T43)", () => {
  // 차 시계가 멈춰 2만 줄이 한 시각에 몰려도 창을 복사하지 않고 끝난다(여행 한도, 파드 메모리 256 MiB)
  const t0 = 1_000_000;
  const flood = Array.from({ length: 20_000 }, (_, i) => ({ at: t0, text: "아", seatArea: i % 2 ? "ROW_1_LEFT" : "ROW_2_LEFT" }));
  const started = performance.now();
  const [one, ...rest] = suggest(flood, []);
  assert.ok(performance.now() - started < 1000, "1초 안");
  assert.deepEqual([rest.length, one.lines.length, one.to - one.from, one.why], [0, 30, 15_000, "30초에 말이 20000번, 2명이 말함"], "보여 줄 발화는 30줄, 구간은 15초 이상");
  // 한 사람의 말에 화자 대조가 일부만 붙어도 한 사람이다(좌석 구역으로 센다). 구역을 모르면 세지 않는다
  const solo = [0, 3, 6, 9].map((s, i) => ({ at: t0 + s * 1000, text: "응", seatArea: "ROW_1_LEFT", ...(i % 2 ? { profileId: "p1" } : {}) }));
  assert.equal(suggest([...solo, { at: t0 + 10_000, text: "?" }], [])[0].why, "30초에 말이 5번");
  // 점수는 명세 그대로(발화 수 + 2 × (말한 사람 수 − 1)): 말한 사람을 모르는 5줄(3점)보다 한 사람의 4줄(4점)이 먼저
  const unknown = [0, 1, 2, 3, 4].map((s) => ({ at: t0 + s * 1000, text: "?" }));
  const known = [0, 1, 2, 3].map((s) => ({ at: t0 + 100_000 + s * 1000, text: "응", seatArea: "ROW_1_LEFT" }));
  assert.deepEqual(suggest([...unknown, ...known], []).map((c) => c.score), [3, 4]);
  // 두 자리에서 같은 시각에 말하면 자막이 겹쳐 보인다(0초짜리로 사라지지 않음)
  const both = cues([{ at: t0, text: "와", seatArea: "ROW_1_LEFT" }, { at: t0, text: "우와", seatArea: "ROW_2_LEFT" }], t0 - 1000, 10);
  assert.deepEqual(both.map((c) => [c.start, c.end]), [[1, 2], [1, 2]]);
});

test("고른 장면 클립을 Nemotron으로 다시 받아 적고, 실패하면 원문 자막으로 남는다(T75)", async () => {
  assert.equal(asr.calls.length, 0, "ASR_URL·ASR_TOKEN이 없으면 보내지 않음(앞 시험들의 클립)");
  const [, trip] = await call("POST", "/api/trips", { title: "속초" });
  const t = `/api/trips/${trip.code}`;
  const t0 = Date.now() - 600_000;
  await tripsDb().query("UPDATE trips SET doc = jsonb_set(doc, '{createdAt}', to_jsonb($2::bigint)) WHERE code = $1", [trip.code, t0 - 1000]);
  const [, momProfile] = await call("POST", "/api/profiles", { name: "엄마" });
  const [, mom] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, momProfile.token);
  await join(trip.code, "서아", "ROW_2_LEFT");
  const said = ["서와야 바다 봐", "되풀이 해 봐", "고장 난 줄", "붐빔 시험"];
  const items = said.map((text, i) => ({ seq: i + 1, at: t0 + i * 3000, text, seatArea: i % 2 ? "ROW_2_LEFT" : "ROW_1_LEFT", generation: 1 }));
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", items }, mom.token))[0], 200);
  await tripsDb().query("UPDATE utterances SET profile_id = $2 WHERE trip_code = $1 AND seat_area = 'ROW_1_LEFT'", [trip.code, momProfile.id]);
  const [, moment] = await call("POST", `${t}/moments`, { at: t0, from: t0 - 1000, to: t0 + 11_000 });

  Object.assign(process.env, { ASR_URL: `http://127.0.0.1:${fakeAsr.address().port}/asr/v1/`, ASR_TOKEN: "test-asr-token", ASR_GAP_MS: "20" });
  const events = [];
  const restore = captureLog((line) => events.push(JSON.parse(line)));
  try {
    const up = await fetch(`${base}${t}/recordings?moment=${moment.id}&generation=1&from=${t0 - 1000}`, { method: "POST", headers: { authorization: `Bearer ${mom.token}` }, body: wav(200, 12) });
    assert.equal(up.status, 201, "응답은 재전사를 기다리지 않는다");
    for (let i = 0; i < 300 && !events.some((e) => e.msg === "clip_retranscribed"); i++) await new Promise((ok) => setTimeout(ok, 20));
  } finally {
    restore();
    delete process.env.ASR_URL;
    delete process.env.ASR_TOKEN;
    delete process.env.ASR_GAP_MS;
  }

  // 보낸 것: 연동 가이드의 공통 계약, 그 발화의 소리(16 kHz 모노 WAV)와 초안과 여행이 아는 낱말. 토큰은 머리말로만
  const [first] = asr.calls;
  assert.equal(first.path, "/asr/v1/chat/completions");
  assert.equal(first.auth, "Bearer test-asr-token");
  assert.deepEqual([first.body.model, first.body.temperature, first.body.chat_template_kwargs, first.body.skip_special_tokens], ["nemo_transcribe30", 0, { enable_thinking: false }, false]);
  assert.equal(first.body.max_tokens, 8 * 3 + 64, "되풀이하다 토큰 한도까지 가지 않게(초안 8자)");
  assert.match(first.prompt, /^Transcribe the following audio in Korean exactly as spoken\. Do not translate\./);
  assert.match(first.prompt, /등장인물: 엄마, 서아\..*목적지: 속초\..*글레오/);
  const sent = Buffer.from(first.body.messages[0].content[1].audio_url.url.replace("data:audio/wav;base64,", ""), "base64");
  assert.deepEqual([sent.readUInt16LE(22), sent.readUInt32LE(24), sent.length - 44], [1, 16000, 6500 * 32], "0.5초 앞부터 같은 자리의 다음 말까지(6.5초) 모노 16 kHz");
  assert.deepEqual(asr.calls.map((c) => c.draft), ["서와야 바다 봐", "되풀이 해 봐", "고장 난 줄", "붐빔 시험", "붐빔 시험"], "429면 다시");

  // 고친 글은 원문 옆에 남고 숏폼 자막에 쓰인다. 되풀이·오류는 원문으로
  const [, form] = await call("GET", `${t}/shortform`, null, mom.token);
  assert.deepEqual(form.scenes[0].cues.map((c) => [c.text, c.raw]), [
    ["서아야 바다 봐.", "서와야 바다 봐"],
    ["되풀이 해 봐", "되풀이 해 봐"],
    ["고장 난 줄", "고장 난 줄"],
    ["붐빔 시험.", "붐빔 시험"],
  ]);
  const done = events.find((e) => e.msg === "clip_retranscribed");
  assert.deepEqual([done.lines, done.fixed, done.fellBack, done.changed, done.reasons], [4, 2, 2, 1, { suspicious: 1, http_500: 1 }]);
  assert.ok(!JSON.stringify(events).includes("서아야") && !JSON.stringify(events).includes("test-asr-token"), "로그에 글과 토큰을 남기지 않음");

  // 자기 글 지우기는 고친 글도 함께 지운다
  assert.equal((await call("DELETE", `${t}/utterances`, null, mom.token))[0], 200);
  const { rows } = await tripsDb().query("SELECT count(*)::int AS n FROM utterances WHERE trip_code = $1 AND asr_text IS NOT NULL", [trip.code]);
  assert.equal(rows[0].n, 1, "엄마의 줄(서아야…)은 지워지고 서아 쪽 '붐빔 시험.'만 남음");
});

test("재전사 도중 글이나 클립을 지우면 더 보내지 않고 붙이지 않으며, 같이 한 말은 자리별로 자른다(T75)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const t0 = Date.now() - 600_000;
  await tripsDb().query("UPDATE trips SET doc = jsonb_set(doc, '{createdAt}', to_jsonb($2::bigint)) WHERE code = $1", [trip.code, t0 - 1000]);
  const [, momProfile] = await call("POST", "/api/profiles", { name: "엄마" });
  const [, mom] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, momProfile.token);
  const [, son] = await join(trip.code, "아들", "ROW_2_LEFT");
  const lines = [
    [0, "ROW_1_LEFT", "엄마 말 하나"],
    [100, "ROW_2_LEFT", "아들 말"], // 거의 같이 말함
    [4000, "ROW_1_LEFT", "엄마 말 둘"],
    [20_000, "ROW_2_LEFT", "아들 둘째 말"],
    [23_000, "ROW_2_LEFT", "아들 셋째 말"],
  ];
  const items = lines.map(([ms, seatArea, text], i) => ({ seq: i + 1, at: t0 + ms, text, seatArea, generation: 1 }));
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", items }, mom.token))[0], 200);
  await tripsDb().query("UPDATE utterances SET profile_id = $2 WHERE trip_code = $1 AND seat_area = 'ROW_1_LEFT'", [trip.code, momProfile.id]);
  const [, a] = await call("POST", `${t}/moments`, { at: t0, from: t0 - 1000, to: t0 + 7000 });
  const [, b] = await call("POST", `${t}/moments`, { at: t0 + 20_000, from: t0 + 19_000, to: t0 + 26_000 });
  const upload = (m, from, seconds) => fetch(`${base}${t}/recordings?moment=${m.id}&generation=1&from=${from}`, { method: "POST", headers: { authorization: `Bearer ${mom.token}` }, body: wav(200, seconds) });

  Object.assign(process.env, { ASR_URL: `http://127.0.0.1:${fakeAsr.address().port}/asr/v1`, ASR_TOKEN: "test-asr-token", ASR_GAP_MS: "20" });
  const events = [];
  const restore = captureLog((line) => events.push(JSON.parse(line)));
  const done = async (n) => {
    for (let i = 0; i < 300 && events.filter((e) => e.msg === "clip_retranscribed").length < n; i++) await new Promise((ok) => setTimeout(ok, 20));
    return events.filter((e) => e.msg === "clip_retranscribed")[n - 1];
  };
  const firstCall = asr.calls.length;
  try {
    // 1) 첫 줄을 보내는 사이 엄마가 자기 글을 지운다: 그 답은 붙이지 않고, 엄마의 다음 줄은 보내지 않는다
    asr.onCall = () => call("DELETE", `${t}/utterances`, null, mom.token);
    assert.equal((await upload(a, t0 - 1000, 8)).status, 201);
    const one = await done(1);
    const sent = asr.calls.slice(firstCall);
    assert.deepEqual(sent.map((c) => c.draft), ["엄마 말 하나", "아들 말"]);
    const seconds = (c) => (Buffer.from(c.body.messages[0].content[1].audio_url.url.split(",")[1], "base64").length - 44) / 32;
    assert.deepEqual(sent.map(seconds), [4500, 7400], "같이 한 말에 잘리지 않고 같은 자리의 다음 말까지(엄마), 클립 끝까지(아들)");
    assert.deepEqual([one.fixed, one.reasons], [1, { stopped: 2 }]);

    // 2) 첫 줄을 보내는 사이 클립을 지운다: 그 답은 붙이지 않고 남은 줄은 보내지 않는다
    const before = asr.calls.length;
    asr.onCall = () => fetch(`${base}${t}/recordings/${b.id}`, { method: "DELETE", headers: { authorization: `Bearer ${son.token}` } });
    assert.equal((await upload(b, t0 + 19_000, 7)).status, 201);
    const two = await done(2);
    assert.equal(asr.calls.length - before, 1);
    assert.deepEqual([two.fixed, two.reasons], [0, { stopped: 2 }]);
  } finally {
    restore();
    asr.onCall = null;
    delete process.env.ASR_URL;
    delete process.env.ASR_TOKEN;
    delete process.env.ASR_GAP_MS;
  }
  const { rows } = await tripsDb().query("SELECT seq FROM utterances WHERE trip_code = $1 AND asr_text IS NOT NULL", [trip.code]);
  assert.deepEqual(rows.map((r) => Number(r.seq)), [2], "아들의 첫 말만 붙음");
});

test("클립이 발화보다 먼저 와도, 늦게 온 발화로 다시 받아 적고 이미 본 줄은 다시 보내지 않는다(T75)", async () => {
  const [, trip] = await call("POST", "/api/trips", { title: "속초" });
  const t = `/api/trips/${trip.code}`;
  const t0 = Date.now() - 600_000;
  await tripsDb().query("UPDATE trips SET doc = jsonb_set(doc, '{createdAt}', to_jsonb($2::bigint)) WHERE code = $1", [trip.code, t0 - 1000]);
  const [, mom] = await join(trip.code, "엄마", "ROW_1_LEFT");
  const [, m] = await call("POST", `${t}/moments`, { at: t0, from: t0 - 1000, to: t0 + 9000 });
  const lines = (from, texts) => call("POST", `${t}/utterances`, { device: "car", items: texts.map((text, i) => ({ seq: from + i, at: t0 + (from + i - 1) * 3000, text, seatArea: "ROW_1_LEFT", generation: 1 })) }, mom.token);
  Object.assign(process.env, { ASR_URL: `http://127.0.0.1:${fakeAsr.address().port}/asr/v1`, ASR_TOKEN: "test-asr-token", ASR_GAP_MS: "20" });
  const events = [];
  const restore = captureLog((line) => events.push(JSON.parse(line)));
  const runs = async (n) => {
    for (let i = 0; i < 300 && events.filter((e) => e.msg === "clip_retranscribed").length < n; i++) await new Promise((ok) => setTimeout(ok, 20));
    return events.filter((e) => e.msg === "clip_retranscribed").map((e) => [e.lines, e.fixed]);
  };
  const before = asr.calls.length;
  try {
    assert.equal((await fetch(`${base}${t}/recordings?moment=${m.id}&generation=1&from=${t0 - 1000}`, { method: "POST", headers: { authorization: `Bearer ${mom.token}` }, body: wav(200, 10) })).status, 201);
    assert.deepEqual(await runs(1), [[0, 0]], "발화가 아직 없음");
    assert.equal((await lines(1, ["서와 왔어", "고장 난 말"]))[0], 200);
    assert.deepEqual(await runs(2), [[0, 0], [2, 1]], "늦게 온 발화로 다시(하나는 오류로 원문)");
    assert.equal((await lines(3, ["서와 갔어"]))[0], 200);
    assert.deepEqual(await runs(3), [[0, 0], [2, 1], [1, 1]], "새로 온 줄만 — 오류로 남은 줄은 되풀이해 보내지 않음");
  } finally {
    restore();
    delete process.env.ASR_URL;
    delete process.env.ASR_TOKEN;
    delete process.env.ASR_GAP_MS;
  }
  assert.deepEqual(asr.calls.slice(before).map((c) => c.draft), ["서와 왔어", "고장 난 말", "서와 갔어"]);
  const { rows } = await tripsDb().query("SELECT text, asr_text FROM utterances WHERE trip_code = $1 ORDER BY seq", [trip.code]);
  assert.deepEqual(rows.map((r) => r.asr_text), ["서아 왔어.", null, "서아 갔어."]);
});

test("짧은 말도 초안과 글자가 절반 넘게 다르면 원문으로 남는다(T75)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const t0 = Date.now() - 600_000;
  await tripsDb().query("UPDATE trips SET doc = jsonb_set(doc, '{createdAt}', to_jsonb($2::bigint)) WHERE code = $1", [trip.code, t0 - 1000]);
  const [, mom] = await join(trip.code, "엄마", "ROW_1_LEFT");
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", items: [{ seq: 1, at: t0, text: "가자", seatArea: "ROW_1_LEFT", generation: 1 }] }, mom.token))[0], 200);
  const [, m] = await call("POST", `${t}/moments`, { at: t0, from: t0 - 1000, to: t0 + 3000 });
  Object.assign(process.env, { ASR_URL: `http://127.0.0.1:${fakeAsr.address().port}/asr/v1`, ASR_TOKEN: "test-asr-token", ASR_GAP_MS: "20" });
  const events = [];
  const restore = captureLog((line) => events.push(JSON.parse(line)));
  try {
    assert.equal((await fetch(`${base}${t}/recordings?moment=${m.id}&generation=1&from=${t0 - 1000}`, { method: "POST", headers: { authorization: `Bearer ${mom.token}` }, body: wav(200, 4) })).status, 201);
    for (let i = 0; i < 300 && !events.some((e) => e.msg === "clip_retranscribed"); i++) await new Promise((ok) => setTimeout(ok, 20));
  } finally {
    restore();
    delete process.env.ASR_URL;
    delete process.env.ASR_TOKEN;
    delete process.env.ASR_GAP_MS;
  }
  assert.deepEqual(events.find((e) => e.msg === "clip_retranscribed").reasons, { suspicious: 1 }, "'가자' → '싫어'는 받지 않음");
});

test("손님 참가자도 여행에 목소리를 등록하면 화자가 붙는다(T38·T37)", async () => {
  // 차의 가족은 손님 참가자다(프로필 없음). 등록값은 여행에 두고, 동의를 끄거나 48시간이 지나면 지운다.
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, a] = await join(trip.code, "아빠", "ROW_1_LEFT", true);
  const [, b] = await join(trip.code, "누나", "ROW_2_LEFT", true);
  const [, c] = await join(trip.code, "동생", "ROW_2_RIGHT", false);
  const enroll = (p, freq, token) => postRaw(`${t}/participants/${p.id}/voice`, wav(freq, 3), token).then(async (r) => [r.status, await r.json()]);
  const prints = async (id) => (await tripsDb().query("SELECT count(*)::int AS n FROM trip_voice_prints WHERE trip_code = $1 AND participant_id = $2", [trip.code, id])).rows[0].n;

  assert.deepEqual(await enroll(a, 210, a.token), [200, { seconds: 3, dims: 112 }]);
  assert.equal((await enroll(a, 210))[0], 401, "토큰 없이는 등록 못 함");
  assert.equal((await enroll(a, 300, b.token))[0], 403, "남의 목소리를 등록하지 못함");
  assert.equal((await enroll(c, 340, c.token))[0], 409, "녹음에 동의한 뒤 등록");
  assert.equal((await postRaw(`${t}/participants/nobody/voice`, wav(210, 3), a.token)).status, 404);
  assert.equal((await postRaw(`${t}/participants/${a.id}/voice`, wav(210, 0.5), a.token)).status, 400, "등록은 1초부터");
  assert.equal((await call("POST", `${t}/participants/${a.id}/voice/x`, {}, a.token))[0], 404, "없는 경로");
  assert.equal((await enroll(b, 300, b.token))[0], 200);
  await call("PATCH", `${t}/participants/${c.id}`, { consent: true }, c.token);
  assert.equal((await enroll(c, 340, c.token))[0], 200);
  assert.equal(await prints(a.id), 1, "원본 음성이 아니라 대조용 값 한 줄");

  // 뒷줄(row=2) 발화는 뒷줄 두 사람 가운데서 찾고, 그 발화 줄에 참가자를 붙인다(프로필 없음)
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 1, at: trip.createdAt + 1000, text: "언제 도착해?" }] }, a.token);
  const r1 = await (await postRaw(`${t}/voice-match?row=2&device=car&seq=1`, wav(300, 1.5), a.token)).json();
  assert.deepEqual([r1.participantId, r1.profileId, r1.applied], [b.id, null, true]);
  const [, tr] = await call("GET", `${t}/transcript`, null, a.token);
  assert.deepEqual([tr.utterances[0].participantId, tr.utterances[0].profileId], [b.id, undefined]);
  const r2 = await (await postRaw(`${t}/voice-match?row=2`, wav(210, 1.5), a.token)).json();
  assert.equal(r2.participantId, null, "앞줄 아빠의 목소리는 뒷줄 후보에서 모름");
  assert.equal((await (await postRaw(`${t}/voice-match?row=1`, wav(210, 1.5), a.token)).json()).participantId, a.id);

  // 동의를 끄면(누가 끄든) 그 참가자의 값은 바로 지우고, 대조 후보에서도 빠진다
  await call("PATCH", `${t}/participants/${b.id}`, { consent: false });
  assert.equal(await prints(b.id), 0);
  assert.equal(await prints(c.id), 1, "다른 사람의 값은 그대로");
  const [, me] = await call("POST", "/api/profiles", { name: "삼촌" });
  await postRaw("/api/profiles/me/voice", wav(260, 3), me.token);
  const [, d] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT", consent: false }, me.token);
  const r3 = await (await postRaw(`${t}/voice-match?row=1`, wav(260, 1.5), a.token)).json();
  assert.equal(r3.participantId, null, "동의하지 않은 사람은 프로필 등록값이 있어도 후보가 아님");
  await call("PATCH", `${t}/participants/${d.id}`, { consent: true }, d.token);
  const r4 = await (await postRaw(`${t}/voice-match?row=1`, wav(260, 1.5), a.token)).json();
  assert.deepEqual([r4.participantId, r4.profileId], [d.id, me.id], "동의하면 프로필 등록값으로 찾음");

  // 48시간이 지나 여행이 지워지면 값도 함께
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [trip.code]);
  for (let i = 0; i < 3 && (await prints(a.id)); i++) await call("POST", "/api/trips", {});
  assert.deepEqual([await prints(a.id), await prints(c.id)], [0, 0]);
});

test("쓰기가 몰려도 서버가 멈추지 않는다", async () => {
  // 같은 여행에 쓰기 15개가 동시에 닥쳐도 모두 응답해야 한다(리뷰 재현).
  const [, me] = await call("POST", "/api/profiles", { name: "지우", consentDefault: true });
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, p] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT" }, me.token);
  const others = [];
  for (const [name, seat] of [["민준", "ROW_2_LEFT"], ["하늘", "ROW_2_CENTER"], ["강토", "ROW_2_RIGHT"]]) {
    const [, o] = await join(trip.code, name, seat, true);
    others.push(o);
  }
  for (let round = 0; round < 5; round++) {
    const writes = [call("PATCH", `${t}/participants/${p.id}`, { seat: round % 2 ? "ROW_1_LEFT" : "ROW_1_RIGHT" })];
    for (let i = 0; i < 14; i++) writes.push(call("PATCH", `${t}/participants/${others[i % others.length].id}`, { consent: true }, others[i % others.length].token));
    const done = await Promise.all(writes);
    assert.equal(done.filter(([s]) => s === 200).length, writes.length, `${round + 1}회차`);
  }
});

test("확장자 없는 주소는 웹 화면으로 연다(초대 /j/<코드>, 시연 /demo)", async () => {
  for (const path of ["/", "/j/abcDEF123", "/demo"]) {
    const res = await fetch(base + path);
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/html; charset=utf-8"], path);
  }
  assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(`${base}/nothing.js`)).status, 404, "없는 파일은 그대로 404");
  assert.equal((await fetch(`${base}/..%2F..%2Fbackend%2Fapi%2Fserver.js`)).status, 404, "웹 폴더 밖은 404");
  const outside = await fetch(`${base}/..%2F..%2Fbackend%2Fapi`);
  assert.ok((await outside.text()).includes("<title>가치타</title>"), "확장자 없는 주소로 웹 폴더 밖을 가리켜도 웹앱 첫 화면만 나옴");
});

test("DB가 연결을 끊어도 서버가 살아 있고 다음 요청에서 다시 맺는다(Postgres 재시작·장애 조치)", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200); // 두 저장소의 풀에 쉬는 연결이 생긴다
  // 빌려 간 연결(트랜잭션 중)에도 오류 처리기가 있어야 한다. 풀은 빌려 줄 때 자기 처리기를 뗀다
  const held = await tripsDb().connect();
  try {
    assert.ok(held.listenerCount("error") > 0, "빌려 간 연결의 오류 처리기");
    await held.query("BEGIN");
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const { rows } = await admin.query(
      "SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname LIKE current_database() || '%' AND pid <> pg_backend_pid()"
    );
    await admin.end();
    assert.ok(rows[0].n > 0, "끊은 연결이 있어야 시험이 된다");
    await new Promise((ok) => setTimeout(ok, 200)); // 끊긴 것을 알아채고 버릴 때까지
  } finally {
    held.release(true); // 끊긴 연결은 풀에 돌려주지 않고 버린다
  }
  assert.equal((await fetch(`${base}/healthz`)).status, 200, "처리기가 없으면 여기 오기 전에 프로세스가 죽는다");
});

test("글자 칸의 NUL 문자는 400으로 거른다(저장할 때 500이 되지 않게)", async () => {
  assert.equal((await call("POST", "/api/trips", { title: "a\u0000b" }))[0], 400);
  assert.equal((await call("POST", "/api/profiles", { name: "x\u0000" }))[0], 400);
  const [, trip] = await call("POST", "/api/trips", {});
  assert.equal((await join(trip.code, "민\u0000준", "ROW_1_LEFT"))[0], 400);
  assert.equal((await call("POST", "/api/trips", { title: "a\ud800b" }))[0], 400, "짝 없는 서로게이트도");
  const [, p] = await join(trip.code, "민준", "ROW_1_LEFT");
  assert.equal((await call("GET", `/api/trips/${trip.code}/utterances?device=%00`, null, p.token))[0], 400, "질의 문자열의 기기 이름도");
});

test("오류 종류와 요청 로그(T71)", async () => {
  // 오류 응답에는 사람이 읽는 문장과 함께 종류(type)가 붙는다
  const [s404, b404] = await call("GET", "/api/trips/ZZZZZZ");
  assert.deepEqual([s404, b404.type, typeof b404.error], [404, "not_found", "string"]);
  assert.equal((await call("POST", "/api/trips", { title: 5 }))[1].type, "invalid");
  assert.equal((await call("GET", "/api/profiles/me", null, "x".repeat(43)))[1].type, "unauthenticated");
  assert.equal((await call("DELETE", "/api/trips"))[1].type, "method_not_allowed");

  // DB에 닿지 않거나 질의 시간 제한(T26)은 다시 해도 되는 503, 예상 못 한 것은 500
  for (const e of [{ code: "57014" }, { code: "08006" }, { code: "57P01" }, { code: "53300" }, { code: "ECONNREFUSED" }, new Error("Connection terminated unexpectedly"), new Error("timeout exceeded when trying to connect")])
    assert.deepEqual([classify(e).status, classify(e).type], [503, "unavailable"], JSON.stringify(e.code ?? e.message));
  assert.deepEqual([classify(new TypeError("x is undefined")).status, classify(new TypeError("x")).type], [500, "internal"]);
  assert.deepEqual(classify({ status: 409, error: "이미 다른 사람이 앉은 자리" }), { status: 409, type: "conflict", message: "이미 다른 사람이 앉은 자리" });

  // 요청 로그: 한 줄 JSON에 경로 틀(코드는 :p), 상태, 걸린 시간, 요청 id. 코드·토큰은 남지 않는다
  const lines = [];
  const restore = captureLog((line) => lines.push(line));
  let trip, p;
  try {
    [, trip] = await call("POST", "/api/trips", {});
    [, p] = await join(trip.code, "민준", "ROW_1_LEFT", true);
    const res = await fetch(`${base}/api/trips/${trip.code}/transcript`, { headers: { authorization: `Bearer ${p.token}`, "x-amzn-trace-id": "Root=1-abc-def" } });
    assert.equal(res.headers.get("x-request-id"), "Root=1-abc-def", "ALB의 추적 id를 그대로 쓴다");
    await res.text();
    await call("GET", `/api/trips/${trip.code}/nothing`);
    await (await fetch(`${base}/`)).text(); // 웹 파일은 성공하면 남기지 않는다
    await new Promise((ok) => setTimeout(ok, 20)); // 응답을 다 보낸 뒤(finish)에 남긴다
  } finally {
    restore();
  }
  const logged = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === "request");
  const tr = logged.find((l) => l.requestId === "Root=1-abc-def");
  assert.deepEqual([tr.level, tr.method, tr.route, tr.status, typeof tr.ms, typeof tr.t], ["info", "GET", "/api/trips/:p/transcript", 200, "number", "string"]);
  const miss = logged.find((l) => l.status === 404);
  assert.deepEqual([miss.route, miss.err], ["/api/trips/:p/:p", { type: "not_found" }]);
  assert.ok(!logged.some((l) => l.route === "/(web)"), "성공한 웹 파일 요청은 남기지 않음");
  // 주소를 읽지 못하는 요청(new URL이 거절)도 서버를 죽이지 않고 로그에 남는다
  const raw = await new Promise((ok, no) => {
    const s = createConnection(server.address().port, "127.0.0.1", () => s.end("GET //a:99999/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let got = "";
    s.on("data", (d) => (got += d)).on("end", () => ok(got)).on("error", no);
  });
  assert.match(raw, /^HTTP\/1\.1 (400|404|500)/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200, "서버가 살아 있음");
  const all = lines.join("\n");
  assert.ok(!all.includes(trip.code) && !all.includes(p.token) && !all.includes("민준"), "여행 코드·토큰·이름은 로그에 없다");
});

test("웹 파일은 쓸 때마다 다시 확인하게 하고, 바뀌지 않았으면 304(배포 뒤 옛 파일이 남지 않게)", async () => {
  for (const path of ["/", "/app.js", "/style.css", "/demo"]) {
    const res = await fetch(base + path);
    const etag = res.headers.get("etag");
    assert.deepEqual([res.status, res.headers.get("cache-control"), Boolean(etag)], [200, "no-cache", true], path);
    const again = await fetch(base + path, { headers: { "if-none-match": etag } });
    assert.deepEqual([again.status, await again.text()], [304, ""], `${path} 바뀌지 않음`);
  }
  assert.equal((await fetch(`${base}/app.js`, { headers: { "if-none-match": '"old"' } })).status, 200, "다르면 새 파일");
  // Cloudflare가 압축하면서 약한 ETag(W/)로 바꿔 돌려보내도, 목록으로 와도 304
  const etag = (await fetch(`${base}/app.js`)).headers.get("etag");
  for (const inm of [`W/${etag}`, `"old", ${etag}`, "*"])
    assert.equal((await fetch(`${base}/app.js`, { headers: { "if-none-match": inm } })).status, 304, inm);
});

test("명세(docs/api/openapi.yaml)와 서버의 경로가 같다", async () => {
  // 표준 라이브러리에 YAML 읽기가 없어 ruby로 JSON으로 바꾼다(macOS와 CI 실행기에 기본으로 있음)
  const file = fileURLToPath(new URL("../../docs/api/openapi.yaml", import.meta.url));
  const spec = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))", file], { encoding: "utf8" }));

  const [, trip] = await call("POST", "/api/trips", {});
  const [, p] = await call("POST", `/api/trips/${trip.code}/participants`, { name: "민준", seat: "ROW_1_LEFT", consent: true });
  const [, r] = await call("POST", `/api/trips/${trip.code}/requests`, { by: p.id, text: "커피" });
  const METHODS = ["get", "post", "patch", "delete"];
  for (const [path, ops] of Object.entries(spec.paths)) {
    const url = path.replace("{code}", trip.code).replace("{id}", path.includes("/requests/") ? r.id : p.id);
    for (const method of METHODS) {
      // 빈 요청을 보내 본다. 명세에 있는 경로는 명세에 적힌 상태 중 하나로, 없는 경로는 404나 405로 답해야 한다.
      const res = await fetch(base + url, { method: method.toUpperCase(), body: method === "post" || method === "patch" ? "{}" : undefined });
      const documented = ops[method] ? Object.keys(ops[method].responses).map(Number) : [404, 405];
      assert.ok(documented.includes(res.status), `${method.toUpperCase()} ${path} → ${res.status}, 명세에는 ${documented.join("·")}`);
    }
  }
});
