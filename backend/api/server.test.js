// 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { basename, join as joinPath } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import pg from "pg";
import { classify, migrate, server, sweep, verifyGoogleLink, shortServiceContext } from "./server.js";
import { shortGenerations } from "./short-generations.js";
import { shortAssets } from "./short-assets.js";
import { captureLog } from "./log.js";
import { withVoice } from "./voice-fixture.js";
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
      const form = new URLSearchParams(raw);
      const code = form.get("code") ?? "";
      if (!form.get("code_verifier") || form.get("code_verifier").startsWith("w")) return send(400, { error: "invalid_grant" }); // PKCE가 맞지 않음
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
    const draft = /draft from another recognizer \(may contain errors\): "(.*)"\. Context:/.exec(prompt)?.[1];
    asr.calls.push({ path: req.url, auth: req.headers.authorization, body, prompt, draft });
    const hook = asr.onCall;
    asr.onCall = null;
    await hook?.(req, res);
    const reply = (status, content, finishReason) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content }, finish_reason: finishReason }] } : { error: {} })));
    if (draft === undefined) return reply(asr.rawReply?.status ?? 200, asr.rawReply?.content ?? "<spk:0> 지금 보이는 길이 예쁘다.", asr.rawReply?.finish_reason);
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
  await tripsDb().query("TRUNCATE short_generations");
  await tripsDb().query("TRUNCATE short_assets, short_asset_trash");
  await tripsDb().query("TRUNCATE trips CASCADE"); // 여행 목소리 값(trip_voice_prints)과 여행에 딸린 공유 표는 외래 키로 함께
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

const OURS = "https://gachita.mangowhois.ai/oauth/google/callback"; // 구글이 코드를 돌려줄 우리 주소(T27)
const VERIFIER = "v".repeat(43); // PKCE code_verifier. 가짜 구글은 "w"로 된 것을 '맞지 않음'으로 거절한다
// 프로필을 만들고 목소리까지 등록한다(T173: 목소리 없으면 프로필 참가·그룹·차량 QR·동승 연결이 409). call과 같은 [상태, 본문].
const voicedProfile = async (body) => {
  const made = await call("POST", "/api/profiles", body);
  if (made[0] === 201) await withVoice(base, made[1].token);
  return made;
};
const call = async (method, path, body, token) => {
  const res = await fetch(base + path, { method, body: body && JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  return [res.status, res.status === 304 || res.status === 204 ? null : await res.json()];
};
const join = (code, name, seat, consent = true) => call("POST", `/api/trips/${code}/participants`, { name, seat, consent });

test("본인 확인은 동의 전에도 토큰 주체의 네 필드만 주고 기존 인증 경계를 지킵니다(T115)", async () => {
  const [, profile] = await voicedProfile({ name: "본인 확인" });
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, guest] = await join(trip.code, "다른 참가자", "ROW_1_LEFT");
  const [, person] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT", consent: false }, profile.token);
  const [, before] = await call("GET", t);
  const res = await fetch(`${base}${t}/me?v=${before.version}`, { headers: { authorization: `Bearer ${person.token}` } });
  assert.equal(res.status, 200, "동의 전에도 본인을 확인하고 조건부 304를 반환하지 않습니다");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { id: person.id, name: person.name, seat: "ROW_1_RIGHT", consent: false }, "프로필ID·토큰·다른 참가자·여행 정보를 섞지 않습니다");
  assert.deepEqual((await call("GET", t))[1], before, "본인 조회가 동의·상태·토큰·여행 버전을 바꾸지 않습니다");
  assert.deepEqual((await call("GET", `${t}/me`, null, guest.token))[1], { id: guest.id, name: guest.name, seat: guest.seat, consent: true });

  const [, otherTrip] = await call("POST", "/api/trips", {});
  const [, outsider] = await join(otherTrip.code, "다른 여행", "ROW_1_LEFT");
  for (const token of [undefined, "", "bad", "A".repeat(43), profile.token, outsider.token]) {
    const [status, body] = await call("GET", `${t}/me`, null, token);
    assert.equal(status, 401, "기존 참가자 토큰 오류 계약을 유지합니다");
    assert.deepEqual(Object.keys(body).sort(), ["error", "type"]);
  }
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await call(method, `${t}/me`, {}, person.token))[0], 405);
  assert.equal((await call("GET", `${t}/me/other`, null, person.token))[0], 404);

  const [, rotated] = await call("POST", `${t}/participants`, { seat: person.seat }, profile.token);
  assert.notEqual(rotated.token, person.token);
  for (const token of [person.token, rotated.token]) assert.equal((await call("GET", `${t}/me`, null, token))[1].id, person.id, "유효한 최근 기기의 토큰도 기존 규칙대로 허용합니다");
  await call("PATCH", t, { status: "ended" });
  assert.equal((await call("GET", `${t}/me`, null, rotated.token))[0], 200, "남아 있는 종료 여행의 기록을 이어볼 수 있습니다");
  await tripsDb().query("DELETE FROM trips WHERE code=$1", [trip.code]);
  assert.equal((await call("GET", `${t}/me`, null, rotated.token))[0], 404);
  assert.equal((await call("GET", `${t}/me`))[0], 404);
});

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
  const [, me] = await voicedProfile({ name: "엄마" });
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
  const [created, me] = await voicedProfile({ name: "지우", prefs: { passenger: { tempC: 23 } }, consentDefault: true });
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

test("경로 위 휴게소: 내비가 주는 위치·목적지로 고르고, 잘못된 좌표는 거절한다(T97)", async () => {
  const gangneung = { lat: 37.7645236, lng: 128.8996276 };
  const [ok, r] = await call("POST", "/api/rest-stops", { from: { lat: 37.33, lng: 127.83, heading: 70 }, to: gangneung, remainMeters: 110_000 });
  assert.equal(ok, 200);
  assert.equal(r.items[0].name, "문막휴게소 강릉방향");
  assert.deepEqual(Object.keys(r.items[0]).sort(), ["lat", "lng", "meters", "name", "route"]);
  assert.match(r.source, /한국도로공사/);
  assert.deepEqual((await call("POST", "/api/rest-stops", { from: { lat: 37.33, lng: 127.83 } }))[1].items, [], "목적지도 방향도 없으면 빈 목록");
  for (const bad of [{}, { from: { lat: 0, lng: 0 } }, { from: { lat: 37.3, lng: 127.8 }, to: { lat: 37.7 } }, { from: { lat: 37.3, lng: 127.8, heading: 400 } }, { from: { lat: 37.3, lng: 127.8 }, limit: 0 }])
    assert.equal((await call("POST", "/api/rest-stops", bad))[0], 400, JSON.stringify(bad));
  assert.equal((await call("GET", "/api/rest-stops"))[0], 405);
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
  const [, me] = await voicedProfile({ name: "민준" });
  const [linked, after] = await link({ code: "code-1", redirectUri: "http://localhost:5173/oauth/google/callback", codeVerifier: VERIFIER }, me.token);
  assert.equal(linked, 200);
  assert.deepEqual([after.name, after.links], ["민준", ["google"]]);
  assert.equal(after.token, undefined, "연결할 때는 토큰을 새로 주지 않는다");

  // 이미 다른 프로필에 연결된 계정은 거절한다.
  const [, other] = await voicedProfile({ name: "다른 사람" });
  assert.equal((await link({ code: "code-1", redirectUri: OURS, codeVerifier: VERIFIER }, other.token))[0], 409);

  // 토큰 없이 같은 계정으로 찾아 들어가면 같은 프로필과 이 기기 토큰을 준다.
  // 기기마다 토큰이 따로이므로 앞선 기기의 토큰도 그대로 쓸 수 있다(T45, ADR-0009).
  const [status, again] = await link({ code: "code-1", redirectUri: OURS, codeVerifier: VERIFIER });
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
  const [created, fresh] = await link({ code: "code-2", redirectUri: OURS, codeVerifier: VERIFIER });
  assert.deepEqual([created, fresh.name, fresh.links], [201, "구글-code-2", ["google"]]);

  // 연결을 끊는다. 끊은 뒤 다시 끊으면 404.
  assert.equal((await call("DELETE", "/api/profiles/me/links/google", null, again.token))[0], 204);
  const [, cut] = await call("GET", "/api/profiles/me", null, again.token);
  assert.deepEqual(cut.links, []);
  assert.equal((await call("DELETE", "/api/profiles/me/links/google", null, again.token))[0], 404);

  // 제공자가 거절한 코드는 401.
  assert.equal((await link({ code: "bad-1", redirectUri: OURS, codeVerifier: VERIFIER }))[0], 401);
});

test("제공자 오류를 코드 거절과 장애으로 나눠 알린다(T21)", async () => {
  const link = (code) => call("POST", "/api/profiles/me/links/google", { code, redirectUri: OURS, codeVerifier: VERIFIER });
  assert.deepEqual(await link("bad-grant").then(([, b]) => b.error), "제공자가 코드를 거절함");
  assert.equal((await link("down"))[0], 503, "제공자 503은 일시 장애");
  assert.equal((await link("overloaded"))[0], 503, "제공자 429도 일시 장애");
  assert.equal((await link("bad-client"))[0], 500, "클라이언트 설정 오류는 사용자 잘못이 아님");
  assert.equal((await link("bad-json"))[0], 502, "읽을 수 없는 응답");
  assert.equal((await link("no-token"))[0], 502, "접근 토큰이 없는 응답");
  assert.equal((await link("no-info"))[0], 502, "사용자 정보 조회 실패");
  assert.equal((await link("no-sub"))[0], 502, "사용자 번호가 없는 응답");
  // 코드를 돌려받는 주소는 우리 출처만: 구글을 부르기 전에 거절한다(T27). 정상 코드여도 400
  const via = (redirectUri, codeVerifier = VERIFIER) => call("POST", "/api/profiles/me/links/google", { code: "code-77", redirectUri, codeVerifier }).then(([s]) => s);
  const before = tokenCalls;
  for (const bad of [
    "https://evil.example/cb", "http://gachita.mangowhois.ai/cb", "https://gachita.mangowhois.ai.evil.example/cb", "https://gachita.mangowhois.ai@evil.example/cb",
    "https://user:pw@gachita.mangowhois.ai/cb", "blob:https://gachita.mangowhois.ai/x", "https://GACHITA.mangowhois.ai/cb", "https://gachita.mangowhois.ai",
    "http://localhost.evil.example/cb", "http://evil.example@localhost/", "http:localhost/cb", "https://localhost/cb", "http://[::1]/", "javascript:alert(1)", "x",
    "https://gachita.mangowhois.ai/", "https://gachita.mangowhois.ai/auth/google", "https://gachita.mangowhois.ai/oauth/google/callback?next=x",
    "https://gachita.mangowhois.ai/oauth/google/callback#x", "https://gachita.mangowhois.ai/oauth/google/callback/", "http://localhost:5173/cb",
    "https://gachita.mangowhois.ai/oauth/google/callback?", "https://gachita.mangowhois.ai/oauth/google/callback#", "http://localhost:5173/oauth/google/callback?",
    "https://gachita.mangowhois.ai:443/oauth/google/callback", "HTTPS://gachita.mangowhois.ai/oauth/google/callback", "http://localhost:/oauth/google/callback",
  ]) {
    assert.equal(await via(bad), 400, bad);
  }
  // PKCE: code_verifier가 없거나 형식이 틀리면 구글을 부르기 전에 400, 맞지 않으면 구글이 거절해 401
  for (const bad of [null, "", "v".repeat(42), "v".repeat(129), `${"v".repeat(42)}!`, 43]) assert.equal(await via(OURS, bad), 400, `codeVerifier ${bad}`);
  assert.equal((await call("POST", "/api/profiles/me/links/google", { code: "code-77", redirectUri: OURS }))[0], 400, "codeVerifier가 없음");
  assert.equal(tokenCalls, before, "거절한 주소·verifier로는 구글을 부르지 않는다");
  assert.equal(await via(OURS, "w".repeat(43)), 401, "verifier가 맞지 않음");
  assert.equal(await via("http://127.0.0.1:8787/oauth/google/callback"), 201, "로컬 개발 주소");
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
  const [, me] = await voicedProfile({ name: "주인" });
  const [, after] = await call("POST", "/api/profiles/me/links/google", { code: "code-9", redirectUri: OURS, codeVerifier: VERIFIER }, me.token);
  // 찾아 들어가기 요청이 연결 확인을 마친 뒤, 소유자가 다른 구글 계정으로 갈아끼운 상황(결정적 재현).
  await profilesDb().query("UPDATE profiles SET provider_user_id = 'code-B' WHERE id = $1", [after.id]);
  assert.equal(await verifyGoogleLink(after.id, "code-9"), null, "연결이 바뀌었으면 확인은 0행");
  assert.ok((await verifyGoogleLink(after.id, "code-B"))?.id, "지금 연결된 계정으로는 확인됨");
  // 바뀐 뒤 오래된 계정이 다시 로그인하면 새 프로필이 만들어진다(그 계정의 연결은 없으므로).
  const [s, again] = await call("POST", "/api/profiles/me/links/google", { code: "code-9", redirectUri: OURS, codeVerifier: VERIFIER });
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
  const [, meA] = await voicedProfile({ name: "아빠" });
  const [, meB] = await voicedProfile({ name: "아들" });
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

  // 기록본: 발화 시간순 + 부탁 함께. 이 발화에는 장소가 붙은 할 일이 없다
  const [, q] = await call("POST", `${t}/requests`, { by: pg.id, text: "화장실 가고 싶어" });
  assert.ok(q.id);
  const [, tr] = await call("GET", `${t}/transcript`, null, pa.token);
  assert.deepEqual(tr.utterances.map((u) => u.text), ["강릉 얼마나 남았어?", "휴게소 가자", "바다는 왜 짜?", "콜라 사줘"]);
  assert.deepEqual(tr.utterances[2], { device: "car", seq: 3, at: at(3), text: "바다는 왜 짜?", displayText: "바다는 왜 짜?", editedText: null, editVersion: 0, seatArea: "ROW_2_LEFT", profileId: meB.id, confidence: 0.9, lat: 37.7, lng: 128.9 });
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
  // 여행 하나의 발화는 2만 줄까지(명시적 삭제가 2초 안에 끝나게)
  await tripsDb().query(
    "INSERT INTO utterances (trip_code, device, seq, at, text, generation) SELECT $1, 'bulk', g, g, 'x', 2 FROM generate_series(1, 19999) g",
    [trip.code]
  );
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 2, items: [{ seq: 8, at: at(14), text: "넘침" }] }, freshA))[0], 409);
  await tripsDb().query("DELETE FROM utterances WHERE trip_code = $1 AND device = 'bulk'", [trip.code]);

  await tripsDb().query("UPDATE utterances SET profile_id=$2 WHERE trip_code=$1", [trip.code, meA.id]);
  // 오래된 여행도 발화와 확인 순번, 개인 피드가 유지됩니다.
  const [, mom2] = await call("POST", `${t}/moments`, { label: "바다" }, freshA);
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [trip.code]);
  await call("POST", "/api/trips", {}); // 여행 만들기가 묵은 여행과 발화를 치운다
  const left = await tripsDb().query(
    "SELECT (SELECT count(*) FROM utterances WHERE trip_code = $1)::int AS u, (SELECT count(*) FROM utterance_acks WHERE trip_code = $1)::int AS a",
    [trip.code]
  );
  assert.ok(left.rows[0].u > 0 && left.rows[0].a > 0, "시간 경과로 발화와 순번을 지우지 않습니다");
  assert.equal((await call("GET", `${t}/utterances`, null, freshA))[0], 200);
  const [, feedA5] = await call("GET", "/api/profiles/me/feed", null, meA.token);
  assert.ok(feedA5.items.some((i) => i.id === mom2.id));
  assert.ok(feedA5.items.some((i) => i.kind === "utterance" || i.text));
});

