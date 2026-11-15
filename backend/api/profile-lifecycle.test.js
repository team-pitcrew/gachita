import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { migrate, server } from "./server.js";
import { endStores, profilesDb, tripsDb } from "./db.js";
import { captureLog } from "./log.js";
import { withVoice } from "./voice-fixture.js";

let base, adminUrl, names;
captureLog(() => {});
before(async () => {
  adminUrl = process.env.DATABASE_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  names = [`${admin.database}_lifecycle_trips_${process.pid}`, `${admin.database}_lifecycle_profiles_${process.pid}`];
  for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.TRIPS_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[0]}`);
  process.env.PROFILES_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[1]}`);
  await migrate();
  await migrate();
  await new Promise(ok => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(ok => server.close(ok));
  await endStores();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

async function call(method, path, body, token) {
  const response = await fetch(`${base}/api${path}`, { method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}
const person = async () => { const p = (await call("POST", "/profiles", { name: "삭제 경쟁", consentDefault: true })).data; await withVoice(base, p.token); return p; }; // 목소리까지(T173)
const trip = async () => (await call("POST", "/trips", { title: "시간 제한 없는 여행" })).data;
const join = (t, p) => call("POST", `/trips/${t.code}/participants`, { seat: "ROW_1_RIGHT" }, p.token);
const remove = p => call("DELETE", "/profiles/me", undefined, p.token);
const doc = async t => (await tripsDb().query("SELECT doc FROM trips WHERE code=$1", [t.code])).rows[0].doc;
async function until(predicate) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail("경쟁 요청이 예상한 대기 지점에 도착하지 않았습니다");
}
async function blocked(queryPrefix) {
  const { rows } = await tripsDb().query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`${queryPrefix}%`]);
  return rows[0].n;
}
async function holdTrip(t) {
  const db = await tripsDb().connect();
  await db.query("BEGIN");
  await db.query("SELECT code FROM trips WHERE code=$1 FOR UPDATE", [t.code]);
  return async () => { await db.query("COMMIT"); db.release(); };
}

test("여행 행에서 기다리던 일반 참가도 삭제가 끝나면 토큰·참가자가 남지 않습니다", async () => {
  const p = await person(), t = await trip();
  const release = await holdTrip(t);
  let joining, deleting;
  try {
    joining = join(t, p);
    await until(() => blocked("SELECT doc, created_at FROM trips WHERE code"));
    let deleted = false;
    deleting = remove(p).then(result => { deleted = true; return result; });
    await until(async () => deleted || await blocked("SELECT pg_advisory_lock"));
  } finally { await release(); }
  const [joined, removed] = await Promise.all([joining, deleting]);
  assert.equal(joined.status, 201);
  assert.equal(removed.status, 204);
  assert.deepEqual((await doc(t)).participants, []);
  assert.equal((await doc(t)).generation, 2);
  assert.equal((await call("GET", `/trips/${t.code}/transcript`, undefined, joined.data.token)).status, 401);
});

test("삭제 중 뒤따른 일반 참가와 QR 상환은 다른 여행에도 참가자를 만들지 않습니다", async () => {
  const p = await person(), existing = await trip(), target = await trip();
  assert.equal((await join(existing, p)).status, 201);
  const link = (await call("POST", "/ride-links", {}, p.token)).data;
  const release = await holdTrip(existing);
  let deleting, joining, redeeming;
  try {
    deleting = remove(p);
    await until(async () => (await tripsDb().query("SELECT 1 FROM profile_deletions WHERE profile_id=$1", [p.id])).rowCount);
    joining = join(target, p);
    redeeming = call("POST", `/trips/${target.code}/ride-links`, { code: link.code, seat: "ROW_2_RIGHT" });
    await until(async () => await blocked("SELECT pg_advisory_lock") >= 2);
  } finally { await release(); }
  const [removed, joined, redeemed] = await Promise.all([deleting, joining, redeeming]);
  assert.equal(removed.status, 204);
  assert.equal(joined.status, 404);
  assert.equal(redeemed.status, 404);
  assert.deepEqual((await doc(existing)).participants, []);
  assert.deepEqual((await doc(target)).participants, []);
  assert.equal((await tripsDb().query("SELECT 1 FROM ride_links WHERE profile_id=$1", [p.id])).rowCount, 0);
  assert.equal((await tripsDb().query("SELECT 1 FROM profile_deletions WHERE profile_id=$1", [p.id])).rowCount, 1);
});

test("여행 철회 뒤 프로필 DB 삭제가 실패하면 생존 계정은 표식을 회수하고 다시 참가합니다", async () => {
  const p = await person(), t = await trip();
  assert.equal((await join(t, p)).status, 201);
  await profilesDb().query(`CREATE FUNCTION reject_profile_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected delete failure'; END $$`);
  await profilesDb().query("CREATE TRIGGER reject_profile_delete BEFORE DELETE ON profiles FOR EACH ROW EXECUTE FUNCTION reject_profile_delete()");
  try {
    assert.equal((await remove(p)).status, 500);
    assert.equal((await profilesDb().query("SELECT 1 FROM profiles WHERE id=$1", [p.id])).rowCount, 1);
    assert.equal((await tripsDb().query("SELECT 1 FROM profile_deletions WHERE profile_id=$1", [p.id])).rowCount, 1);
    assert.deepEqual((await doc(t)).participants, []);
    assert.equal((await doc(t)).generation, 2);
    assert.equal((await join(t, p)).status, 201);
    assert.equal((await tripsDb().query("SELECT 1 FROM profile_deletions WHERE profile_id=$1", [p.id])).rowCount, 0);
    assert.equal((await doc(t)).generation, 2);
  } finally {
    await profilesDb().query("DROP TRIGGER reject_profile_delete ON profiles");
    await profilesDb().query("DROP FUNCTION reject_profile_delete()");
  }
  assert.equal((await remove(p)).status, 204);
  assert.deepEqual((await doc(t)).participants, []);
});

for (const finish of ["COMMIT", "ROLLBACK"]) test(`여행 DB 삭제 잠금이 먼저 사라져도 프로필 ${finish} 전에 표식을 회수하지 않습니다`, async () => {
  const p = await person(), t = await trip();
  const deleting = await profilesDb().connect();
  let joining;
  try {
    await deleting.query("BEGIN");
    await deleting.query("DELETE FROM profiles WHERE id=$1", [p.id]);
    // 여행 DB 연결이 먼저 끊겼지만 프로필 DB에는 아직 DELETE가 진행 중인 상태입니다.
    await tripsDb().query("INSERT INTO profile_deletions (profile_id) VALUES ($1)", [p.id]);
    joining = join(t, p);
    await until(async () => (await profilesDb().query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM profiles WHERE id=$1 FOR SHARE%'")).rowCount);
    assert.equal((await tripsDb().query("SELECT 1 FROM profile_deletions WHERE profile_id=$1", [p.id])).rowCount, 1);
    assert.deepEqual((await doc(t)).participants, []);
    await deleting.query(finish);
  } finally {
    await deleting.query("ROLLBACK");
    deleting.release();
  }
  assert.equal((await joining).status, finish === "COMMIT" ? 404 : 201);
  assert.equal((await doc(t)).participants.length, finish === "COMMIT" ? 0 : 1);
  assert.equal((await tripsDb().query("SELECT 1 FROM profile_deletions WHERE profile_id=$1", [p.id])).rowCount, finish === "COMMIT" ? 1 : 0);
});
