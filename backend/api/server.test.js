// 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, rotateGoogleToken, server } from "./server.js";
import { endStores, profilesDb, tripsDb } from "./db.js";

let base;
let fakeProvider; // 가짜 구글(T21). code가 곧 사용자 번호다. 특수 code로 장애 상황도 낸다.
before(async () => {
  fakeProvider = createServer(async (req, res) => {
    const send = (status, body, raw) => {
      res.writeHead(status, { "content-type": raw ? "text/plain" : "application/json" });
      res.end(raw ?? JSON.stringify(body));
    };
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/token" && req.method === "POST") {
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
  await tripsDb().query("DROP TABLE IF EXISTS profiles");
  await tripsDb().query("TRUNCATE trips");
  await profilesDb().query("TRUNCATE profiles");
  await new Promise((ok) => server.listen(0, () => ok((base = `http://localhost:${server.address().port}`))));
});
after(async () => {
  server.close();
  fakeProvider.close();
  await endStores();
});

const call = async (method, path, body, token) => {
  const res = await fetch(base + path, { method, body: body && JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });
  return [res.status, res.status === 304 || res.status === 204 ? null : await res.json()];
};
const join = (code, name, seat, consent = true, prefs) =>
  call("POST", `/api/trips/${code}/participants`, { name, seat, consent, prefs });

test("여행 하나의 흐름: 참가, 자리, 동의와 기록, 부탁, 장면", async () => {
  const [created, trip] = await call("POST", "/api/trips", { title: "양양" });
  assert.equal(created, 201);
  assert.match(trip.code, /^[A-Z2-9]{6}$/);
  const t = `/api/trips/${trip.code}`;

  // 참가와 자리
  const [, driver] = await join(trip.code, "민준", "ROW_1_LEFT", true, { tempC: 22 });
  assert.deepEqual(driver.prefs, { tempC: 22, heat: 0, vent: 0 });
  assert.equal((await join(trip.code, "지우", "ROW_1_LEFT"))[0], 409, "같은 자리에는 한 사람만");
  const [, rider] = await join(trip.code, "지우", "ROW_1_RIGHT", false, { tempC: 23, heat: 1 });
  assert.equal((await join(trip.code, "", "ROW_2_LEFT"))[0], 400, "이름이 비면 거절");
  assert.equal((await join(trip.code, "하늘", "TRUNK"))[0], 400, "없는 자리는 거절");
  assert.equal((await join(trip.code, "하늘", "ROW_2_LEFT", true, { heat: 9 }))[0], 400, "범위 밖 선호는 거절");

  // 한 명이라도 동의하지 않으면 주행을 시작해도 기록하지 않는다
  assert.equal((await call("PATCH", t, { status: "driving" }))[1].recording, false);
  assert.equal((await call("PATCH", t, { recording: true }))[0], 409);
  await call("PATCH", `${t}/participants/${rider.id}`, { consent: true });
  assert.equal((await call("PATCH", t, { recording: true }))[1].recording, true);

  // 자리를 옮기면 선호는 그대로 따라간다
  const [, moved] = await call("PATCH", `${t}/participants/${rider.id}`, { seat: "ROW_2_LEFT" });
  assert.deepEqual([moved.seat, moved.prefs.heat], ["ROW_2_LEFT", 1]);

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

test("프로필: 발급, 토큰으로 본인 확인, 프로필로 참가하면 자리별 선호를 가져온다", async () => {
  const [created, me] = await call("POST", "/api/profiles", { name: "지우", prefs: { passenger: { tempC: 23, heat: 1 }, rear: { tempC: 21, vent: 2 } }, consentDefault: true });
  assert.equal(created, 201);
  assert.match(me.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(me.prefs.driver, { tempC: 22, heat: 0, vent: 0 }, "안 적은 자리는 기본값");

  // 서버에는 토큰이 아니라 해시만 남는다
  const { rows } = await profilesDb().query("SELECT token_hash FROM profiles WHERE id = $1", [me.id]);
  assert.equal(rows[0].token_hash.length, 32);
  assert.ok(!rows[0].token_hash.toString("latin1").includes(me.token));

  assert.equal((await call("GET", "/api/profiles/me"))[0], 401, "토큰이 없으면 거절");
  assert.equal((await call("GET", "/api/profiles/me", null, "x".repeat(43)))[0], 401, "모르는 토큰은 거절");
  const [, seen] = await call("GET", "/api/profiles/me", null, me.token);
  assert.deepEqual([seen.name, seen.token], ["지우", undefined], "토큰은 발급할 때만 준다");

  // 프로필로 참가: 이름·선호·동의를 프로필에서 가져온다
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [joined, p] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT" }, me.token);
  assert.deepEqual([joined, p.name, p.prefs, p.consent], [201, "지우", { tempC: 23, heat: 1, vent: 0 }, true]);
  const [again, same] = await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT" }, me.token);
  assert.deepEqual([again, same.id, same.seat], [200, p.id, "ROW_1_RIGHT"], "같은 프로필이 다시 참가하면 있던 참가자를 돌려준다");
  assert.equal((await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT" }, "y".repeat(43)))[0], 401);

  // 자리를 옮기면 그 자리의 선호를 프로필에서 다시 불러온다
  const [, moved] = await call("PATCH", `${t}/participants/${p.id}`, { seat: "ROW_2_CENTER" });
  assert.deepEqual(moved.prefs, { tempC: 21, heat: 0, vent: 2 });

  // 저장은 Postgres에 한다: 서버가 돌려준 것과 표의 문서가 같다.
  // 참가자 토큰 해시는 문서 안에만 있는다(응답에는 절대 안 나간다).
  const stored = (await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
  for (const p of stored.participants) delete p.tokenHash;
  assert.deepEqual(stored, (await call("GET", t))[1]);

  // 고치기와 지우기
  const [, patched] = await call("PATCH", "/api/profiles/me", { prefs: { passenger: { heat: 3 } } }, me.token);
  assert.deepEqual(patched.prefs.passenger, { tempC: 23, heat: 3, vent: 0 }, "적은 값만 바뀐다");
  assert.equal((await call("PATCH", "/api/profiles/me", { prefs: { rear: { vent: 7 } } }, me.token))[0], 400);
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
  assert.match(await page.text(), /같이타/);
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
  assert.equal((await link({ code: "code-1", redirectUri: "x" }, other.token))[0], 409);

  // 토큰 없이 같은 계정으로 찾아 들어가면 같은 프로필과 새 토큰을 준다. 이전 기기의 토큰은 못 쓴다.
  const [status, again] = await link({ code: "code-1", redirectUri: "x" });
  assert.equal(status, 200);
  assert.equal(again.id, after.id);
  assert.match(again.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call("GET", "/api/profiles/me", null, me.token))[0], 401, "이전 기기의 토큰은 못 쓴다");

  // 그 토큰으로 여행에 참가한다(티켓의 완료 기준).
  const [, trip] = await call("POST", "/api/trips", {});
  const [joined, p] = await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_1_LEFT" }, again.token);
  assert.deepEqual([joined, p.name], [201, "민준"]);

  // 처음 보는 계정이면 프로필을 새로 만든다. 이름은 제공자가 준 값을 쓴다.
  const [created, fresh] = await link({ code: "code-2", redirectUri: "x" });
  assert.deepEqual([created, fresh.name, fresh.links], [201, "구글-code-2", ["google"]]);

  // 연결을 끊는다. 끊은 뒤 다시 끊으면 404.
  assert.equal((await call("DELETE", "/api/profiles/me/links/google", null, again.token))[0], 204);
  const [, cut] = await call("GET", "/api/profiles/me", null, again.token);
  assert.deepEqual(cut.links, []);
  assert.equal((await call("DELETE", "/api/profiles/me/links/google", null, again.token))[0], 404);

  // 제공자가 거절한 코드는 401.
  assert.equal((await link({ code: "bad-1", redirectUri: "x" }))[0], 401);
});

test("제공자 오류를 코드 거절과 장애으로 나눠 알린다(T21)", async () => {
  const link = (code) => call("POST", "/api/profiles/me/links/google", { code, redirectUri: "x" });
  assert.deepEqual(await link("bad-grant").then(([, b]) => b.error), "제공자가 코드를 거절함");
  assert.equal((await link("down"))[0], 503, "제공자 503은 일시 장애");
  assert.equal((await link("overloaded"))[0], 503, "제공자 429도 일시 장애");
  assert.equal((await link("bad-client"))[0], 500, "클라이언트 설정 오류는 사용자 잘못이 아님");
  assert.equal((await link("bad-json"))[0], 502, "읽을 수 없는 응답");
  assert.equal((await link("no-token"))[0], 502, "접근 토큰이 없는 응답");
  assert.equal((await link("no-info"))[0], 502, "사용자 정보 조회 실패");
  assert.equal((await link("no-sub"))[0], 502, "사용자 번호가 없는 응답");
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
  const [, after] = await call("POST", "/api/profiles/me/links/google", { code: "code-9", redirectUri: "x" }, me.token);
  // 찾아 들어가기 요청이 연결 조회를 마친 뒤, 소유자가 다른 구글 계정으로 갈아끼운 상황(결정적 재현).
  const beforeHash = (await profilesDb().query("SELECT token_hash FROM profiles WHERE id = $1", [after.id])).rows[0].token_hash;
  await profilesDb().query("UPDATE profiles SET provider_user_id = 'code-B' WHERE id = $1", [after.id]);
  const stale = await rotateGoogleToken(after.id, createHash("sha256").update("stale").digest(), "code-9");
  assert.equal(stale, null, "연결이 바뀌었으면 갱신은 0행");
  const keptHash = (await profilesDb().query("SELECT token_hash FROM profiles WHERE id = $1", [after.id])).rows[0].token_hash;
  assert.ok(keptHash.equals(beforeHash), "현재 소유자의 토큰 해시는 그대로");
  const fresh = await rotateGoogleToken(after.id, createHash("sha256").update("fresh").digest(), "code-B");
  assert.ok(fresh?.id, "지금 연결된 계정으로는 갱신됨");
  // 바뀐 뒤 오래된 계정이 다시 로그인하면 새 프로필이 만들어진다(그 계정의 연결은 없으므로).
  const [s, again] = await call("POST", "/api/profiles/me/links/google", { code: "code-9", redirectUri: "x" });
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
  const [, r2] = await call("POST", `${t}/utterances`, { device: "phone", items: [{ seq: 5, at: at(5), text: "콜라 사줘", seatArea: "ROW_2_RIGHT", generation: 1 }] }, pg.token);
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

  // 다시 참가하면 참가자 토큰이 돌아가고 옛 토큰은 못 쓴다
  const [again, same] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT" }, meA.token);
  assert.deepEqual([again, same.id], [200, pa.id]);
  assert.notEqual(same.token, pa.token);
  assert.equal((await call("GET", `${t}/utterances`, null, pa.token))[0], 401, "옛 참가자 토큰은 못 씀");
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
  await call("PATCH", `${t}/participants/${pb.id}`, { consent: true });
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

test("쓰기가 몰려도 서버가 멈추지 않는다", async () => {
  // 자리 옮기기는 여행 줄을 잠근 연결을 쥔 채 프로필 저장소를 읽는다.
  // 같은 여행에 쓰기 15개가 동시에 닥쳐도 모두 응답해야 한다(리뷰 재현).
  const [, me] = await call("POST", "/api/profiles", { name: "지우", consentDefault: true });
  const [, trip] = await call("POST", "/api/trips", {});
  const t = `/api/trips/${trip.code}`;
  const [, p] = await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT" }, me.token);
  const others = [];
  for (const [name, seat] of [["민준", "ROW_2_LEFT"], ["하늘", "ROW_2_CENTER"], ["강토", "ROW_2_RIGHT"]]) {
    const [, o] = await join(trip.code, name, seat, true);
    others.push(o.id);
  }
  for (let round = 0; round < 5; round++) {
    const writes = [call("PATCH", `${t}/participants/${p.id}`, { seat: round % 2 ? "ROW_1_LEFT" : "ROW_1_RIGHT" })];
    for (let i = 0; i < 14; i++) writes.push(call("PATCH", `${t}/participants/${others[i % others.length]}`, { consent: true }));
    const done = await Promise.all(writes);
    assert.equal(done.filter(([s]) => s === 200).length, writes.length, `${round + 1}회차`);
  }
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