// 이전 이미지가 이미 저장한 그룹 자료다. 종료된 API로 새로 만들지 않고 DB에 넣어 호환성을 시험한다.
async function legacyGroup(ownerId, memberId = ownerId) {
  const groupId = randomUUID().slice(0, 8);
  const kidId = randomUUID();
  const code = randomUUID();
  await profilesDb().query("INSERT INTO profiles (id, name, managed_by) VALUES ($1, '옛 아이', $2)", [kidId, ownerId]);
  await profilesDb().query("INSERT INTO groups (id, kind, name, owner_id) VALUES ($1, 'family', '옛 그룹', $2)", [groupId, ownerId]);
  for (const id of new Set([ownerId, memberId, kidId])) await profilesDb().query("INSERT INTO group_members (group_id, profile_id) VALUES ($1, $2)", [groupId, id]);
  await profilesDb().query("INSERT INTO invites (code, group_id, expires_at) VALUES ($1, $2, now()+interval '1 hour')", [code, groupId]);
  return { groupId, kidId, code };
}

test("옛 QR 초대(/j)와 대리 참가는 410으로 닫고, 옛 그룹 자료는 새 그룹 API로 읽히며 프로필 삭제를 보존한다(T46·T133)", async () => {
  const [, owner] = await voicedProfile({ name: "대표" });
  const [, member] = await voicedProfile({ name: "기존 구성원" });
  const { groupId, kidId, code } = await legacyGroup(owner.id, member.id);
  await migrate(); // 다시 기동해도 롤백에 필요한 옛 표와 자료를 파괴하지 않는다.
  const count = async (table) => (await profilesDb().query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const tables = ["profiles", "tokens", "groups", "group_members", "invites"];
  const before = await Promise.all(tables.map(count));
  // 그룹(/api/groups)은 새 모양으로 되살렸다(T133, groups.test.js). 옛 QR 초대 주소만 계속 닫혀 있다.
  const paths = ["/api/j", `/api/j/${code}`, `/api/j/${code}/extra`];
  const logs = [];
  captureLog((line) => logs.push(line));
  try {
    for (const path of paths) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${owner.token}` }, body: ["POST", "PUT", "PATCH"].includes(method) ? "not-json" : undefined });
        const body = await res.json();
        assert.equal(res.status, 410, `${method} ${path}`);
        assert.match(res.headers.get("cache-control"), /no-store/);
        assert.deepEqual(Object.keys(body).sort(), ["error", "type"]);
        assert.equal(body.type, "gone");
        assert.match(body.error, /폰.*동승 연결 QR.*주차/);
        for (const value of [owner.token, code, groupId, kidId]) assert.ok(!JSON.stringify(body).includes(value), "옛 코드·토큰·개인 식별자를 응답에 넣지 않음");
      }
    }
    assert.equal((await call("POST", `/api/j/${code}`, { name: "새 사람" }))[0], 410, "무인증 수락도 토큰을 만들지 않음");
    assert.equal((await call("POST", "/api/j", {}, "wrong-token"))[0], 410, "종료 안내는 인증 판정 전에 반환");
    assert.ok(!logs.join("\n").includes(code), "옛 초대 코드가 로그에 남지 않음");
    assert.ok(!logs.join("\n").includes(owner.token), "프로필 토큰이 로그에 남지 않음");
  } finally {
    captureLog(() => {});
  }
  assert.deepEqual(await Promise.all(tables.map(count)), before, "그룹·프로필·초대·토큰을 만들거나 지우지 않음");
  assert.equal((await profilesDb().query("SELECT uses FROM invites WHERE code=$1", [code])).rows[0].uses, 0);

  const tripCount = () => tripsDb().query("SELECT count(*)::int AS n FROM trips").then((r) => r.rows[0].n);
  const beforeTrips = await tripCount();
  // 옛 그룹은 새 그룹 API로 읽힌다: 대표, 계정 있는 구성원, 대표가 만든 아이(옛 crew·family는 guest·family)
  const [, listed] = await call("GET", "/api/groups", null, owner.token);
  assert.deepEqual(listed.items.map((g) => [g.id, g.kind, g.invite]), [[groupId, "family", null]], "옛 /j 초대 코드는 새 초대로 보이지 않음");
  assert.deepEqual(listed.items[0].members.map((m) => [m.profileId, m.role, m.seat]), [[owner.id, "owner", null], [member.id, "adult", null], [kidId, "child", null]]);
  assert.equal((await call("GET", `/api/group-invites/${code}`))[0], 404, "옛 초대 코드로는 들어가지 못함");
  assert.equal((await call("POST", "/api/trips", { groupId }, owner.token))[0], 409, "자리가 정해진 구성원이 없는 옛 그룹으로는 여행을 만들지 않음");
  assert.equal(await tripCount(), beforeTrips);
  const [, trip] = await call("POST", "/api/trips", {});
  const path = `/api/trips/${trip.code}/participants`;
  for (const profileId of [kidId, owner.id, null]) {
    assert.equal((await call("POST", path, { seat: "ROW_1_LEFT", profileId }, owner.token))[0], 410, "타 프로필 지정 방식은 종료");
  }
  assert.equal((await call("GET", `/api/trips/${trip.code}`))[1].participants.length, 0);
  const [joined, own] = await call("POST", path, { seat: "ROW_1_LEFT", consent: false }, owner.token);
  assert.equal(joined, 201, "자기 프로필 참가 유지");
  assert.equal((await call("PATCH", `${path}/${own.id}`, { consent: true }))[0], 401);
  assert.equal((await call("PATCH", `${path}/${own.id}`, { consent: true }, own.token))[0], 200);
  assert.equal((await call("POST", path, { seat: "ROW_1_RIGHT", name: "손님", consent: false }))[0], 201, "손님 참가 유지");

  assert.equal((await call("DELETE", "/api/profiles/me", null, owner.token))[0], 204);
  assert.equal((await profilesDb().query("SELECT id FROM profiles WHERE id=ANY($1::uuid[])", [[owner.id, kidId]])).rows.length, 0, "대표와 관리 대상 프로필 삭제 유지");
  assert.equal((await profilesDb().query("SELECT id FROM groups WHERE id=$1", [groupId])).rows.length, 0);
  assert.equal((await profilesDb().query("SELECT code FROM invites WHERE code=$1", [code])).rows.length, 0);
  assert.equal((await profilesDb().query("SELECT profile_id FROM group_members WHERE group_id=$1", [groupId])).rows.length, 0);
  assert.equal((await call("GET", "/api/profiles/me", null, member.token))[1].id, member.id, "계정 있는 다른 구성원은 유지");
});

test("기기별 프로필 토큰과 사진은 그룹 종료 뒤에도 동작한다", async () => {
  const [, mom] = await voicedProfile({ name: "엄마", character: "bunny" });
  // 같은 프로필의 두 기기 토큰은 서로를 끊지 않는다(티켓 완료 기준)
  const [ct, car] = await call("POST", "/api/profiles/me/tokens", { device: "car" }, mom.token);
  assert.equal(ct, 201);
  const [, fromCar] = await call("GET", "/api/profiles/me", null, car.token);
  const [, fromPhone] = await call("GET", "/api/profiles/me", null, mom.token);
  assert.deepEqual([fromCar.id, fromCar.character, fromPhone.id], [mom.id, "bunny", mom.id]);

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
  const [, fresh] = await voicedProfile({ name: "새 판" });
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
// 천천히 올리는 본문: 앞 조각만 보내 두고, 서버가 첫 확인을 마칠 때까지 기다린 뒤 release()로 나머지를 보낸다(업로드 중의 경합 재현).
const slowPost = async (path, buf, token, headers = {}) => {
  let release;
  const gate = new Promise((ok) => (release = ok));
  const body = new ReadableStream({
    async start(c) {
      c.enqueue(buf.subarray(0, 100));
      await gate;
      c.enqueue(buf.subarray(100));
      c.close();
    },
  });
  const done = fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers }, body, duplex: "half" });
  await new Promise((ok) => setTimeout(ok, 200));
  return { release, done };
};

test("목소리 등록으로 발화의 화자를 프로필에 붙인다(T38)", async () => {

  // 등록: 원본은 어디에도 남기지 않고 대조용 값만
  const [, mom] = await voicedProfile({ name: "엄마" });
  const [, dad] = await voicedProfile({ name: "아빠" });
  const reg = await postRaw("/api/profiles/me/voice", wav(210, 3), mom.token);
  assert.equal(reg.status, 200);
  const regBody = await reg.json();
  assert.deepEqual([regBody.seconds, regBody.dims > 50], [3, true]);
  assert.equal((await postRaw("/api/profiles/me/voice", wav(210, 2), mom.token)).status, 200, "다시 등록하면 값을 바꿈");
  assert.equal((await postRaw("/api/profiles/me/voice", wav(340, 2), dad.token)).status, 200);
  assert.equal((await postRaw("/api/profiles/me/voice", wav(210, 3))).status, 401, "토큰 없이는 등록 못 함");
  assert.equal((await fetch(`${base}/api/profiles/me/voice`, { method: "POST", headers: { authorization: `Bearer ${mom.token}` }, body: Buffer.from("not-wav") })).status, 400, "WAV만 받음");
  const raws = await profilesDb().query("SELECT count(*)::int AS n FROM voice_prints WHERE profile_id = ANY($1::uuid[])", [[mom.id, dad.id]]);
  assert.equal(raws.rows[0].n, 2, "등록값 두 개(원본 음성은 표에 없음, 사람마다 하나)");

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

  // 옛 판이 저장한 관리 프로필의 목소리도 대표의 프로필 삭제에 함께 지워진다.
  const { kidId } = await legacyGroup(mom.id);
  await profilesDb().query("INSERT INTO voice_prints (profile_id, vector, seconds) SELECT $1, vector, seconds FROM voice_prints WHERE profile_id=$2", [kidId, mom.id]);
  const prints = async (id) => (await profilesDb().query("SELECT count(*)::int AS n FROM voice_prints WHERE profile_id = $1", [id])).rows[0].n;
  assert.equal(await prints(kidId), 1);

  // 프로필을 지우면 목소리 값도 함께 지운다. 대표가 지우면 대표가 만든 아이의 값도
  assert.equal((await call("DELETE", "/api/profiles/me", null, mom.token))[0], 204);
  assert.deepEqual([await prints(mom.id), await prints(kidId)], [0, 0]);
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

  // 49시간 뒤에도 원음은 남고, 명시적으로 동의를 철회하면 지웁니다.
  await call("PATCH", `${t}/participants/${son.id}`, { consent: true }, son.token);
  const [, m6] = await call("POST", `${t}/moments`, {});
  assert.equal((await up(m6.id, clip, mom.token, 4)).status, 201);
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [trip.code]);
  await sweep();
  assert.equal(s3.objects.size, 1, "오래된 여행의 원음 보존");
  assert.equal((await fetch(`${base}${t}/recordings/${m6.id}`, {headers: {authorization: `Bearer ${mom.token}`}})).status, 200);
  await call("PATCH", `${t}/participants/${son.id}`, { consent: false });
  assert.ok(await gone(), "철회한 원음 정리");
  assert.equal((await tripsDb().query("SELECT (SELECT count(*) FROM recordings WHERE trip_code = $1 AND deleted_at IS NULL) + (SELECT count(*) FROM clip_trash) AS n", [trip.code])).rows[0].n, "0");
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
  const [, momProfile] = await voicedProfile({ name: "엄마", character: "토끼" });
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
  const guest = cues([{ at: t0, text: "손님도 바다가 보여", participantId: "matched-guest", seatArea: "ROW_2_RIGHT" }], t0, 3)[0];
  assert.equal(guest.participantId, "matched-guest", "T38이 대조한 손님 참가자 id를 프로필 없이도 숏폼에 보존");
  assert.equal(both[0].participantId, null, "화자 id가 없으면 좌석만으로 만들지 않음");
});

test("고른 장면 클립을 Nemotron으로 다시 받아 적고, 실패하면 원문 자막으로 남는다(T75)", async () => {
  assert.equal(asr.calls.length, 0, "ASR_URL·ASR_TOKEN이 없으면 보내지 않음(앞 시험들의 클립)");
  const [, trip] = await call("POST", "/api/trips", { title: "속초" });
  const t = `/api/trips/${trip.code}`;
  const t0 = Date.now() - 600_000;
  await tripsDb().query("UPDATE trips SET doc = jsonb_set(doc, '{createdAt}', to_jsonb($2::bigint)) WHERE code = $1", [trip.code, t0 - 1000]);
  const [, momProfile] = await voicedProfile({ name: "엄마" });
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
  const [, momProfile] = await voicedProfile({ name: "엄마" });
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

test("차가 대조 값을 받아 가 차 안에서 붙인 화자를 발화와 함께 올린다(ADR-0023)", async () => {
  const { cases } = JSON.parse(await readFile(new URL("voice-vectors.json", import.meta.url), "utf8"));
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, a] = await join(trip.code, "아빠", "ROW_1_LEFT", true);
  const [, b] = await join(trip.code, "누나", "ROW_2_LEFT", true);
  const [, c] = await join(trip.code, "동생", "ROW_2_RIGHT", false);
  const json = (path, body, token) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const value = (i, more = {}) => ({ embedder: "logmel-pitch-1", vector: cases[i].vector, seconds: 7, ...more });

  // 등록: 기기가 계산한 값만 올린다(소리 없이). 권한은 음성 등록과 같다
  const reg = await json(`${t}/participants/${a.id}/voice`, value(0), a.token);
  assert.deepEqual([reg.status, await reg.json()], [200, { seconds: 7, dims: 112 }]);
  assert.equal((await json(`${t}/participants/${a.id}/voice`, value(0))).status, 401);
  assert.equal((await json(`${t}/participants/${a.id}/voice`, value(0), b.token)).status, 403, "남의 값을 등록하지 못함");
  assert.equal((await json(`${t}/participants/${c.id}/voice`, value(2), c.token)).status, 409, "녹음에 동의한 뒤 등록");
  assert.equal((await json(`${t}/participants/${a.id}/voice`, value(0, { embedder: "other-1" }), a.token)).status, 400, "다른 임베더의 값은 섞지 않음");
  assert.equal((await json(`${t}/participants/${a.id}/voice`, value(0, { vector: cases[0].vector.slice(1) }), a.token)).status, 400, "차원");
  assert.equal((await json(`${t}/participants/${a.id}/voice`, value(0, { vector: cases[0].vector.map((x) => x * 2) }), a.token)).status, 400, "정규화");
  assert.equal((await json(`${t}/participants/${a.id}/voice`, value(0, { seconds: 0.5 }), a.token)).status, 400, "등록은 1초부터");
  assert.equal((await fetch(`${base}${t}/participants/${a.id}/voice`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${a.token}` }, body: "{" })).status, 400);
  assert.equal((await postRaw(`${t}/participants/${b.id}/voice`, wav(300, 3), b.token)).status, 200, "음성 등록도 그대로 됨");
  // 말소리가 없는 등록은 음성으로든 값으로든 같은 기준, 같은 문구로 거절한다
  const silence = wav(300, 3); silence.fill(0, 44);
  const noVoice = [await postRaw(`${t}/participants/${b.id}/voice`, silence, b.token), await json(`${t}/participants/${b.id}/voice`, value(0, { vector: new Array(112).fill(0) }), b.token)];
  assert.deepEqual(await Promise.all(noVoice.map(async (r) => [r.status, (await r.json()).error])), [[400, "말소리가 없어 등록할 수 없음"], [400, "말소리가 없어 등록할 수 없음"]]);

  // 조회: 녹음에 동의한 참가자가, 동의한 참가자의 값만. 저장하지 않게
  const got = await fetch(`${base}${t}/voice-prints`, { headers: { authorization: `Bearer ${a.token}` } });
  const prints = await got.json();
  assert.deepEqual([got.status, got.headers.get("cache-control")], [200, "private, no-store"]);
  assert.deepEqual([prints.generation, prints.embedder, prints.dims, prints.threshold], [1, "logmel-pitch-1", 112, 0.9]);
  assert.deepEqual([prints.floor, prints.margin], [0.6, 0.06], "기기 판정의 바닥·여백(여백 규칙)");
  assert.deepEqual(prints.items.map((p) => [p.participantId, p.source, p.vector.length]).sort(), [[a.id, "trip", 112], [b.id, "trip", 112]].sort());
  assert.deepEqual(prints.items.find((p) => p.participantId === a.id).vector, cases[0].vector, "올린 값 그대로");
  assert.equal((await call("GET", `${t}/voice-prints`))[0], 401);
  assert.equal((await call("GET", `${t}/voice-prints`, null, c.token))[0], 403, "동의하지 않은 참가자는 받지 못함");
  assert.equal((await call("POST", `${t}/voice-prints`, {}, a.token))[0], 405);
  assert.equal((await call("GET", `${t}/voice-prints/x`, null, a.token))[0], 404);

  // 발화와 함께 올린 화자. 모두 동의해야 올릴 수 있다
  await call("PATCH", `${t}/participants/${c.id}`, { consent: true }, c.token);
  const up = (items, token = a.token, device = "car") => call("POST", `${t}/utterances`, { device, generation: 1, items }, token);
  const at = trip.createdAt + 1000;
  const said = { speakerMethod: "device-voice", speakerConfidence: 0.97 };
  assert.deepEqual((await up([
    { seq: 1, at, text: "언제 도착해?", participantId: b.id, ...said },
    { seq: 2, at: at + 1, text: "곧", participantId: "nobody", ...said }, // 모르는 참가자: 묶음을 거절하지 않고 화자 없이
    { seq: 3, at: at + 2, text: "배고파" }, // 기존 클라이언트 모양
    { seq: 4, at: at + 3, text: "휴게소 가자", participantId: null },
  ]))[1], { lastSeq: 4, generation: 1 });
  const lines = async () => (await call("GET", `${t}/transcript`, null, a.token))[1].utterances.map((u) => [u.seq, u.participantId, u.speakerMethod, u.speakerConfidence]);
  assert.deepEqual(await lines(), [[1, b.id, "device-voice", 0.97], [2, undefined, undefined, undefined], [3, undefined, undefined, undefined], [4, undefined, undefined, undefined]]);
  assert.equal((await up([{ seq: 5, at, text: "x", participantId: 7, ...said }]))[0], 400);
  assert.equal((await up([{ seq: 5, at, text: "x", participantId: b.id }]))[0], 400, "화자에는 판정 방법이 따라옴");
  assert.equal((await up([{ seq: 5, at, text: "x", participantId: b.id, speakerMethod: "by-hand" }]))[0], 400);
  assert.equal((await up([{ seq: 5, at, text: "x", participantId: b.id, speakerMethod: "device-voice", speakerConfidence: 2 }]))[0], 400);
  assert.equal((await up([{ seq: 1, at, text: "x", participantId: a.id, ...said }], b.token))[0], 403, "남의 기기 발화에는 붙이지 못함");

  // 늦게 붙이기: 화자가 빈 줄을 같은 순번으로 다시 보내면 화자만 채운다. 이미 붙은 줄과 글은 바꾸지 않는다
  await up([{ seq: 3, at: at + 2, text: "다른 글", participantId: a.id, speakerMethod: "device-voice" }, { seq: 1, at, text: "언제 도착해?", participantId: a.id, ...said }]);
  assert.deepEqual((await lines()).filter((l) => l[0] === 1 || l[0] === 3), [[1, b.id, "device-voice", 0.97], [3, a.id, "device-voice", undefined]]);
  assert.equal((await call("GET", `${t}/transcript`, null, a.token))[1].utterances[2].text, "배고파");
  // 사람이 고친 줄('모름' 포함)은 덮지 않고, 고치면 판정 방법 표시가 빠진다
  await call("PATCH", `${t}/utterances/car/4`, { participantId: null }, a.token);
  await call("PATCH", `${t}/utterances/car/1`, { participantId: a.id }, a.token);
  await up([{ seq: 4, at: at + 3, text: "휴게소 가자", participantId: b.id, ...said }, { seq: 1, at, text: "언제 도착해?", participantId: b.id, ...said }]);
  assert.deepEqual((await lines()).filter((l) => l[0] === 1 || l[0] === 4), [[1, a.id, undefined, undefined], [4, undefined, undefined, undefined]]);
  // 한 묶음에 같은 순번이 두 번 와도 받는다(앞의 것)
  assert.equal((await up([{ seq: 5, at, text: "하나", participantId: a.id, ...said }, { seq: 5, at, text: "둘", participantId: b.id, ...said }]))[0], 200);
  assert.deepEqual((await lines()).find((l) => l[0] === 5).slice(0, 2), [5, a.id]);
  // 서버 대조가 붙인 줄은 server-voice로 남는다
  await up([{ seq: 6, at: at + 9, text: "노래 틀어 줘" }]);
  assert.equal((await (await postRaw(`${t}/voice-match?row=2&device=car&seq=6`, wav(300, 1.5), a.token)).json()).applied, true);
  assert.deepEqual((await lines()).find((l) => l[0] === 6).slice(0, 3), [6, b.id, "server-voice"]);

  // 둘째 값(강한 화자 값): 기기가 학습된 모델로 계산해 같은 경로로 한 번 더 올린다. 서버는 저장하고 조회 때 함께 준다
  const strong = (seed) => ({ embedder: "wespeaker-resnet34-v1", vector: Array.from({ length: 256 }, (_, i) => Math.sin(i * seed + 1)), seconds: 13.4 });
  const [, sp] = await call("POST", "/api/profiles", { name: "강한값" });
  assert.equal((await json("/api/profiles/me/voice", strong(1), sp.token)).status, 409, "1차 값을 먼저 등록");
  assert.equal((await json("/api/profiles/me/voice", value(2), sp.token)).status, 200);
  const sreg = await json("/api/profiles/me/voice", strong(1), sp.token);
  assert.deepEqual([sreg.status, await sreg.json()], [200, { seconds: 13.4, dims: 256, embedder: "wespeaker-resnet34-v1" }]);
  assert.equal((await json("/api/profiles/me/voice", { ...strong(1), vector: strong(1).vector.slice(1) }, sp.token)).status, 400, "256차원");
  assert.equal((await json("/api/profiles/me/voice", { ...strong(1), vector: new Array(256).fill(0) }, sp.token)).status, 400, "모두 0");
  assert.equal((await json("/api/profiles/me/voice", { ...strong(1), embedder: "wespeaker-resnet34-v2" }, sp.token)).status, 400, "모르는 임베더");
  const [, ps] = await call("POST", `${t}/participants`, { seat: "ROW_2_CENTER", consent: true }, sp.token);
  const withStrong = (await call("GET", `${t}/voice-prints`, null, a.token))[1];
  assert.equal(withStrong.strongEmbedder, "wespeaker-resnet34-v1");
  assert.deepEqual(withStrong.items.find((p) => p.participantId === ps.id).strong, strong(1).vector, "올린 값 그대로");
  assert.equal(withStrong.items.find((p) => p.participantId === a.id).strong, undefined, "둘째 값이 없는 사람은 칸이 없음");
  assert.equal(withStrong.items.find((p) => p.participantId === ps.id).vector.length, 112, "1차 값은 그대로");
  // 여행 참가자 값에도 같은 규칙. 1차 값을 다시 등록하면 둘째 값은 비운다(새 목소리와 섞이지 않게)
  assert.equal((await json(`${t}/participants/${a.id}/voice`, strong(2), a.token)).status, 200);
  assert.deepEqual((await call("GET", `${t}/voice-prints`, null, a.token))[1].items.find((p) => p.participantId === a.id).strong, strong(2).vector);
  assert.equal((await json(`${t}/participants/${a.id}/voice`, value(0), a.token)).status, 200);
  assert.equal((await call("GET", `${t}/voice-prints`, null, a.token))[1].items.find((p) => p.participantId === a.id).strong, undefined);
  assert.equal((await json("/api/profiles/me/voice", value(2), sp.token)).status, 200);
  assert.equal((await call("GET", `${t}/voice-prints`, null, a.token))[1].items.find((p) => p.participantId === ps.id).strong, undefined);
  // 목소리를 지우면 두 값이 함께 사라진다(같은 줄)
  assert.equal((await json("/api/profiles/me/voice", strong(1), sp.token)).status, 200);
  assert.equal((await call("DELETE", "/api/profiles/me/voice", null, sp.token))[0], 204);
  assert.equal((await profilesDb().query("SELECT count(*)::int AS n FROM voice_prints WHERE profile_id = $1", [sp.id])).rows[0].n, 0);
  assert.equal((await call("GET", `${t}/voice-prints`, null, a.token))[1].items.some((p) => p.participantId === ps.id), false);

  // 한도(2만 줄)에 닿은 여행에서도 이미 받은 줄의 화자는 채운다. 새 줄만 거절한다
  await up([{ seq: 7, at: at + 10, text: "창문 열어도 돼?" }]);
  await tripsDb().query("INSERT INTO utterances (trip_code, device, seq, at, text, generation) SELECT $1, 'filler', g, $2, 'x', 1 FROM generate_series(1, 20000 - 7) g", [trip.code, at]);
  assert.deepEqual((await up([{ seq: 7, at: at + 10, text: "창문 열어도 돼?", participantId: b.id, ...said }])), [200, { lastSeq: 7, generation: 1 }]);
  assert.deepEqual((await lines()).find((l) => l[0] === 7 && l[1]).slice(0, 3), [7, b.id, "device-voice"]);
  assert.equal((await up([{ seq: 7, at: at + 10, text: "창문 열어도 돼?", participantId: b.id, ...said }, { seq: 8, at: at + 11, text: "새 줄" }]))[0], 409, "새 줄은 한도에 걸림");
  await tripsDb().query("DELETE FROM utterances WHERE trip_code = $1 AND device = 'filler'", [trip.code]);

  // 값을 모으는 사이 누군가 동의를 철회하면, 철회 전 목록으로 읽은 그 사람의 프로필 값을 내주지 않는다(세대도 철회 뒤의 값)
  const [, mom] = await voicedProfile({ name: "엄마" });
  assert.equal((await json("/api/profiles/me/voice", value(1), mom.token)).status, 200, "프로필에도 값만 등록");
  const [, pm] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT", consent: true }, mom.token);
  assert.deepEqual((await call("GET", `${t}/voice-prints`, null, a.token))[1].items.find((p) => p.participantId === pm.id)?.source, "profile");
  const pool = profilesDb();
  const query = pool.query;
  let raced = 0;
  pool.query = async function (sql, ...rest) { // 프로필 값을 읽는 바로 그때 철회가 끼어든다
    if (typeof sql === "string" && sql.includes("FROM voice_prints WHERE profile_id = ANY") && !raced++) await call("PATCH", `${t}/participants/${pm.id}`, { consent: false });
    return query.call(this, sql, ...rest);
  };
  try {
    const [status, body] = await call("GET", `${t}/voice-prints`, null, a.token);
    assert.deepEqual([status, raced > 0, body.generation, body.items.some((p) => p.participantId === pm.id)], [200, true, 2, false]);
  } finally {
    pool.query = query;
  }
  await call("PATCH", `${t}/participants/${pm.id}`, { consent: true }, pm.token);

  // 동의가 꺼진 참가자의 값은 내주지 않고(서버에서도 지워짐), 그 사람은 화자로 붙지 않는다
  await call("PATCH", `${t}/participants/${b.id}`, { consent: false });
  const after = (await call("GET", `${t}/voice-prints`, null, a.token))[1];
  assert.deepEqual([after.generation, after.items.map((p) => p.participantId).sort()], [3, [a.id, pm.id].sort()]);
});

