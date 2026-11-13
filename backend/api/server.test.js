// 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { classify, migrate, server, verifyGoogleLink } from "./server.js";
import { captureLog } from "./log.js";
import { endStores, profilesDb, tripsDb } from "./db.js";

let base;
let fakeProvider; // 가짜 구글(T21). code가 곧 사용자 번호다. 특수 code로 장애 상황도 낸다.
captureLog(() => {}); // 서버의 구조화 로그는 시험 출력에 섞지 않는다(T71 시험은 따로 받아 본다)
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
  await tripsDb().query("DROP TABLE IF EXISTS voice_prints, profiles"); // make run(한 DB)이면 목소리 값이 프로필을 가리킨다(외래 키째 다시 만들어짐)
  await tripsDb().query("TRUNCATE trips");
  await profilesDb().query("TRUNCATE profiles CASCADE"); // 목소리 값(voice_prints)은 외래 키로 함께
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

  // 서버에는 토큰이 아니라 해시만 남는다(기기 토큰 표, T45)
  const { rows } = await profilesDb().query("SELECT t.token_hash FROM tokens t JOIN profiles p ON p.id = t.profile_id WHERE p.id = $1", [me.id]);
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
  assert.equal((await link({ code: "code-1", redirectUri: "x" }, other.token))[0], 409);

  // 토큰 없이 같은 계정으로 찾아 들어가면 같은 프로필과 이 기기 토큰을 준다.
  // 기기마다 토큰이 따로이므로 앞선 기기의 토큰도 그대로 쓸 수 있다(T45, ADR-0009).
  const [status, again] = await link({ code: "code-1", redirectUri: "x" });
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
  // 찾아 들어가기 요청이 연결 확인을 마친 뒤, 소유자가 다른 구글 계정으로 갈아끼운 상황(결정적 재현).
  await profilesDb().query("UPDATE profiles SET provider_user_id = 'code-B' WHERE id = $1", [after.id]);
  assert.equal(await verifyGoogleLink(after.id, "code-9"), null, "연결이 바뀌었으면 확인은 0행");
  assert.ok((await verifyGoogleLink(after.id, "code-B"))?.id, "지금 연결된 계정으로는 확인됨");
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
  assert.equal((await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_RIGHT", profileId: kid.profileId }, mom.token))[0], 409, "같은 아이를 두 자리에 앉히지 못함");
  assert.equal((await call("POST", `/api/trips/${trip.code}/participants`, { seat: "ROW_2_RIGHT", profileId: "x" }, mom.token))[0], 400);
  await call("PATCH", `/api/trips/${trip.code}/participants/${kp.id}`, { consent: true });
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
  await profilesDb().query("INSERT INTO profiles (id, token_hash, name, prefs, consent_default) VALUES ($1, $2, '옛 판', '{}', false)", [
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

test("목소리 등록으로 발화의 화자를 프로필에 붙인다(T38)", async () => {
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
  const [, pd] = await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT", consent: true }, dad.token);
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 1, at: trip.createdAt + 1000, text: "바다 보인다", seatArea: "ROW_1_LEFT" }] }, pm.token);

  // 대조: 엄마 자리의 발화 음성은 엄마로, 아빠 소리는 '모름'
  const m1 = await postRaw(`${t}/voice-match?seatArea=ROW_1_LEFT&device=car&seq=1`, wav(210, 1.5), pm.token);
  assert.equal(m1.status, 200);
  const r1 = await m1.json();
  assert.deepEqual([r1.profileId, r1.applied], [mom.id, true], "엄마 목소리는 엄마 프로필로");
  const m2 = await postRaw(`${t}/voice-match?seatArea=ROW_1_LEFT&device=car&seq=1`, wav(340, 1.5), pm.token);
  const r2 = await m2.json();
  assert.deepEqual([r2.profileId, r2.applied], [null, false], "다른 목소리는 모름");
  assert.ok(r1.confidence > r2.confidence, "같은 목소리의 확신이 더 높다");
  assert.ok(r1.confidence >= r1.threshold, "같은 목소리는 기준을 넘는다");

  // 발화 줄에 화자가 붙는다(기록본·피드에 나온다)
  const [, tr] = await call("GET", `${t}/transcript`, null, pm.token);
  assert.equal(tr.utterances[0].profileId, mom.id);
  const [, feed] = await call("GET", "/api/profiles/me/feed", null, mom.token);
  assert.equal(feed.items.filter((i) => i.kind === "utterance").length, 1, "화자가 붙은 발화는 피드에 나옴");

  // 등록을 지우면 그 자리는 후보가 없어 모름
  assert.equal((await call("DELETE", "/api/profiles/me/voice", null, dad.token))[0], 204);
  const m3 = await postRaw(`${t}/voice-match?seatArea=ROW_1_RIGHT`, wav(340, 1.5), pd.token);
  const r3 = await m3.json();
  assert.deepEqual([r3.profileId, r3.confidence], [null, 0], "등록이 없으면 모름");
  assert.equal((await postRaw(`${t}/voice-match?seatArea=ROW_1_LEFT`, wav(210, 1.5))).status, 401, "참가자 토큰이 필요함");
  assert.equal((await fetch(`${base}${t}/voice-match?seatArea=TRUNK`, { method: "POST", headers: { authorization: `Bearer ${pm.token}` }, body: wav(210, 1) })).status, 400, "없는 좌석은 거절");

  // 화자는 그 발화를 올린 기기(참가자)만, 아직 화자가 없는 줄에만 붙인다
  await call("POST", `${t}/utterances`, { device: "car", generation: 1, items: [{ seq: 2, at: trip.createdAt + 2000, text: "응" }] }, pm.token);
  const notMine = await (await postRaw(`${t}/voice-match?device=car&seq=2`, wav(210, 1.5), pd.token)).json();
  assert.deepEqual([notMine.profileId, notMine.applied], [mom.id, false], "남이 올린 줄에는 붙이지 못함");
  const relabel = await (await postRaw(`${t}/voice-match?device=car&seq=1`, wav(210, 1.5), pm.token)).json();
  assert.equal(relabel.applied, false, "이미 화자가 있는 줄은 바꾸지 않음");
  assert.equal((await postRaw(`${t}/voice-match`, wav(210, 11), pm.token)).status, 400, "대조 음성은 10초까지");
  const [, guest] = await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT", name: "손님", consent: false });
  assert.equal((await postRaw(`${t}/voice-match`, wav(210, 1.5), guest.token)).status, 403, "동의하지 않은 참가자는 대조 못 함");
  await call("PATCH", `${t}/participants/${guest.id}`, { consent: true });

  // 좌석 구역을 모르면 이 여행의 프로필 참가자 모두가 후보다
  const m4 = await (await postRaw(`${t}/voice-match`, wav(210, 1.5), pd.token)).json();
  assert.equal(m4.profileId, mom.id, "구역 없이도 엄마를 찾음");

  // 대조는 여행 줄을 잠그지 않는다: 같은 여행에 대조가 몰려도, 그사이 동의를 바꿔도 모두 응답한다(리뷰 재현)
  const jobs = Array.from({ length: 15 }, () => postRaw(`${t}/voice-match?seatArea=ROW_1_LEFT&device=car&seq=1`, wav(210, 1.5), pm.token));
  const [consent] = await call("PATCH", `${t}/participants/${pd.id}`, { consent: true });
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
