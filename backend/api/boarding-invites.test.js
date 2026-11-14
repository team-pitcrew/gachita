import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { migrate, server } from "./server.js";
import { endStores, profilesDb, tripsDb } from "./db.js";
import { captureLog } from "./log.js";

let base, adminUrl, names;
captureLog(() => {});
before(async () => {
  adminUrl = process.env.DATABASE_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  names = [`${admin.database}_boarding_trips`, `${admin.database}_boarding_profiles`];
  for (const name of names) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  }
  await admin.end();
  process.env.TRIPS_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[0]}`);
  process.env.PROFILES_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[1]}`);
  await migrate();
  await migrate();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((ok) => server.close(ok));
  await endStores();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});
async function call(method, path, body, token) {
  const res = await fetch(`${base}/api${path}`, { method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: res.status === 204 ? undefined : await res.json(), headers: res.headers };
}
const profile = async (name) => (await call("POST", "/profiles", { name, character: "bunny", consentDefault: true })).data;
const setup = async () => {
  const trip = (await call("POST", "/trips", { title: "차량 QR 초대" })).data;
  const driver = (await call("POST", `/trips/${trip.code}/participants`, { name: "운전자", seat: "ROW_1_LEFT", consent: true })).data;
  const prefix = `/trips/${trip.code}/boarding-invites`;
  const issued = await call("POST", prefix, {}, driver.token);
  assert.equal(issued.status, 201);
  const invite = issued.data;
  const code = new URL(invite.url, base).searchParams.get("join");
  return { trip, driver, invite, code, prefix, path: `/boarding-invites/${code}` };
};
const join = (f, person, seat = "ROW_1_RIGHT") => call("POST", `${f.path}/participants`, { seat }, person.token);

test("차의 QR을 여러 폰이 읽어 각자 참가하며 초기 동의와 인증 토큰을 분리합니다", async () => {
  const f = await setup();
  const a = await profile("첫 동승자"), b = await profile("둘째 동승자");
  assert.match(f.code, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(f.invite.expiresAt > Date.now() + 290_000 && f.invite.expiresAt <= Date.now() + 300_000);
  assert.deepEqual(Object.keys(f.invite).sort(), ["expiresAt", "id", "url"]);
  assert.ok(!f.invite.url.includes(f.driver.token));
  const preview = await call("GET", f.path);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  assert.deepEqual(preview.data, { title: f.trip.title, seats: ["ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_CENTER", "ROW_2_RIGHT"], expiresAt: f.invite.expiresAt });
  const joined = await join(f, a);
  assert.equal(joined.status, 201);
  assert.equal(joined.data.tripCode, f.trip.code);
  assert.equal(joined.data.participant.profileId, a.id);
  assert.equal(joined.data.participant.consent, false, "프로필의 기본 동의가 true여도 가입은 false입니다");
  assert.equal(joined.data.participant.character, a.character);
  assert.match(joined.data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await join(f, b, "ROW_2_LEFT")).status, 201, "한 QR로 여러 동승자가 참여합니다");
  const after = await call("GET", f.path);
  assert.deepEqual(after.data.seats, ["ROW_2_CENTER", "ROW_2_RIGHT"]);
  const consentPath = `/trips/${f.trip.code}/participants/${joined.data.participant.id}`;
  assert.equal((await call("PATCH", consentPath, { consent: true }, f.driver.token)).status, 403);
  assert.equal((await call("PATCH", consentPath, { consent: true }, joined.data.token)).status, 200);
  const stored = JSON.stringify((await tripsDb().query("SELECT * FROM boarding_invites WHERE id=$1", [f.invite.id])).rows[0]);
  assert.ok(!stored.includes(f.code) && !stored.includes(joined.data.token));
  const publicTrip = JSON.stringify((await call("GET", `/trips/${f.trip.code}`)).data);
  for (const secret of [f.code, f.driver.token, joined.data.token, "tokenHash"]) assert.ok(!publicTrip.includes(secret));
  await endStores();
  const again = await join(f, a, "ROW_2_RIGHT");
  assert.equal(again.status, 200);
  assert.equal(again.data.participant.id, joined.data.participant.id);
  assert.equal(again.data.participant.seat, "ROW_1_RIGHT", "재시도는 기존 자리를 이동하지 않습니다");
  assert.equal(again.data.participant.consent, true, "가입 뒤 본인이 켠 동의는 재시도가 바꾸지 않습니다");
  assert.equal((await call("PATCH", consentPath, { consent: true }, again.data.token)).status, 200);
  assert.equal((await call("GET", `/trips/${f.trip.code}`)).data.participants.length, 3);
});

test("운전석만 발급하고 발급자만 닫으며 인증 없는 가입·대리 동의는 거절합니다", async () => {
  const f = await setup(), phone = await profile("권한 시험");
  const other = (await call("POST", `/trips/${f.trip.code}/participants`, { name: "동승자", seat: "ROW_2_LEFT", consent: false })).data;
  assert.equal((await call("POST", f.prefix, {})).status, 401);
  assert.equal((await call("POST", f.prefix, {}, phone.token)).status, 401);
  assert.equal((await call("POST", f.prefix, {}, other.token)).status, 403);
  assert.equal((await call("DELETE", `${f.prefix}/${f.invite.id}`, undefined, other.token)).status, 403);
  assert.equal((await call("POST", `${f.path}/participants`, { seat: "ROW_1_RIGHT" })).status, 401);
  assert.equal((await call("POST", `${f.path}/participants`, { seat: "ROW_1_RIGHT" }, f.driver.token)).status, 401);
  assert.equal((await call("POST", `${f.path}/participants`, { seat: "ROW_1_RIGHT", consent: true }, phone.token)).status, 400);
  assert.equal((await join(f, phone, "imaginary")).status, 400);
  const foreign = await setup();
  assert.equal((await call("DELETE", `${foreign.prefix}/${f.invite.id}`, undefined, foreign.driver.token)).status, 404);
  assert.equal((await call("DELETE", `${f.prefix}/${f.invite.id}`, undefined, f.driver.token)).status, 204);
  assert.equal((await call("DELETE", `${f.prefix}/${f.invite.id}`, undefined, f.driver.token)).status, 204);
  assert.equal((await call("GET", f.path)).status, 410);
  assert.equal((await join(f, phone)).status, 410);
});

test("새 QR·만료·주행·종료·발급자 자리 변경은 낡은 초대로 가입하지 못하게 합니다", async () => {
  const f = await setup(), phone = await profile("만료 시험");
  const renewed = await call("POST", f.prefix, {}, f.driver.token);
  assert.equal(renewed.status, 201);
  assert.notEqual(renewed.data.url, f.invite.url);
  assert.equal((await call("GET", f.path)).status, 410);
  const next = { ...f, path: `/boarding-invites/${new URL(renewed.data.url, base).searchParams.get("join")}` };
  for (const status of ["driving", "ended"]) {
    await call("PATCH", `/trips/${f.trip.code}`, { status });
    assert.equal((await call("GET", next.path)).status, 409);
    assert.equal((await join(next, phone)).status, 409);
    assert.equal((await call("POST", f.prefix, {}, f.driver.token)).status, 409);
  }
  await call("PATCH", `/trips/${f.trip.code}`, { status: "parked" });
  assert.equal((await call("GET", next.path)).status, 200);
  await tripsDb().query("UPDATE boarding_invites SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1", [renewed.data.id]);
  assert.equal((await call("GET", next.path)).status, 410);
  assert.equal((await join(next, phone)).status, 410);
  const g = await setup();
  await call("PATCH", `/trips/${g.trip.code}/participants/${g.driver.id}`, { seat: "ROW_2_LEFT" });
  assert.equal((await call("GET", g.path)).status, 410);
  assert.equal((await join(g, phone)).status, 410);
  await call("DELETE", "/profiles/me", undefined, phone.token);
  assert.equal((await join(f, phone)).status, 401);
});

test("동시에 같은 자리를 선택하면 한 명만 가입하고 같은 프로필 재시도는 한 참가자로 남습니다", async () => {
  const f = await setup(), a = await profile("좌석 A"), b = await profile("좌석 B");
  const joined = await Promise.all([join(f, a), join(f, b)]);
  assert.deepEqual(joined.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await call("GET", `/trips/${f.trip.code}`)).data.participants.length, 2);
  const c = await profile("재시도 시험");
  const repeats = await Promise.all(Array.from({ length: 3 }, () => join(f, c, "ROW_2_LEFT")));
  assert.deepEqual(repeats.map((r) => r.status).sort(), [200, 200, 201]);
  assert.equal(new Set(repeats.map((r) => r.data.participant.id)).size, 1);
  assert.equal((await call("GET", `/trips/${f.trip.code}`)).data.participants.length, 3);
});

test("프로필 잠금에서 기다리는 가입도 QR 폐기 후 참가자를 남기지 않습니다", async () => {
  const f = await setup(), phone = await profile("느린 가입");
  const lock = await profilesDb().connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM profiles WHERE id=$1 FOR UPDATE", [phone.id]);
    const joining = join(f, phone);
    let waiting = false;
    for (let i = 0; i < 50; i++) {
      waiting = (await profilesDb().query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM profiles WHERE id=% FOR SHARE'")).rowCount > 0;
      if (waiting) break;
      await sleep(10);
    }
    assert.ok(waiting, "가입이 프로필 행 잠금에서 기다린 뒤 초대를 폐기합니다");
    assert.equal((await call("DELETE", `${f.prefix}/${f.invite.id}`, undefined, f.driver.token)).status, 204);
    await lock.query("COMMIT");
    assert.equal((await joining).status, 410);
    assert.equal((await call("GET", `/trips/${f.trip.code}`)).data.participants.length, 1);
  } finally { await lock.query("ROLLBACK").catch(() => {}); lock.release(); }
});