test("손님 참가자도 여행에 목소리를 등록하면 화자가 붙는다(T38·T37)", async () => {
  // 차의 가족은 손님 참가자다(프로필 없음). 등록값은 여행에 두고, 동의를 끄면 지운다.
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
  // 옛 파드가 끄기를 받아 값이 남았더라도, 다시 켜면 지운다(다시 등록해야 쓰임)
  await tripsDb().query("INSERT INTO trip_voice_prints (trip_code, participant_id, vector, seconds) VALUES ($1, $2, '{1}', 3)", [trip.code, b.id]);
  await call("PATCH", `${t}/participants/${b.id}`, { consent: true }, b.token);
  assert.equal(await prints(b.id), 0, "꺼져 있다 켜지면 옛 값을 지움");
  await call("PATCH", `${t}/participants/${c.id}`, { consent: true }, c.token);
  assert.equal(await prints(c.id), 1, "켜진 채로 다시 켜면 그대로");
  const [, me] = await voicedProfile({ name: "삼촌" });
  await postRaw("/api/profiles/me/voice", wav(260, 3), me.token);
  const [, d] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT", consent: false }, me.token);
  const r3 = await (await postRaw(`${t}/voice-match?row=1`, wav(260, 1.5), a.token)).json();
  assert.equal(r3.participantId, null, "동의하지 않은 사람은 프로필 등록값이 있어도 후보가 아님");
  await call("PATCH", `${t}/participants/${d.id}`, { consent: true }, d.token);
  const r4 = await (await postRaw(`${t}/voice-match?row=1`, wav(260, 1.5), a.token)).json();
  assert.deepEqual([r4.participantId, r4.profileId], [d.id, me.id], "동의하면 프로필 등록값으로 찾음");

  // 업로드하는 사이 동의가 바뀌어도: 대조는 받은 뒤 최신 여행으로 후보를 정하고(리뷰 재현),
  // 등록은 처음 확인 때의 동의 세대가 그대로일 때만 저장한다(껐다 켜도 철회 전 등록은 되살아나지 않음)
  const match = await slowPost(`${t}/voice-match?row=1`, wav(260, 1.5), a.token);
  await call("PATCH", `${t}/participants/${d.id}`, { consent: false });
  match.release();
  assert.equal((await (await match.done).json()).participantId, null, "업로드 중 동의를 끈 사람은 후보가 아님");
  const late = await slowPost(`${t}/participants/${c.id}/voice`, wav(340, 3), c.token);
  await call("PATCH", `${t}/participants/${c.id}`, { consent: false });
  await call("PATCH", `${t}/participants/${c.id}`, { consent: true }, c.token);
  late.release();
  assert.equal((await late.done).status, 409);
  assert.equal(await prints(c.id), 0, "철회 전에 시작한 등록은 저장되지 않음");

  // 오래된 여행의 목소리 등록은 유지하고 동의 철회 때 지웁니다.
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [trip.code]);
  assert.equal((await postRaw(`${t}/voice-match?row=1`, wav(210, 1.5), a.token)).status, 200);
  await sweep();
  assert.equal(await prints(a.id), 1);
  await call("PATCH", `${t}/participants/${a.id}`, { consent: false });
  assert.deepEqual([await prints(a.id), await prints(c.id)], [0, 0]);
});

