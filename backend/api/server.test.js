// 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, server } from "./server.js";
import { endStores, profilesDb, tripsDb } from "./db.js";

let base;
let fakeProvider; // 가짜 구글(T21). code가 곧 사용자 번호다. bad로 시작하면 거절.
before(async () => {
  fakeProvider = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/token" && req.method === "POST") {
      const raw = await new Promise((ok) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => ok(body));
      });
      const code = new URLSearchParams(raw).get("code") ?? "";
      if (!code || code.startsWith("bad")) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: `at-${code}` });
    }
    if (url.pathname === "/userinfo" && req.method === "GET") {
      const at = /^Bearer at-(.+)$/.exec(req.headers.authorization ?? "");
      return at ? send(200, { sub: at[1], name: `구글-${at[1]}` }) : send(401, { error: "unauthorized" });
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

  // 저장은 Postgres에 한다: 서버가 돌려준 것과 표의 문서가 같다
  const stored = (await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
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