test("차 화면에서 고친 화자를 발화 줄에 남긴다(T37)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, a] = await join(trip.code, "아빠", "ROW_1_LEFT", true);
  const [, b] = await join(trip.code, "누나", "ROW_2_LEFT", true);
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 1, at: trip.createdAt + 1000, text: "배고파" }] }, a.token);
  const fix = (seq, participantId, token) => call("PATCH", `${t}/utterances/car/${seq}`, { participantId }, token);

  assert.equal((await fix(1, b.id))[0], 401, "토큰이 필요함");
  assert.equal((await fix(1, b.id, b.token))[0], 403, "그 기기로 올린 참가자만");
  const [s1, u1] = await fix(1, b.id, a.token);
  assert.deepEqual([s1, u1.seq, u1.text, u1.participantId, u1.profileId], [200, 1, "배고파", b.id, undefined]);
  assert.equal((await call("GET", `${t}/transcript`, null, a.token))[1].utterances[0].participantId, b.id, "기록본에 고친 화자");
  assert.equal((await fix(1, a.id, a.token))[1].participantId, a.id, "이미 붙은 화자도 바꿈");
  assert.equal((await fix(1, null, a.token))[1].participantId, undefined, "null이면 모름으로");
  assert.equal((await fix(1, "nobody", a.token))[0], 400);
  assert.equal((await fix(9, b.id, a.token))[0], 404, "없는 발화");
  assert.equal((await call("PATCH", `${t}/utterances/phone/1`, { participantId: b.id }, a.token))[0], 404, "올린 적 없는 기기");
  assert.equal((await call("PATCH", `${t}/utterances/car`, { participantId: b.id }, a.token))[0], 405);

  // 사람이 '모름'으로 고친 줄은 뒤늦게 끝난 대조가 다시 채우지 않는다(Astra 지적)
  assert.equal((await postRaw(`${t}/participants/${a.id}/voice`, wav(210, 3), a.token)).status, 200);
  const late = await (await postRaw(`${t}/voice-match?row=1&device=car&seq=1`, wav(210, 1.5), a.token)).json();
  assert.deepEqual([late.participantId, late.applied], [a.id, false], "찾기는 하지만 고친 줄에는 붙이지 않음");
  assert.equal((await call("GET", `${t}/transcript`, null, a.token))[1].utterances[0].participantId, undefined);

  // 기기 이름에 공백·한글이 있어도 주소의 마디를 풀어 찾는다. 잘못된 인코딩은 400
  await call("POST", `${t}/utterances`, { device: "차 1", generation: 1, items: [{ seq: 1, at: trip.createdAt + 2000, text: "물 줘" }] }, a.token);
  assert.equal((await call("PATCH", `${t}/utterances/${encodeURIComponent("차 1")}/1`, { participantId: b.id }, a.token))[1].participantId, b.id);
  assert.equal((await call("PATCH", `${t}/utterances/%E0%A4%A/1`, { participantId: b.id }, a.token))[0], 400);

  // 프로필 참가자로 고치면 피드에도 나오도록 profile_id가 같이 붙고, 동의하지 않은 사람의 이름은 붙이지 않는다
  const [, me] = await voicedProfile({ name: "엄마" });
  const [, m] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT", consent: true }, me.token);
  assert.deepEqual(Object.entries((await fix(1, m.id, a.token))[1]).filter(([k]) => k.endsWith("Id")), [["participantId", m.id], ["profileId", me.id]]);
  await call("PATCH", `${t}/participants/${b.id}`, { consent: false });
  assert.equal((await fix(1, b.id, a.token))[0], 409);
});

test("한 여행의 내 앨범 장면을 발화와 섞거나 자르지 않고 준다(T81 공유 후보)", async () => {
  const [, me] = await voicedProfile({ name: "엄마" });
  const [, you] = await voicedProfile({ name: "아빠" });
  const [, trip] = await call("POST", "/api/trips", {});
  const [, other] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, mine] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, me.token);
  const [, yours] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT", consent: true }, you.token);
  const [, elsewhere] = await call("POST", `/api/trips/${other.code}/participants`, { seat: "ROW_1_LEFT", consent: true }, me.token);
  const now = Date.now();
  const [, later] = await call("POST", `${t}/moments`, { at: now + 2000, label: "나중", lat: 37.5, lng: 127 }, mine.token);
  const [, earlier] = await call("POST", `${t}/moments`, { at: now + 1000, label: "먼저" }, mine.token); // 늦게 남겨도 시각 순
  await call("POST", `${t}/moments`, { label: "아빠 것" }, yours.token); // 남의 앨범
  await call("POST", `/api/trips/${other.code}/moments`, { label: "다른 여행" }, elsewhere.token);
  // 피드를 100개로 채우는 발화가 있어도 장면은 빠지지 않는다
  const items = Array.from({ length: 120 }, (_, i) => ({ seq: i + 1, at: now - 5000 + i, text: `말 ${i}`, generation: 1 }));
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", items }, mine.token))[0], 200);
  await tripsDb().query("UPDATE utterances SET profile_id = $2 WHERE trip_code = $1", [trip.code, me.id]);
  const [, feed] = await call("GET", "/api/profiles/me/feed", null, me.token);
  assert.equal(feed.items.length, 100);

  const [status, album] = await call("GET", `/api/profiles/me/moments?trip=${trip.code.toLowerCase()}`, null, me.token);
  assert.equal(status, 200);
  assert.deepEqual(album.items, [
    { id: earlier.id, tripCode: trip.code, at: now + 1000, label: "먼저" },
    { id: later.id, tripCode: trip.code, at: now + 2000, label: "나중", lat: 37.5, lng: 127 },
  ], "그 여행의 내 장면만, 시각 순, 대소문자 무관");
  assert.equal((await call("GET", `/api/profiles/me/moments?trip=${trip.code}`))[0], 401);
  for (const bad of ["", "ABC", "ABCDEFG", "ABC10O", "ABC%00D"]) assert.equal((await call("GET", `/api/profiles/me/moments?trip=${bad}`, null, me.token))[0], 400);
  assert.equal((await call("GET", "/api/profiles/me/moments", null, me.token))[0], 400, "trip이 필요");
});

test("쓰기가 몰려도 서버가 멈추지 않는다", async () => {
  // 같은 여행에 쓰기 15개가 동시에 닥쳐도 모두 응답해야 한다(리뷰 재현).
  const [, me] = await voicedProfile({ name: "지우", consentDefault: true });
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

test("옛 초대 주소는 안내하고 Google 콜백·시연·일반 화면은 유지한다", async () => {
  for (const path of ["/", "/oauth/google/callback?code=x&state=y", "/demo"]) { // 구글 로그인 콜백도 웹앱(T27)
    const res = await fetch(base + path);
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/html; charset=utf-8"], path);
  }
  for (const path of ["/j", "/j/abcDEF123", "/%6a/abcDEF123", "/j/abcDEF123/extra"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 410);
    assert.match(res.headers.get("cache-control"), /no-store/);
    const html = await res.text();
    assert.match(html, /동승 연결 QR/);
    assert.ok(!html.includes("abcDEF123"), "초대 코드는 화면에 반사하지 않음");
  }
  assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await fetch(`${base}/nothing.js`)).status, 404, "없는 파일은 그대로 404");
  assert.equal((await fetch(`${base}/..%2F..%2Fbackend%2Fapi%2Fserver.js`)).status, 404, "웹 폴더 밖은 404");
  const outside = await fetch(`${base}/..%2F..%2Fbackend%2Fapi`);
  assert.ok((await outside.text()).includes("<title>가치타</title>"), "확장자 없는 주소로 웹 폴더 밖을 가리켜도 웹앱 첫 화면만 나옴");
});

test("정적 PNG·JPEG·ICO는 이진 형식과 원본 바이트·ETag를 유지합니다(T109)", async () => {
  const dir = await mkdtemp(fileURLToPath(new URL("../../frontend/web/mime-test-", import.meta.url)));
  try {
    for (const [extension, type, bytes] of [
      ["png", "image/png", [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]],
      ["jpg", "image/jpeg", [0xff, 0xd8, 0xff, 0xe0, 0, 16]],
      ["jpeg", "image/jpeg", [0xff, 0xd8, 0xff, 0xe1, 0, 16]],
      ["ico", "image/vnd.microsoft.icon", [0, 0, 1, 0, 1, 0]],
      ["PNG", "image/png", [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]],
      ["bin", "application/octet-stream", [0, 0xff, 0x80]],
    ]) {
      const data = Buffer.from(bytes), name = `sample.${extension}`;
      await writeFile(joinPath(dir, name), data);
      const url = `${base}/${basename(dir)}/${name}`;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), type, extension);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), data, "이미지를 문자열로 변환하지 않습니다");
      assert.equal(response.headers.get("cache-control"), "no-cache");
      const unchanged = await fetch(url, { headers: { "if-none-match": response.headers.get("etag") } });
      assert.equal(unchanged.status, 304);
      assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
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

test("수동 자막은 동의한 여행 참가자만 고치며 동시 수정·세대를 검사하고 오래된 여행도 보존한다(T80)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, a] = await join(trip.code, "지우", "ROW_1_LEFT");
  const [, b] = await join(trip.code, "하늘", "ROW_2_LEFT", false);
  const device = "차 / 기기%";
  const path = `${t}/captions/${encodeURIComponent(device)}/1`;
  const edit = (text, expectedVersion = 0, token = a.token, generation = 1) => call("PATCH", path, { text, expectedVersion, generation }, token);
  assert.equal((await edit("수정", 0, b.token))[0], 403);
  await call("PATCH", `${t}/participants/${b.id}`, { consent: true }, b.token);
  const item = { seq: 1, at: trip.createdAt + 1000, text: "원래 말", generation: 1 };
  assert.equal((await call("POST", `${t}/utterances`, { device, items: [item] }, a.token))[0], 200);
  // `.`·`..`는 주소 마디로 쓰면 URL 정규화로 사라져 자막을 고칠 수 없으므로 올릴 때 거절한다(Astra)
  for (const odd of [".", ".."]) assert.equal((await call("POST", `${t}/utterances`, { device: odd, items: [item] }, a.token))[0], 400);
  const [, otherTrip] = await call("POST", "/api/trips", {});
  const [, other] = await join(otherTrip.code, "다른 여행", "ROW_1_LEFT");
  assert.equal((await edit("수정", 0, other.token))[0], 401);
  assert.equal((await call("PATCH", path, { text: "수정", expectedVersion: 0, generation: 1 }))[0], 401);
  for (const bad of ["", " ", "가".repeat(501), 3, "\0", "\ud800"])
    assert.equal((await edit(bad))[0], 400);
  for (const patch of [{ expectedVersion: -1 }, { expectedVersion: 0.5 }, { expectedVersion: "0" }, { generation: undefined }, { text: undefined }])
    assert.equal((await call("PATCH", path, { text: "수정", expectedVersion: 0, generation: 1, ...patch }, a.token))[0], 400);
  assert.equal((await edit("수정", 0, a.token, 2))[0], 409);
  assert.equal((await call("PATCH", `${t}/captions/%GG/1`, {}, a.token))[0], 400);
  assert.equal((await call("PATCH", `${t}/captions/car/1/extra`, {}, a.token))[0], 404);
  const replies = await Promise.all([edit(" 첫 수정 "), edit("다른 수정", 0, b.token)]);
  assert.deepEqual(replies.map(([s]) => s).sort(), [200, 409]);
  const saved = replies.find(([s]) => s === 200)[1].utterance;
  assert.equal(saved.editVersion, 1);
  assert.equal(saved.text, item.text);
  assert.equal(saved.displayText, saved.editedText);
  assert.ok([a.id, b.id].includes(saved.editedBy) && Number.isInteger(saved.editedAt));
  const row = (await call("GET", `${t}/transcript`, null, a.token))[1].utterances[0];
  assert.deepEqual(row, saved, "다른 요청에서도 동일한 수정본·버전");
  const sync = (await call("GET", `${t}/utterances`, null, b.token))[1].items[0];
  assert.deepEqual(sync, saved, "차량 동기화에도 원문과 수정본을 분리");
  const [, reset] = await edit(null, 1, b.token);
  assert.deepEqual([reset.utterance.editedText, reset.utterance.editVersion, reset.utterance.displayText], [null, 2, item.text]);
  await edit("철회 대상", 2);
  await call("PATCH", `${t}/participants/${b.id}`, { consent: false });
  assert.equal((await edit("옛 요청", 3))[0], 409);
  assert.equal((await edit("미동의", 3, b.token, 2))[0], 403);
  assert.equal((await edit("지워진 말", 3, a.token, 2))[0], 404);
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM utterances WHERE trip_code = $1", [trip.code])).rows[0].n, 0);
  await call("PATCH", `${t}/participants/${b.id}`, { consent: true }, b.token);
  await call("POST", `${t}/utterances`, { device, items: [{ ...item, seq: 2, generation: 2 }] }, a.token);
  const second = `${t}/captions/${encodeURIComponent(device)}/2`;
  assert.equal((await call("PATCH", second, { text: "만료 대상", expectedVersion: 0, generation: 2 }, b.token))[0], 200);
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [trip.code]);
  assert.equal((await call("PATCH", second, { text: "오래된 여행", expectedVersion: 1, generation: 2 }, b.token))[0], 200);
  assert.equal((await call("GET", `${t}/transcript`, null, a.token))[0], 200);
  await sweep();
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM utterances WHERE trip_code = $1", [trip.code])).rows[0].n, 1);
});

test("늦은 ASR은 수동 자막을 덮지 않고 초기화·자기 글 삭제는 숏폼에도 반영한다(T80)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, profile] = await voicedProfile({ name: "지우" });
  const [, a] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, profile.token);
  const [, b] = await join(trip.code, "하늘", "ROW_2_LEFT");
  const original = "서와야 바다 봐";
  const item = { seq: 1, at: trip.createdAt + 1000, text: original, generation: 1 };
  await call("POST", `${t}/utterances`, { device: "car", items: [item] }, a.token);
  await tripsDb().query("UPDATE utterances SET profile_id = $2 WHERE trip_code = $1", [trip.code, profile.id]);
  const [, moment] = await call("POST", `${t}/moments`, { at: item.at, from: trip.createdAt, to: trip.createdAt + 5000 });
  const path = `${t}/captions/car/1`;
  const edit = (text, expectedVersion) => call("PATCH", path, { text, expectedVersion, generation: 1 }, b.token);
  Object.assign(process.env, { ASR_URL: `http://127.0.0.1:${fakeAsr.address().port}/asr/v1`, ASR_TOKEN: "test-asr-token", ASR_GAP_MS: "20" });
  let saved;
  asr.onCall = async () => { saved = await edit("서아야 저 바다를 봐", 0); };
  try {
    assert.equal((await fetch(`${base}${t}/recordings?moment=${moment.id}&generation=1&from=${trip.createdAt}`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: wav(200, 5) })).status, 201);
    let row;
    for (let i = 0; i < 300; i++) {
      row = (await call("GET", `${t}/transcript`, null, a.token))[1].utterances[0];
      if (row.asrText) break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    assert.equal(saved[0], 200);
    assert.deepEqual([row.text, row.asrText, row.editedText, row.displayText, row.editVersion], [original, "서아야 바다 봐.", "서아야 저 바다를 봐", "서아야 저 바다를 봐", 1]);
    const form = (await call("GET", `${t}/shortform`, null, a.token))[1];
    const cue = form.scenes[0].cues[0];
    assert.equal(form.generation, 1);
    assert.deepEqual([cue.device, cue.seq, cue.text, cue.raw, cue.asrText, cue.editVersion, cue.editedBy], ["car", 1, row.displayText, original, row.asrText, 1, b.id]);
    assert.equal((await edit(null, 1))[1].utterance.displayText, row.asrText);
    assert.equal((await call("GET", `${t}/shortform`, null, a.token))[1].scenes[0].cues[0].text, row.asrText);
    await edit("삭제 대상 수정본", 2);
    assert.equal((await call("DELETE", `${t}/utterances`, null, a.token))[1].deleted, 1);
    assert.equal((await edit("되살리기", 3))[0], 404);
    await call("POST", `${t}/utterances`, { device: "car", items: [item] }, a.token);
    assert.equal((await call("GET", `${t}/transcript`, null, a.token))[1].utterances.length, 0);
    assert.equal((await call("GET", `${t}/shortform`, null, a.token))[1].scenes[0].cues.length, 0);
    const gone = (await tripsDb().query("SELECT text, asr_text, edited_text, edit_version, edited_by, edited_at FROM utterances WHERE trip_code = $1", [trip.code])).rows[0];
    assert.deepEqual(gone, { text: "", asr_text: null, edited_text: null, edit_version: 0, edited_by: null, edited_at: null });
    // 혼재 배포/되돌린 이미지의 옛 DELETE SQL도 새 수정 칸을 남기지 않아야 한다.
    delete process.env.ASR_URL; // 다음 발화에 새 비동기 작업을 시작하지 않는다.
    await call("POST", `${t}/utterances`, { device: "car", items: [{ ...item, seq: 2 }] }, a.token);
    await call("PATCH", `${t}/captions/car/2`, { text: "구 서버에서도 지울 수정본", expectedVersion: 0, generation: 1 }, b.token);
    await tripsDb().query("UPDATE utterances SET text = '', asr_text = NULL WHERE trip_code = $1 AND seq = 2", [trip.code]);
    const oldDelete = (await tripsDb().query("SELECT edited_text, edit_version, edited_by, edited_at FROM utterances WHERE trip_code = $1 AND seq = 2", [trip.code])).rows[0];
    assert.deepEqual(oldDelete, { edited_text: null, edit_version: 0, edited_by: null, edited_at: null });
  } finally {
    asr.onCall = null;
    delete process.env.ASR_URL; delete process.env.ASR_TOKEN; delete process.env.ASR_GAP_MS;
  }
});

async function shortFixture() {
  const [,trip]=await call('POST','/api/trips',{title:'영상 시험'});
  const path=`/api/trips/${trip.code}`;
  const [,a]=await join(trip.code,'동승자','ROW_1_LEFT');
  const [,b]=await join(trip.code,'친구','ROW_1_RIGHT');
  const at=Date.now();
  const [,moment]=await call('POST',`${path}/moments`,{at,from:at,to:at+15_000,label:'우리 대화'});
  await call('POST',`${path}/utterances`,{device:'short-test',items:[{seq:1,at,text:'함께 떠나니 좋다',generation:1}]},a.token);
  const clip=wav(200,15);
  assert.equal((await fetch(`${base}${path}/recordings?moment=${moment.id}&generation=1&from=${at}`,{method:'POST',headers:{authorization:`Bearer ${a.token}`},body:clip})).status,201);
  await call('PATCH',path,{status:'parked'});
  const [status,plan]=await call('POST',`${path}/short-plans`,{},a.token);assert.equal(status,200);
  return {trip,path,a,b,plan,clip};
}
const shortBody=(f,key)=>({momentId:f.plan.momentId,templateId:f.plan.templateId,planHash:f.plan.planHash,generation:1,idempotencyKey:key,externalGenerationConsent:true});
// 생성 일꾼(ADR-0025)의 자리에 서서 계약을 부른다. S3와 파일 검사만 이중으로 주입한다.
const WORKER_TOKEN='w'.repeat(40);
const workerReq=(method,body,token=WORKER_TOKEN)=>Object.assign(Readable.from(body?[body]:[]),{method,headers:{authorization:`Bearer ${token}`,'content-type':'video/mp4'}});
const shortWorker=(extra={})=>{
 const objects=new Map();
 const service=shortGenerations(shortServiceContext,{ready:()=>true,media:{put:async(k,b)=>{objects.set(k,b);},get:async k=>objects.get(k),remove:async k=>{objects.delete(k);}},audio:async()=>Buffer.from('original audio'),probe:async(d,m,seconds)=>({seconds}),...extra});
 const job=(id,leaf,method,body)=>service.worker(workerReq(method,body),['jobs',id,leaf],{});
 return {service,objects,
  claim:()=>service.worker(workerReq('POST'),['claim'],{}),
  audio:id=>job(id,'audio','GET'),
  result:(id,video=Buffer.from('final MP4'))=>job(id,'result','PUT',video),
  thumbnail:(id,png,type='image/png')=>service.worker(Object.assign(workerReq('PUT',png),{headers:{authorization:`Bearer ${WORKER_TOKEN}`,'content-type':type}}),['jobs',id,'thumbnail'],{}),
  fail:(id,errorCode)=>service.worker(workerReq('POST'),['jobs',id,'fail'],{errorCode})};
};
// 다른 시험이 남긴 대기 작업을 치워 이 작업만 받아 가게 한다.
const only=(id)=>tripsDb().query("UPDATE short_generations SET state='failed' WHERE state='queued' AND id<>$1",[id]);
async function tickShort(service,id){await tripsDb().query("UPDATE short_generations SET next_attempt_at=CASE WHEN id=$1 THEN now()-interval '1 hour' ELSE now()+interval '1 hour' END",[id]);await service.tick();return (await tripsDb().query('SELECT * FROM short_generations WHERE id=$1',[id])).rows[0];}
const shortEnv=(extra={})=>Object.assign(process.env,{SHORTS_ENABLED:'true',SHORTS_WORKER_TOKEN:WORKER_TOKEN,SHORTS_DAILY_SECONDS:'1000',...extra});
const shortEnvOff=()=>{for(const k of ['SHORTS_ENABLED','SHORTS_WORKER_TOKEN','SHORTS_DAILY_SECONDS','SHORTS_TRIP_JOBS'])delete process.env[k];};

test('생성 API: 계획 확인·멱등·한도·자막 변경·철회와 다운로드 권한(T85·T157)',async()=>{
 shortEnv({SHORTS_DAILY_SECONDS:'120'});
 try{
  const f=await shortFixture();const body=shortBody(f,'same-request-key');
  const catalog=(await call('GET','/api/short-templates'))[1];
  assert.deepEqual([catalog.enabled,catalog.provider,catalog.templates.length],[true,'openai-codex',2]);
  assert.ok(f.plan.externalData.every(x=>x.startsWith('OpenAI')));assert.equal(f.plan.audioReference,false);
  assert.equal((await call('GET',`${f.path}/short-generations/${'-'.repeat(36)}`,null,f.a.token))[0],404);
  assert.equal((await call('POST',`${f.path}/short-generations`,body))[0],401);
  assert.equal((await call('POST',`${f.path}/short-generations`,{...body,externalGenerationConsent:false},f.a.token))[0],400);
  await call('PATCH',f.path,{status:'driving'});
  assert.equal((await call('POST',`${f.path}/short-generations`,body,f.a.token))[0],409);
  await call('PATCH',f.path,{status:'parked'});
  const pair=await Promise.all([call('POST',`${f.path}/short-generations`,body,f.a.token),call('POST',`${f.path}/short-generations`,body,f.a.token)]);
  assert.deepEqual(pair.map(x=>x[0]).sort(),[200,202]);assert.equal(pair[0][1].id,pair[1][1].id);
  const id=pair[0][1].id;const job=`${f.path}/short-generations/${id}`;
  assert.equal((await call('POST',`${f.path}/short-generations`,{...body,audioReference:true,idempotencyKey:'audio-reference'},f.a.token))[0],400,'원음은 외부 생성에 보내지 않는다');
  const other=await shortFixture();assert.equal((await call('GET',job,null,other.a.token))[0],401);
  assert.equal((await call('DELETE',job,null,f.b.token))[0],403);
  process.env.SHORTS_DAILY_SECONDS='1';assert.equal((await call('POST',`${f.path}/short-generations`,{...body,idempotencyKey:'next-request-key'},f.a.token))[0],429);process.env.SHORTS_DAILY_SECONDS='1000';
  // 일꾼 경로는 일꾼 토큰만 받는다(참가자 토큰·틀린 토큰은 401).
  for(const token of [undefined,f.a.token,'x'.repeat(40)])assert.equal((await call('POST','/api/short-worker/claim',{},token))[0],401);
  const w=shortWorker();await only(id);
  const [claimed,leased]=await w.claim();
  assert.equal(claimed,200);assert.equal(leased.id,id);assert.match(leased.template.direction,/no human faces/);
  assert.deepEqual(leased.plan.cues.map(c=>c.text),['함께 떠나니 좋다']);assert.equal(leased.audio,`/api/short-worker/jobs/${id}/audio`);
  assert.deepEqual(await w.claim(),[204],'임대한 작업은 다시 주지 않는다');
  assert.equal((await call('GET',job,null,f.a.token))[1].state,'generating');
  assert.equal((await w.audio(id))[1].toString(),'original audio');
  // 표지 그림(T166): 영상보다 먼저 올리고, 만드는 중에도 작업 보기에 주소가 실린다. PNG만 받는다.
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('cover')]);
  assert.equal((await call('GET',job,null,f.a.token))[1].thumbnailUrl,undefined);
  await assert.rejects(w.thumbnail(id,Buffer.from('not png')),e=>e.status===400);
  await assert.rejects(w.thumbnail(id,png,'image/jpeg'),e=>e.status===400);
  assert.deepEqual(await w.thumbnail(id,png),[200,{id,thumbnailUrl:`${job}/thumbnail`}]);
  assert.equal((await w.thumbnail(id,png))[0],200,'다시 올리면 덮는다');
  const making=await w.service.request({method:'GET',headers:{authorization:`Bearer ${f.a.token}`}},f.trip.code,'short-generations',id,null,{});
  assert.deepEqual([making[1].state,making[1].thumbnailUrl],['generating',`${job}/thumbnail`]);
  assert.deepEqual((await w.service.request({method:'GET',headers:{authorization:`Bearer ${f.a.token}`}},f.trip.code,'short-generations',id,'thumbnail',{})).slice(1),[png,'image/png'],'만드는 중에도 표지를 받는다');
  await assert.rejects(w.service.request({method:'GET',headers:{authorization:`Bearer ${other.a.token}`}},f.trip.code,'short-generations',id,'thumbnail',{}),e=>e.status===401,'다른 여행의 토큰은 못 받음');
  const bad=shortWorker({probe:async()=>{throw {status:400,error:'9:16 세로 영상이 필요해요'};}});
  await assert.rejects(bad.result(id),e=>e.status===400);assert.equal(bad.objects.size,0);
  const [done,view]=await w.result(id);assert.equal(done,200);assert.equal(view.state,'completed');assert.equal(view.progress.completedShots,view.progress.totalShots);
  assert.equal((await call('GET',job,null,f.a.token))[1].result.url,`${job}/file`);
  const req={method:'GET',headers:{authorization:`Bearer ${f.a.token}`}};
  assert.equal((await w.service.request(req,f.trip.code,'short-generations',id,'file',{}))[1].toString(),'final MP4');
  await assert.rejects(w.result(id),e=>e.status===410,'끝난 작업에 다시 올릴 수 없다');
  await call('PATCH',`${f.path}/captions/short-test/1`,{generation:1,expectedVersion:0,text:'고친 자막'},f.a.token);
  assert.equal((await call('GET',job,null,f.a.token))[0],409);
  let row=await tickShort(w.service,id);assert.equal(row.state,'canceled');row=await tickShort(w.service,id);
  assert.equal(row.cleanup_pending,false);assert.equal(w.objects.size,0);assert.equal(row.plan.estimatedGenerationSeconds,16);
  const [,plan2]=await call('POST',`${f.path}/short-plans`,{},f.a.token);
  const [,next]=await call('POST',`${f.path}/short-generations`,{...body,planHash:plan2.planHash,idempotencyKey:'after-edit-key'},f.a.token);
  process.env.SHORTS_TRIP_JOBS='2';assert.equal((await call('POST',`${f.path}/short-generations`,{...body,planHash:plan2.planHash,idempotencyKey:'trip-cap-key'},f.a.token))[0],429,'여행당 상한');
  await call('PATCH',`${f.path}/participants/${f.b.id}`,{consent:false});
  assert.equal((await call('GET',`${f.path}/short-generations/${next.id}`,null,f.a.token))[0],403);
  await only(next.id);assert.deepEqual(await w.claim(),[204],'철회된 작업은 일꾼에게 주지 않고 취소한다');
  assert.equal((await tripsDb().query('SELECT state FROM short_generations WHERE id=$1',[next.id])).rows[0].state,'canceled');
 }finally{shortEnvOff();}
});

test('일꾼 임대: 끝난 임대·실패 알림·만드는 중 삭제와 철회는 결과를 받지 않고 정리합니다(T157)',async()=>{
 shortEnv({SHORTS_TRIP_JOBS:'10'});
 try{
  const f=await shortFixture();const w=shortWorker();const make=async key=>(await call('POST',`${f.path}/short-generations`,shortBody(f,key),f.a.token))[1].id;
  const off=shortWorker({ready:()=>false});const a=await make('lease-expired');await only(a);
  assert.deepEqual(await off.claim(),[204],'꺼 두면 작업을 내주지 않는다');
  assert.equal((await w.claim())[1].id,a);
  let row=await tickShort(w.service,a);assert.deepEqual([row.state,row.error_code],['failed','worker_timeout']);
  await assert.rejects(w.result(a),e=>e.status===410);await assert.rejects(w.audio(a),e=>e.status===410);
  const b=await make('worker-fail');await only(b);await w.claim();
  assert.deepEqual((await w.fail(b,'ffmpeg_error'))[1],{id:b,state:'failed'});
  assert.equal((await tripsDb().query('SELECT error_code FROM short_generations WHERE id=$1',[b])).rows[0].error_code,'worker_ffmpeg_error');
  await assert.rejects(w.fail(b,'again'),e=>e.status===410);
  const c=await make('deleted-while-making');await only(c);await w.claim();
  assert.equal((await call('DELETE',`${f.path}/short-generations/${c}`,null,f.a.token))[0],200);
  await assert.rejects(w.result(c),e=>e.status===410);await tickShort(w.service,c);assert.equal(w.objects.size,0);
  // 올리는 사이 철회: 받은 파일은 정리 대상에 남고 작업은 취소된다.
  const d=await make('revoked-while-uploading');await only(d);await w.claim();
  const racing=shortWorker({media:{put:async(k,v)=>{w.objects.set(k,v);await call('PATCH',`${f.path}/participants/${f.b.id}`,{consent:false});},get:async k=>w.objects.get(k),remove:async k=>{w.objects.delete(k);}}});
  await assert.rejects(racing.result(d),e=>[403,410].includes(e.status));
  row=(await tripsDb().query('SELECT * FROM short_generations WHERE id=$1',[d])).rows[0];
  assert.deepEqual([row.state,row.cleanup_pending,row.object_keys],['canceled',true,[`shorts/${d}/final.mp4`]]);
  row=await tickShort(w.service,d);assert.equal(row.cleanup_pending,false);assert.equal(w.objects.size,0);
 }finally{shortEnvOff();}
});

test('재전사가 뒤늦게 글을 바꿔도 계획과 만드는 중인 작업은 그대로이고, 일꾼은 받는 순간의 글로 만든다(T158)',async()=>{
 shortEnv();
 try{
  const f=await shortFixture();const w=shortWorker();
  const asr=text=>tripsDb().query("UPDATE utterances SET asr_text=$2 WHERE trip_code=$1 AND device='short-test' AND seq=1",[f.trip.code,text]);
  // 계획을 받은 뒤 재전사가 글을 바꿔도(운영: 클립이 올라온 뒤 30~60초) 같은 계획으로 맡길 수 있다
  await asr('함께 떠나니 참 좋다');
  const [status,job]=await call('POST',`${f.path}/short-generations`,shortBody(f,'asr-after-plan'),f.a.token);
  assert.equal(status,202,'계획→생성 사이의 재전사는 409가 아니다');
  const path=`${f.path}/short-generations/${job.id}`;
  // 맡긴 뒤 또 바뀌어도 상태 조회·임대가 된다. 일꾼은 받는 순간의 글을 받는다
  await asr('함께 떠나니 정말 좋다');
  assert.equal((await call('GET',path,null,f.a.token))[0],200);
  await only(job.id);const [,leased]=await w.claim();
  assert.deepEqual(leased.plan.cues.map(c=>c.text),['함께 떠나니 정말 좋다']);
  // 만드는 중에 바뀌어도 결과를 받는다
  await asr('함께 떠나니 아주 좋다');
  assert.equal((await call('GET',path,null,f.a.token))[1].state,'generating');
  assert.equal((await w.result(job.id))[1].state,'completed');
  assert.equal((await call('GET',path,null,f.a.token))[1].state,'completed');
  // 사람이 자막을 고치면 지금처럼 새 계획이 필요하다
  await call('PATCH',`${f.path}/captions/short-test/1`,{generation:1,expectedVersion:0,text:'사람이 고친 자막'},f.a.token);
  assert.equal((await call('GET',path,null,f.a.token))[0],409);
 }finally{shortEnvOff();}
});

test('90일 전 여행의 새 영상과 이전 48시간 기한을 가진 영상은 보존하고 철회하면 삭제합니다(T90)', async()=> {
 shortEnv();
 try {
  const f=await shortFixture();
  await tripsDb().query("UPDATE trips SET created_at=now()-interval '90 days', doc=jsonb_set(doc,'{createdAt}',to_jsonb((extract(epoch FROM now()-interval '90 days')*1000)::bigint)) WHERE code=$1",[f.trip.code]);
  const [status,job]=await call('POST',`${f.path}/short-generations`,shortBody(f,'retained-video'),f.a.token);
  assert.equal(status,202); assert.equal(job.expiresAt,null);
  await tripsDb().query("UPDATE short_generations s SET expires_at=to_timestamp((t.doc->>'createdAt')::double precision/1000)+interval '48 hours' FROM trips t WHERE s.trip_code=t.code AND s.id=$1",[job.id]);
  await migrate(); await migrate();
  const stored=(await tripsDb().query('SELECT expires_at,state FROM short_generations WHERE id=$1',[job.id])).rows[0];
  assert.equal(stored.expires_at,null); assert.equal(stored.state,'queued');
  const w=shortWorker(); await only(job.id); await w.claim(); await w.result(job.id);
  await sweep();
  const req={method:'GET',headers:{authorization:`Bearer ${f.a.token}`}};
  assert.equal((await w.service.request(req,f.trip.code,'short-generations',job.id,'file',{}))[1].toString(),'final MP4');
  await call('PATCH',`${f.path}/participants/${f.b.id}`,{consent:false});
  let row=await tickShort(w.service,job.id); assert.equal(row.state,'canceled');
  await tickShort(w.service,job.id); assert.equal(w.objects.size,0);
  await tripsDb().query("UPDATE short_generations SET updated_at=now()-interval '90 days' WHERE id=$1",[job.id]);
  await w.service.tick();
  assert.equal((await tripsDb().query('SELECT count(*)::int AS n FROM short_generations WHERE id=$1',[job.id])).rows[0].n,1);
 } finally {shortEnvOff();}
});

// 저장·경합 시험은 S3와 미디어 검사만 이중으로 주입합니다. 실제 ffprobe/파일 검증은 별도 이미지 실행으로 확인합니다.
function assetFixture(extra = {}) {
  const objects = new Map(); let puts = 0;
  const worker = shortAssets(shortServiceContext, { ready: () => true,
    probe: async (data, mimeType, seconds) => ({ mimeType, seconds, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2 }),
    media: { put: async (key, data) => { puts++; objects.set(key, data); }, get: async key => objects.get(key), remove: async key => { objects.delete(key); } }, ...extra });
  const request = (f, method, id, leaf, query = new URLSearchParams(), data = Buffer.alloc(0), token = f.a.token) => {
    const req = Readable.from([data]); req.method = method; req.headers = { authorization: `Bearer ${token}`, 'content-type': 'video/mp4' };
    return worker.request(req, f.trip.code, id, leaf, query);
  };
  const source = async f => (await request(f, 'GET', 'source', undefined, new URLSearchParams({ moment: f.plan.momentId })))[1];
  const query = (f, s, key) => new URLSearchParams({ moment: f.plan.momentId, generation: String(s.generation), sourceHash: s.sourceHash, key });
  return { worker, objects, puts: () => puts, request, source, query };
}

test('기본 쇼츠는 같은 서버 목록과 인증 파일 API로 읽고 동일 키 재전송은 한 파일만 저장합니다(T107)', async () => {
  const f = await shortFixture(), w = assetFixture(), s = await w.source(f), bytes = Buffer.from('test-only-media-bytes');
  assert.equal(s.source.scenes.length, 1); assert.equal(s.source.scenes[0].momentId, f.plan.momentId); assert.match(s.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal((await call('GET', `${f.path}/short-assets/source?moment=${f.plan.momentId}`, null, f.a.token))[1].sourceHash, s.sourceHash, '실제 HTTP 경로도 같은 원본 해시입니다');
  assert.equal((await call('GET', `${f.path}/short-assets`))[0], 401);
  const q = w.query(f, s, 'upload-key-1');
  const [created, asset] = await w.request(f, 'POST', undefined, undefined, q, bytes);
  assert.equal(created, 201); assert.equal(asset.origin, 'local-render'); assert.equal(asset.state, 'completed');
  assert.equal(asset.result.width, 1080); assert.equal(asset.result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await w.request(f, 'POST', undefined, undefined, q, bytes))[1].id, asset.id);
  assert.equal(w.puts(), 1); assert.equal(w.objects.size, 1);
  await assert.rejects(w.request(f, 'POST', undefined, undefined, q, Buffer.from('different bytes')), e => e.status === 409);
  const list = (await w.request(f, 'GET'))[1]; assert.equal(list.items[0].id, asset.id);
  assert.deepEqual((await w.request(f, 'GET', asset.id, 'file', undefined, undefined, f.b.token)).slice(1), [bytes, 'video/mp4'], '다른 프론트의 같은 여행 참가자도 원본 서버 파일을 받습니다');
  const other = await shortFixture();
  await assert.rejects(w.request(f, 'GET', asset.id, 'file', undefined, undefined, other.a.token), e => e.status === 401);
  await assert.rejects(w.request(f, 'DELETE', asset.id, undefined, undefined, undefined, f.b.token), e => e.status === 403);
  assert.equal((await w.request(f, 'DELETE', asset.id))[0], 204);
  await assert.rejects(w.request(f, 'GET', asset.id, 'file'), e => e.status === 410);
  await assert.rejects(w.request(f, 'POST', undefined, undefined, q, bytes), e => e.status === 410);
  assert.deepEqual((await w.request(f, 'GET'))[1].items, []);
});

test('기본 쇼츠는 원음·전사·동의 변경을 저장 전후 검사하고 주행 중에는 저장하지 않습니다(T107)', async () => {
  const f = await shortFixture(), w = assetFixture(), s = await w.source(f), bytes = Buffer.from('file');
  const q = w.query(f, s, 'guard-key-1');
  await call('PATCH', f.path, { status: 'driving' });
  await assert.rejects(w.request(f, 'POST', undefined, undefined, q, bytes), e => e.status === 409);
  await call('PATCH', f.path, { status: 'parked' });
  const [, asset] = await w.request(f, 'POST', undefined, undefined, q, bytes);
  await call('PATCH', `${f.path}/captions/short-test/1`, { text: '정확히 고친 자막', expectedVersion: 0, generation: 1 }, f.a.token);
  assert.notEqual((await w.source(f)).sourceHash, s.sourceHash);
  assert.equal((await w.request(f, 'GET'))[1].items[0].state, 'source_changed');
  assert.equal((await w.request(f, 'GET'))[1].items[0].result, undefined);
  await assert.rejects(w.request(f, 'GET', asset.id, 'file'), e => e.status === 409);
  await assert.rejects(w.request(f, 'POST', undefined, undefined, q, bytes), e => e.status === 409);
  const current = await w.source(f), next = w.query(f, current, 'guard-key-2');
  const revoke = assetFixture({ probe: async () => {
    await call('PATCH', `${f.path}/participants/${f.b.id}`, { consent: false });
    return { mimeType:'video/mp4',seconds:15,width:1080,height:1920,fps:30 };
  } });
  await assert.rejects(revoke.request(f, 'POST', undefined, undefined, next, bytes), e => e.status === 403);
  assert.equal(revoke.puts(), 0);
  await call('PATCH', `${f.path}/participants/${f.b.id}`, { consent: true }, f.b.token);
  assert.deepEqual((await w.request(f, 'GET'))[1].items, []);
  assert.equal((await tripsDb().query('SELECT state FROM short_assets WHERE id=$1', [asset.id])).rows[0].state, 'deleted');
});

test('S3 실패는 같은 키로 재시도하되 저장 중 철회·삭제와 느린 다운로드가 파일을 되살리지 않습니다(T107)', async () => {
  const f = await shortFixture(), objects = new Map(); let bad = true, onPut, onGet;
  const w = assetFixture({ media: {
    put: async (key, data) => { objects.set(key,data); await onPut?.(); if(bad) throw Error('S3 down'); },
    get: async key => { const data = objects.get(key); await onGet?.(); return data; }, remove: async key => { objects.delete(key); },
  } });
  const s = await w.source(f), q = w.query(f,s,'retry-upload'), bytes = Buffer.from('same-upload');
  await assert.rejects(w.request(f,'POST',undefined,undefined,q,bytes),e=>e.status===503);
  const failed = (await tripsDb().query('SELECT * FROM short_assets WHERE trip_code=$1',[f.trip.code])).rows[0];
  assert.equal(failed.state,'failed'); bad=false;
  const [,saved]=await w.request(f,'POST',undefined,undefined,q,bytes);
  assert.equal(saved.id,failed.id); assert.equal(saved.state,'completed');
  const live = (await tripsDb().query('SELECT * FROM short_assets WHERE id=$1',[saved.id])).rows[0];
  assert.notEqual(live.object_key,failed.object_key,'재시도마다 다른 객체 키를 써서 옛 정리가 새 파일을 지우지 않습니다');
  onGet=async()=>{await w.request(f,'DELETE',saved.id);};
  await assert.rejects(w.request(f,'GET',saved.id,'file'),e=>e.status===410);
  onGet=null;
  const second = await shortFixture(), s2=await w.source(second), q2=w.query(second,s2,'revoke-put');
  onPut=async()=>{await call('PATCH',`${second.path}/participants/${second.b.id}`,{consent:false});};
  await assert.rejects(w.request(second,'POST',undefined,undefined,q2,bytes),e=>e.status===403);
  const revoked=(await tripsDb().query('SELECT * FROM short_assets WHERE trip_code=$1',[second.trip.code])).rows[0];
  assert.equal(revoked.state,'deleted');
  assert.ok((await tripsDb().query('SELECT 1 FROM short_asset_trash WHERE object_key=$1',[revoked.object_key])).rowCount,'늦게 끝난 PUT도 정리 큐에 남습니다');
});

test('기본 영상과 공급자 생성은 같은 목록에서 출처와 파일 URL을 구분합니다(T107)',async()=>{
 const f=await shortFixture(),w=assetFixture(),s=await w.source(f);
 const [,local]=await w.request(f,'POST',undefined,undefined,w.query(f,s,'combined-list'),Buffer.from('local movie'));
 const id=randomUUID();
 await tripsDb().query(`INSERT INTO short_generations(id,trip_code,participant_id,generation,moment_id,idempotency_key,request_hash,plan,source_key,state,shots,result_key,bytes,expires_at)
 VALUES($1,$2,$3,1,$4,'fixture-provider','fixture-hash',$5,'fixture-key','completed','[]','fixture-result',100,NULL)`,[id,f.trip.code,f.a.id,f.plan.momentId,f.plan]);
 const list=(await w.request(f,'GET'))[1].items;
 assert.deepEqual(new Set(list.map(x=>x.origin)),new Set(['local-render','provider']));
 assert.equal(list.find(x=>x.id===local.id).result.url,`${f.path}/short-assets/${local.id}/file`);
 assert.equal(list.find(x=>x.id===id).result.url,`${f.path}/short-generations/${id}/file`);
});

test("문맥 할 일(v3, T167): 차가 남긴 내비 목적지가 앞 30초 안에 나오면 장소 없는 의무형도 그 장소의 할 일로 준다", async () => {
  const [, trip] = await call("POST", "/api/trips", {}), t = `/api/trips/${trip.code}`;
  const [, p] = await join(trip.code, "운전자", "ROW_1_LEFT");
  assert.equal((await call("POST", `${t}/places`, { kind: "start", name: "신논현역" }, p.token))[0], 201);
  assert.equal((await call("POST", `${t}/places`, { kind: "destination", name: "정자 카페거리" }, p.token))[0], 201);
  const items = [
    { seq: 1, at: trip.createdAt + 90_000, text: "정자동 카페거리 가까워요 집에서?" },
    { seq: 2, at: trip.createdAt + 93_000, text: "어 뭐 그렇죠? 근데 하나 더 생각하셔야 될될 게 제가 주차할 공간도 생각하셔야 돼요" },
  ];
  assert.equal((await call("POST", `${t}/utterances`, { device: "car", generation: 1, items }, p.token))[0], 200);
  const [, data] = await call("GET", `${t}/todos`, null, p.token);
  assert.equal(data.method, "place-rules-v3");
  assert.deepEqual(data.items.map((i) => [i.place, i.title, i.method]), [["정자카페거리", "주차할 공간 생각하기", "place-rules-v3"]]);
});

test("장소별 할 일은 실제 전사·교정본에서 묶고 완료·취소에 인증·세대·버전을 적용합니다(T103)", async () => {
  const [, trip] = await call("POST", "/api/trips", {}), t = `/api/trips/${trip.code}`;
  const [, p] = await join(trip.code, "운전자", "ROW_1_LEFT");
  const [, another] = await call("POST", "/api/trips", {});
  const [, stranger] = await join(another.code, "다른 여행", "ROW_1_LEFT");
  assert.equal((await call("GET", `${t}/todos`))[0], 401);
  assert.equal((await call("GET", `${t}/todos`, null, stranger.token))[0], 401);
  assert.deepEqual((await call("GET", `${t}/todos`, null, p.token))[1], { generation: 1, method: "place-rules-v3", items: [], arrival: null });
  const texts = ["마트에서 우유 사자", "숙소에서는 아이 가방부터 꺼내야지", "마트에서 우유 사자", "화장실 가고 싶어"];
  const items = texts.map((text, i) => ({ seq: i + 1, at: trip.createdAt + i * 1000, text }));
  assert.equal((await call("POST", `${t}/utterances`, { device: "web-source", generation: 1, items }, p.token))[0], 200);
  const list = () => call("GET", `${t}/todos`, null, p.token);
  const [, data] = await list();
  assert.equal(data.items.length, 2); assert.equal(data.items[0].sources.length, 2);
  assert.deepEqual(data.items[0].sources.map(s => [s.device, s.seq, s.text]), [["web-source", 1, texts[0]], ["web-source", 3, texts[2]]]);
  const todo = data.items[0], path = `${t}/todos/${todo.id}`;
  const body = { generation: 1, expectedVersion: 0, status: "done" };
  assert.equal((await call("PATCH", path, body))[0], 401);
  assert.equal((await call("PATCH", path, body, stranger.token))[0], 401);
  assert.equal((await call("PATCH", path, { ...body, generation: 2 }, p.token))[0], 409);
  assert.equal((await call("PATCH", path, { ...body, status: "invented" }, p.token))[0], 400);
  const raced = await Promise.all([call("PATCH", path, body, p.token), call("PATCH", path, body, p.token)]);
  assert.deepEqual(raced.map(x => x[0]).sort(), [200, 409]);
  assert.equal((await list())[1].items[0].status, "done");
  assert.equal((await call("PATCH", path, { ...body, expectedVersion: 1, status: "cancelled" }, p.token))[1].item.version, 2);
  const transcript = (await call("GET", `${t}/transcript`, null, p.token))[1];
  assert.deepEqual(transcript.todos, (await list())[1].items, "기록본과 할 일 API가 같은 항목을 반환합니다");
  assert.equal((await call("GET", t))[1].todos, undefined, "공개 여행 응답에 대화 파생 정보를 붙이지 않습니다");
  assert.equal((await call("PATCH", `${t}/captions/web-source/1`, { generation: 1, expectedVersion: 0, text: "마트에서 물 사자" }, p.token))[0], 200);
  const corrected = (await list())[1].items.find(x => x.text === "마트에서 물 사자");
  assert.ok(corrected); assert.equal(corrected.sources[0].text, texts[0]);
  assert.equal(corrected.sources[0].displayText, "마트에서 물 사자");
  assert.equal((await list())[1].items.find(x => x.id === todo.id).status, "cancelled", "남은 같은 원발화의 상태는 유지합니다");
  await call("PATCH", `${t}/participants/${p.id}`, { consent: false });
  assert.equal((await list())[0], 403);
  await call("PATCH", `${t}/participants/${p.id}`, { consent: true }, p.token);
  assert.deepEqual((await list())[1], { generation: 2, method: "place-rules-v3", items: [], arrival: null });
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM todo_states WHERE trip_code=$1", [trip.code])).rows[0].n, 0);
  assert.equal((await call("PATCH", path, body, p.token))[0], 409);
});

test("자기 글을 지우면 파생 할 일·브리핑에도 원문이나 교정본이 남지 않습니다(T103)", async () => {
  const [, profile] = await voicedProfile({ name: "작성자" });
  const [, trip] = await call("POST", "/api/trips", {}), t = `/api/trips/${trip.code}`;
  const [, p] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, profile.token);
  await call("PATCH", `${t}/participants/${p.id}`, { consent: true }, p.token);
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 1, at: Date.now(), text: "숙소에서 가방 꺼내자" }] }, p.token);
  await call("PATCH", `${t}/utterances/car/1`, { participantId: p.id }, p.token);
  const first = (await call("GET", `${t}/todos`, null, p.token))[1].items[0];
  assert.ok(first);
  assert.equal((await call("PATCH", `${t}/todos/${first.id}`, { generation: 1, expectedVersion: 0, status: "done" }, p.token))[0], 200);
  assert.equal((await call("DELETE", `${t}/utterances`, null, p.token))[1].deleted, 1);
  assert.deepEqual((await call("GET", `${t}/todos`, null, p.token))[1].items, []);
  assert.deepEqual((await call("GET", `${t}/transcript`, null, p.token))[1].todos, []);
  assert.equal((await call("PATCH", `${t}/todos/${first.id}`, { generation: 1, expectedVersion: 1, status: "pending" }, p.token))[0], 404);
});

test("도착 브리핑은 현재 여행 주차·최신 위치·장소 범위를 모두 확인합니다(T103)", async () => {
  const [, trip] = await call("POST", "/api/trips", {}), t = `/api/trips/${trip.code}`;
  const [, p] = await join(trip.code, "운전자", "ROW_1_LEFT");
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [
    { seq: 1, at: Date.now(), text: "마트에서 우유 사자" }, { seq: 2, at: Date.now() + 1, text: "숙소에서 가방 꺼내자" },
  ] }, p.token);
  const point = { lat: 37.75, lng: 128.9 };
  const input = { generation: 1, place: { name: "이마트 강릉점", ...point }, position: point, parked: true, observedAt: Date.now(), source: "browser" };
  const briefing = (body = input, token = p.token) => call("POST", `${t}/arrival-briefing`, body, token);
  assert.equal((await briefing(input, ""))[0], 401);
  assert.equal((await briefing())[1].reason, "not_parked", "여행 상태가 주차가 아니면 위치만으로 브리핑하지 않습니다");
  await call("PATCH", t, { status: "parked" });
  const result = (await briefing())[1];
  assert.equal(result.eligible, true); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].place, "마트"); assert.equal(result.distanceMeters, 0);
  assert.equal(result.method, "place-rules-v3");
  assert.deepEqual([result.items[0].category, result.items[0].items, result.items[0].requestedBy], ["buy", [{ name: "우유", qty: null }], []], "도착 브리핑 항목에도 행동 항목 칸이 있습니다(T141)");
  assert.equal(result.source, "browser");
  const arrival = async () => (await call("GET", `${t}/todos`, null, p.token))[1].arrival;
  assert.deepEqual(await arrival(), { place: "이마트 강릉점", at: input.observedAt, source: "browser" }, "도착 판정을 받은 장소 이름만 남겨 폰이 읽습니다(T119)");
  const open = (await call("GET", t))[1];
  assert.equal(open.arrival, undefined, "토큰 없이 읽는 여행 문서에는 도착 장소를 싣지 않습니다");
  await briefing();
  assert.equal((await call("GET", t))[1].version, open.version, "같은 장소의 재확인은 여행을 다시 쓰지 않습니다");
  for (const [change, reason] of [[{ parked: false }, "not_parked"], [{ observedAt: Date.now() - 61000 }, "stale_position"], [{ position: { ...point, lat: 38 } }, "outside_place"]]) {
    const r = (await briefing({ ...input, ...change }))[1];
    assert.equal(r.eligible, false); assert.equal(r.reason, reason); assert.deepEqual(r.items, []);
  }
  for (const change of [{ position: {} }, { place: { ...point } }, { source: "made-up" }, { observedAt: Date.now() + 10000 }, { parked: "yes" }]) assert.equal((await briefing({ ...input, ...change }))[0], 400);
  assert.equal((await briefing({ ...input, generation: 2 }))[0], 409);
  const todo = result.items[0];
  await call("PATCH", `${t}/todos/${todo.id}`, { generation: 1, expectedVersion: 0, status: "done" }, p.token);
  assert.deepEqual((await briefing())[1].items, [], "완료 항목과 다른 장소 항목은 도착 브리핑에서 빠집니다");
  await call("PATCH", t, { status: "driving" });
  assert.equal(await arrival(), null, "다시 출발하면 지난 도착을 지웁니다");
  await call("PATCH", t, { status: "parked" });
  await briefing({ ...input, observedAt: Date.now() });
  assert.equal((await arrival()).place, "이마트 강릉점");
  await call("PATCH", `${t}/participants/${p.id}`, { consent: false });
  await call("PATCH", `${t}/participants/${p.id}`, { consent: true }, p.token);
  assert.equal(await arrival(), null, "동의를 철회하면 도착 장소도 지웁니다");
});

test("웹 첫 전사는 실제 공급자 계약·전원 동의·세대·취소를 지키며 원음을 저장하지 않습니다(T96)", async (t) => {
  const keys = ["ASR_URL", "ASR_TOKEN", "ASR_GAP_MS", "ASR_TIMEOUT_MS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    asr.rawReply = undefined;
    asr.onCall = null;
  });
  const configure = () => Object.assign(process.env, { ASR_URL: `http://127.0.0.1:${fakeAsr.address().port}/asr/v1/`, ASR_TOKEN: "test-asr-token", ASR_GAP_MS: "20", ASR_TIMEOUT_MS: "3000" });
  const setup = async () => {
    const [, trip] = await call("POST", "/api/trips", {});
    const [, caller] = await join(trip.code, "운전자", "ROW_1_LEFT");
    const [, passenger] = await join(trip.code, "동승자", "ROW_1_RIGHT");
    return { trip, caller, passenger, path: `/api/trips/${trip.code}`, url: `/api/trips/${trip.code}/transcriptions?generation=1` };
  };
  const upload = (f, overrides = {}) => fetch(base + (overrides.url ?? f.url), {
    method: "POST", body: overrides.body ?? wav(210, 1), signal: overrides.signal,
    headers: { "content-type": "audio/wav", authorization: `Bearer ${f.caller.token}`, ...overrides.headers },
  });
  const pending = () => {
    let resolve;
    const promise = new Promise((ok) => { resolve = ok; });
    return { promise, resolve };
  };
  configure();

  await t.test("원본 WAV를 한 번 보내고 실제 전사와 메타데이터 상태를 반환하며 저장하지 않습니다", async () => {
    const f = await setup();
    const raw = wav(210, 1.25);
    const before = asr.calls.length;
    const res = await upload(f, { body: raw });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.match(result.diarization.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(result, { text: "지금 보이는 길이 예쁘다.", seconds: 1.25, generation: 1,
      providerText: "<spk:0> 지금 보이는 길이 예쁘다.", segments: null,
      diarization: { method: "provider-window", scope: "request", requestId: result.diarization.requestId, status: "unavailable", reason: "missing_timestamps" } });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(asr.calls.length, before + 1);
    const sent = asr.calls.at(-1);
    assert.equal(sent.path, "/asr/v1/chat/completions");
    assert.equal(sent.auth, "Bearer test-asr-token");
    assert.equal(sent.body.model, "nemo_transcribe30");
    assert.equal(sent.draft, undefined, "초안·가짜 대화를 공급자에게 넣지 않습니다");
    assert.deepEqual(Buffer.from(sent.body.messages[0].content[1].audio_url.url.split(",")[1], "base64"), raw);
    const [, transcript] = await call("GET", `${f.path}/transcript`, null, f.caller.token);
    assert.deepEqual(transcript.utterances, []);
    assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM recordings WHERE trip_code=$1", [f.trip.code])).rows[0].n, 0);
  });

  await t.test("실제 형식의 익명 구간은 요청별로 보존하고 잘못된 시각은 원문과 오류로 반환합니다(T110)", async () => {
    const f = await setup();
    const raw = "<spk:0> 00:00.00 먼저 출발해요. 00:01.20 <spk:1> 00:01.00 같이 가요. 00:02.50";
    asr.rawReply = { content: raw };
    try {
      const first = await (await upload(f, { body: wav(210, 3) })).json();
      const second = await (await upload(f, { body: wav(210, 3) })).json();
      assert.equal(first.text, "먼저 출발해요. 같이 가요.");
      assert.equal(first.providerText, raw);
      assert.deepEqual(first.segments, [{ start: 0, end: 1.2, text: "먼저 출발해요.", speakerLabel: "spk:0" }, { start: 1, end: 2.5, text: "같이 가요.", speakerLabel: "spk:1" }]);
      assert.equal(first.diarization.status, "available");
      assert.notEqual(first.diarization.requestId, second.diarization.requestId, "창 사이에 같은 화자 번호를 동일인으로 묶지 않습니다");
      asr.rawReply = { content: "<spk:0> 00:00.00 끝이 넘친 문장도 보존합니다. 00:03.01" };
      const invalid = await (await upload(f, { body: wav(210, 3) })).json();
      assert.equal(invalid.text, "끝이 넘친 문장도 보존합니다.");
      assert.equal(invalid.providerText, asr.rawReply.content);
      assert.equal(invalid.segments, null);
      assert.equal(invalid.diarization.status, "invalid");
      assert.equal(invalid.diarization.reason, "out_of_bounds");
    } finally { asr.rawReply = undefined; }
  });

  await t.test("미설정·무권한·미동의·옛 세대·잘못된 WAV는 공급자를 부르지 않습니다", async () => {
    const f = await setup();
    const outsider = await setup();
    const before = asr.calls.length;
    delete process.env.ASR_TOKEN;
    assert.equal((await upload(f)).status, 503);
    configure();
    assert.equal((await upload(f, { headers: { authorization: "" } })).status, 401);
    assert.equal((await upload(f, { headers: { authorization: `Bearer ${outsider.caller.token}` } })).status, 401);
    assert.equal((await upload(f, { url: `${f.path}/transcriptions?generation=2` })).status, 409);
    assert.equal((await upload(f, { url: `${f.path}/transcriptions` })).status, 400);
    assert.equal((await upload(f, { headers: { "content-type": "application/json" } })).status, 400);
    const stereo = wav(210, 1); stereo.writeUInt16LE(2, 22);
    const rate = wav(210, 1); rate.writeUInt32LE(48000, 24);
    const truncated = wav(210, 1).subarray(0, 20000);
    for (const body of [Buffer.from("not audio"), wav(210, 0.49), wav(210, 10.01), stereo, rate, truncated])
      assert.equal((await upload(f, { body })).status, 400);
    assert.equal((await upload(f, { body: Buffer.alloc(400_001) })).status, 413);
    const silence = wav(210, 1); silence.fill(0, 44);
    const empty = await upload(f, { body: silence });
    assert.equal(empty.status, 422);
    assert.equal((await empty.json()).type, "invalid");
    await call("PATCH", `${f.path}/participants/${f.passenger.id}`, { consent: false });
    assert.equal((await upload(f)).status, 403, "호출자가 동의해도 동승자 철회 시 보내지 않습니다");
    assert.equal(asr.calls.length, before);
  });

  await t.test("빈 답·잘못된 답·공급자 오류는 자막을 지어내거나 재시도하지 않습니다", async () => {
    const f = await setup();
    for (const [reply, expected] of [
      [{ content: "<spk:0>  " }, 422], [{ content: {} }, 503], [{ content: "말".repeat(501) }, 503],
      [{ content: "잘려서 끝나지 않은 문장", finish_reason: "length" }, 503],
      [{ status: 500 }, 503], [{ status: 429 }, 429],
    ]) {
      asr.rawReply = reply;
      const before = asr.calls.length;
      const res = await upload(f);
      assert.equal(res.status, expected);
      assert.equal("text" in await res.json(), false);
      assert.equal(asr.calls.length, before + 1, "429도 자동으로 다시 보내지 않습니다");
    }
    asr.rawReply = undefined;
  });

  await t.test("느린 업로드 도중 철회·재동의하면 세대가 달라진 원음을 보내지 않습니다", async () => {
    const f = await setup();
    const before = asr.calls.length;
    const slow = await slowPost(f.url, wav(210, 1), f.caller.token, { "content-type": "audio/wav" });
    await call("PATCH", `${f.path}/participants/${f.passenger.id}`, { consent: false });
    await call("PATCH", `${f.path}/participants/${f.passenger.id}`, { consent: true }, f.passenger.token);
    slow.release();
    assert.equal((await slow.done).status, 409);
    assert.equal(asr.calls.length, before);
  });

  await t.test("공급자 대기열에서도 동의를 다시 확인합니다", async () => {
    const first = await setup();
    const queued = await setup();
    const entered = pending();
    const release = pending();
    process.env.ASR_GAP_MS = "350";
    asr.onCall = async () => { entered.resolve(); await release.promise; };
    const a = upload(first);
    await entered.promise;
    const before = asr.calls.length;
    const b = upload(queued);
    await new Promise((ok) => setTimeout(ok, 50));
    await call("PATCH", `${queued.path}/participants/${queued.passenger.id}`, { consent: false });
    release.resolve();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 403);
    assert.equal(asr.calls.length, before, "대기 도중 철회한 음성은 보내지 않습니다");
    configure();
  });

  await t.test("외부 호출 중 동의 변경을 막지 않고 철회·재동의 뒤 늦은 결과를 버립니다", async () => {
    const f = await setup();
    asr.onCall = async () => {
      const started = performance.now();
      assert.equal((await call("PATCH", `${f.path}/participants/${f.passenger.id}`, { consent: false }))[0], 200);
      assert.ok(performance.now() - started < 1000, "공급자 응답 전에 동의 철회가 완료되어야 합니다");
      await call("PATCH", `${f.path}/participants/${f.passenger.id}`, { consent: true }, f.passenger.token);
    };
    const res = await upload(f);
    assert.equal(res.status, 409);
    assert.equal("text" in await res.json(), false);
    const [, profile] = await voicedProfile({ name: "검증 참가자" });
    const [, caller] = await call("POST", `${f.path}/participants`, { seat: "ROW_2_LEFT", consent: true }, profile.token);
    asr.onCall = async () => { assert.equal((await call("DELETE", "/api/profiles/me", null, profile.token))[0], 204); };
    assert.equal((await upload({ ...f, caller }, { url: `${f.path}/transcriptions?generation=2` })).status, 401);
  });

  await t.test("제한 시간과 클라이언트 취소는 공급자 연결을 끊고 재시도하지 않습니다", async () => {
    const f = await setup();
    // 앞 대기열 예약을 비운 뒤 짧은 공급자 제한 시간을 시험합니다.
    await new Promise((ok) => setTimeout(ok, 400));
    process.env.ASR_TIMEOUT_MS = "150";
    const timedOut = pending();
    asr.onCall = async (_req, res) => { await new Promise((ok) => res.once("close", ok)); timedOut.resolve(); };
    let before = asr.calls.length;
    const res = await upload(f);
    assert.equal(res.status, 504);
    await timedOut.promise;
    assert.equal(asr.calls.length, before + 1);
    configure();
    const entered = pending();
    const disconnected = pending();
    asr.onCall = async (_req, res) => { entered.resolve(); await new Promise((ok) => res.once("close", ok)); disconnected.resolve(); };
    const controller = new AbortController();
    before = asr.calls.length;
    const response = upload(f, { signal: controller.signal });
    const rejected = assert.rejects(response, { name: "AbortError" });
    await entered.promise;
    controller.abort();
    await rejected;
    await disconnected.promise;
    assert.equal(asr.calls.length, before + 1);
  });
});

test("선택적인 실제 구간·익명 화자는 저장·수정·숏폼에 남고 동의 철회 때 지워집니다(T110)", async () => {
  const [, profile] = await voicedProfile({ name: "구간 검증" });
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, person] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT", consent: true }, profile.token);
  const at = trip.createdAt;
  const scope = randomUUID(), another = randomUUID();
  const items = [
    { seq: 1, at: at + 1000, endAt: at + 2500, text: "같이 출발해요.", speakerLabel: "spk:0", speakerScope: scope },
    { seq: 2, at: at + 1800, endAt: at + 3200, text: "네, 함께 가요.", speakerLabel: "spk:1", speakerScope: scope },
    { seq: 3, at: at + 4000, endAt: at + 5000, text: "새 음성 창입니다.", speakerLabel: "spk:0", speakerScope: another },
    { seq: 4, at: at + 6000, text: "기존 차량 발화입니다." },
  ];
  assert.equal((await call("POST", `${t}/utterances`, { device: "web", generation: 1, items }, person.token))[0], 200);
  const read = () => call("GET", `${t}/transcript`, null, person.token).then((r) => r[1].utterances);
  const lines = await read();
  assert.deepEqual(lines.map((u) => [u.endAt, u.speakerLabel, u.speakerScope]), items.map((u) => [u.endAt, u.speakerLabel, u.speakerScope]));
  assert.ok(lines.every((u) => !u.participantId && !u.profileId), "익명 라벨로 참가자 신원을 만들지 않습니다");
  const batch = (await call("GET", `${t}/utterances`, null, person.token))[1].items;
  assert.equal(batch[0].endAt, items[0].endAt);
  assert.equal(batch[0].speakerScope, scope);
  assert.equal("endAt" in batch[3], false, "기존 Android 입력은 새 필드 없이 유지됩니다");
  for (const invalid of [
    { endAt: at }, { endAt: at + 10_001 }, { endAt: at + 1.5 },
    { speakerLabel: "spk:0" }, { speakerScope: scope }, { speakerLabel: "실명", speakerScope: scope }, { speakerLabel: "spk:0", speakerScope: "전체 여행" },
  ]) assert.equal((await call("POST", `${t}/utterances`, { device: "web", generation: 1, items: [{ seq: 5, at, text: "잘못된 구간", ...invalid }] }, person.token))[0], 400);
  assert.equal((await read()).length, 4);
  await call("POST", `${t}/utterances`, { device: "web", generation: 1, items: [{ ...items[0], endAt: at + 3500, speakerScope: another }] }, person.token);
  assert.equal((await read())[0].endAt, items[0].endAt, "동일 기기·순번 재전송은 처음 저장한 구간을 유지합니다");
  const [manualStatus, manual] = await call("PATCH", `${t}/utterances/web/1`, { participantId: person.id }, person.token);
  assert.equal(manualStatus, 200);
  assert.equal(manual.speakerScope, scope);
  const [captionStatus, caption] = await call("PATCH", `${t}/captions/web/1`, { text: "같이 출발할까요?", expectedVersion: 0, generation: 1 }, person.token);
  assert.equal(captionStatus, 200);
  assert.equal(caption.utterance.endAt, items[0].endAt);
  assert.equal(caption.utterance.speakerLabel, "spk:0");
  const feed = (await call("GET", "/api/profiles/me/feed", null, profile.token))[1].items.find((u) => u.tripCode === trip.code);
  assert.equal(feed.endAt, items[0].endAt);
  assert.equal(feed.speakerScope, scope);
  const candidates = (await call("GET", `${t}/scene-suggestions`, null, person.token))[1].items;
  assert.equal(candidates[0].lines[0].speakerScope, scope);
  const [, moment] = await call("POST", `${t}/moments`, { at: at + 1000, from: at, to: at + 15000 }, person.token);
  assert.equal((await postRaw(`${t}/recordings?moment=${moment.id}&generation=1&from=${at}`, wav(210, 10), person.token)).status, 201);
  const form = (await call("GET", `${t}/shortform`, null, person.token))[1];
  const scene = form.scenes.find((s) => s.momentId === moment.id);
  assert.deepEqual(scene.cues.slice(0, 2).map((u) => [u.start, u.end]), [[1, 2.5], [1.8, 3.2]], "실제 끝 시각과 겹침을 임의로 자르지 않습니다");
  assert.equal(scene.cues[0].speakerScope, scope);
  assert.equal(scene.cues[2].speakerScope, another);
  assert.equal(scene.cues[1].participantId, null);
  await call("DELETE", `${t}/utterances`, null, person.token);
  const tombstone = (await tripsDb().query("SELECT text,end_at,speaker_label,speaker_scope FROM utterances WHERE trip_code=$1 AND seq=1", [trip.code])).rows[0];
  assert.deepEqual(tombstone, { text: "", end_at: null, speaker_label: null, speaker_scope: null });
  await call("PATCH", `${t}/participants/${person.id}`, { consent: false });
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM utterances WHERE trip_code=$1", [trip.code])).rows[0].n, 0);
});

test("장면 재전사는 실제 발화 구간을 우선하고 클립에 남은 짧은 말은 원문으로 둡니다(T110)", async () => {
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const at = Date.now() - 60_000;
  await tripsDb().query("UPDATE trips SET doc=jsonb_set(doc,'{createdAt}',to_jsonb($2::bigint)) WHERE code=$1", [trip.code, at - 1000]);
  const [, person] = await join(trip.code, "검증 화자", "ROW_1_LEFT");
  const scope = randomUUID();
  const makeLine = (seq, start, end, text) => ({ seq, at: at + start, endAt: at + end, text, speakerLabel: `spk:${seq % 2}`, speakerScope: scope });
  const items = [
    makeLine(1, -400, 1000, "클립 앞에서 시작한 말"),
    makeLine(2, 2000, 3200, "실제 끝이 있는 말"),
    makeLine(3, 2100, 3700, "겹쳐서 이어지는 말"),
    makeLine(4, 4000, 4500, "짧은 실제 말"),
    { seq: 5, at: at + 5000, text: "기존 차량 발화", seatArea: "ROW_1_LEFT" },
    makeLine(6, 6000, 9000, "클립 뒤로 이어지는 말"),
    makeLine(7, 7500, 9000, "클립에서 짧게 남은 말"),
  ];
  assert.equal((await call("POST", `${t}/utterances`, { device: "segments", generation: 1, items }, person.token))[0], 200);
  await call("PATCH", `${t}/captions/segments/2`, { text: "직접 다듬은 자막", expectedVersion: 0, generation: 1 }, person.token);
  const [, moment] = await call("POST", `${t}/moments`, { at, from: at, to: at + 8000 }, person.token);
  const source = wav(213, 8);
  const before = asr.calls.length;
  const events = [];
  const restore = captureLog((line) => events.push(JSON.parse(line)));
  const done = async (n) => {
    for (let i = 0; i < 300 && events.filter((e) => e.msg === "clip_retranscribed").length < n; i++) await new Promise((ok) => setTimeout(ok, 20));
    return events.filter((e) => e.msg === "clip_retranscribed")[n - 1];
  };
  Object.assign(process.env, { ASR_URL: `http://127.0.0.1:${fakeAsr.address().port}/asr/v1`, ASR_TOKEN: "test-asr-token", ASR_GAP_MS: "20" });
  try {
    assert.equal((await postRaw(`${t}/recordings?moment=${moment.id}&generation=1&from=${at}`, source, person.token)).status, 201);
    const first = await done(1);
    assert.deepEqual([first.lines, first.fixed, first.fellBack, first.reasons], [7, 5, 2, { short: 2 }]);
    const sent = asr.calls.slice(before);
    assert.deepEqual(sent.map((c) => c.draft), [items[0].text, items[1].text, items[2].text, items[4].text, items[5].text]);
    const bounds = [[0, 1000], [2000, 3200], [2100, 3700], [4500, 8000], [6000, 8000]];
    for (let i = 0; i < sent.length; i++) {
      const audio = Buffer.from(sent[i].body.messages[0].content[1].audio_url.url.split(",")[1], "base64");
      assert.deepEqual(audio.subarray(44), source.subarray(44 + bounds[i][0] * 32, 44 + bounds[i][1] * 32), "실제로 보낸 표본의 시작과 끝이 해당 구간과 같아야 합니다");
    }
    const lines = (await call("GET", `${t}/transcript`, null, person.token))[1].utterances;
    assert.deepEqual(lines.map((u) => u.text), items.map((u) => u.text), "원문은 덮지 않습니다");
    assert.equal(lines[1].displayText, "직접 다듬은 자막");
    assert.equal(lines[1].asrText, items[1].text + ".");
    assert.equal(lines[1].endAt, items[1].endAt);
    assert.equal(lines[3].asrText, undefined);
    assert.equal(lines[6].asrText, undefined);
    // 클립 전에 시작했지만 0.8초가 겹치는 발화가 뒤늦게 도착해도 재예약합니다.
    const late = makeLine(8, -200, 800, "늦게 받은 겹치는 말");
    assert.equal((await call("POST", `${t}/utterances`, { device: "segments", generation: 1, items: [late] }, person.token))[0], 200);
    const second = await done(2);
    assert.deepEqual([second.lines, second.fixed], [1, 1]);
    assert.equal(asr.calls.length, before + 6, "이미 본 짧은 말과 오류를 다시 보내지 않습니다");
    const last = Buffer.from(asr.calls.at(-1).body.messages[0].content[1].audio_url.url.split(",")[1], "base64");
    assert.deepEqual(last.subarray(44), source.subarray(44, 44 + 800 * 32));
  } finally {
    restore();
    delete process.env.ASR_URL;
    delete process.env.ASR_TOKEN;
    delete process.env.ASR_GAP_MS;
  }
});

test("화자 값 모델·실행기(T170): /models·/vendor/ort는 assets 폴더에서 흘려 보내고 오래 캐시한다", async () => {
  const assets = fileURLToPath(new URL("./assets/", import.meta.url));
  const fresh = !(await stat(assets).catch(() => null)); // 받아 둔 진짜 파일이 있으면 시험 파일만 지운다
  const file = joinPath(assets, "vendor", "ort", "t170-test.wasm");
  await mkdir(joinPath(assets, "vendor", "ort"), { recursive: true });
  await writeFile(file, Buffer.from([0, 0x61, 0x73, 0x6d]));
  try {
    const r = await fetch(`${base}/vendor/ort/t170-test.wasm`);
    assert.deepEqual([r.status, r.headers.get("content-type"), r.headers.get("cache-control"), r.headers.get("content-length")], [200, "application/wasm", "public, max-age=31536000, immutable", "4"]);
    assert.deepEqual([...Buffer.from(await r.arrayBuffer())], [0, 0x61, 0x73, 0x6d]);
    assert.equal((await fetch(`${base}/vendor/ort/t170-test.wasm`, { headers: { "if-none-match": r.headers.get("etag") } })).status, 304);
    assert.equal((await fetch(`${base}/models/없는파일.onnx`)).status, 404);
    assert.equal((await fetch(`${base}/vendor/ort/`)).status, 404, "폴더는 주지 않음");
    assert.ok([400, 404].includes((await fetch(`${base}/vendor/ort/..%2F..%2Fserver.js`)).status), "assets 밖은 주지 않음");
    assert.equal((await fetch(`${base}/vendor/ort/t170-test.wasm`, { method: "POST" })).status, 405);
  } finally {
    await rm(fresh ? assets : file, { recursive: true, force: true });
  }
});
