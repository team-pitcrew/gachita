import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { migrate, server } from "./server.js";
import { endStores, tripsDb } from "./db.js";
import { captureLog } from "./log.js";

let base, adminUrl, names;
captureLog(() => {});
before(async () => {
  adminUrl = process.env.DATABASE_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  names = [`${admin.database}_ride_trips`, `${admin.database}_ride_profiles`];
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
  const data = res.status === 204 ? undefined : await res.json();
  return { status: res.status, data, headers: res.headers };
}
const profile = async (name) => (await call("POST", "/profiles", { name, character: "bunny", consentDefault: true })).data;
const trip = async () => (await call("POST", "/trips", { title: "동승 연결 시험" })).data;
const issue = async (person) => (await call("POST", "/ride-links", {}, person.token)).data;
const redeem = (t, link, seat = "ROW_1_RIGHT") => call("POST", `/trips/${t.code}/ride-links`, { code: link.code, seat });

test("폰에만 토큰을 주고 차의 1회 연결 뒤 폰이 자기 동의를 켠다", async () => {
  const phone = await profile("폰 참가자");
  const stranger = await profile("다른 폰");
  const t = await trip();
  assert.equal((await call("POST", "/ride-links", {})).status, 401);
  const issued = await call("POST", "/ride-links", {}, phone.token);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const link = issued.data;
  assert.deepEqual(JSON.parse(link.qr), { type: "gachita-ride", version: 1, code: link.code });
  assert.ok(!link.qr.includes(phone.token) && !link.qr.includes(link.participantToken));
  const pending = await call("GET", `/ride-links/${link.id}`, undefined, phone.token);
  assert.equal(pending.data.status, "pending");
  assert.equal((await call("GET", `/ride-links/${link.id}`, undefined, stranger.token)).status, 404);
  const joined = await redeem(t, link);
  assert.equal(joined.status, 201);
  assert.equal(joined.data.participant.consent, false);
  assert.equal(joined.data.participant.profileId, phone.id);
  assert.equal(joined.headers.get("cache-control"), "no-store");
  for (const response of [joined, await call("GET", `/trips/${t.code}`)]) {
    const text = JSON.stringify(response.data);
    for (const secret of [link.participantToken, link.code, "tokenHash"]) assert.ok(!text.includes(secret));
  }
  await endStores(); // 프로세스 메모리에 기대지 않고 재연결 뒤에도 결과를 읽는다.
  const linked = await call("GET", `/ride-links/${link.id}`, undefined, phone.token);
  assert.equal(linked.status, 200);
  assert.equal(linked.data.status, "linked");
  assert.equal(linked.data.tripCode, t.code);
  assert.equal(linked.data.participant.id, joined.data.participant.id);
  assert.ok(!JSON.stringify(linked.data).includes(link.participantToken));
  const consentPath = `/trips/${t.code}/participants/${joined.data.participant.id}`;
  assert.equal((await call("PATCH", consentPath, { consent: true })).status, 401);
  assert.equal((await call("PATCH", consentPath, { consent: true }, link.participantToken)).status, 200);
  assert.equal((await redeem(t, link)).status, 409);
  assert.equal((await call("DELETE", `/ride-links/${link.id}`, undefined, phone.token)).status, 409);
  const stored = (await tripsDb().query("SELECT * FROM ride_links WHERE id=$1", [link.id])).rows[0];
  const serialized = JSON.stringify(stored);
  assert.ok(!serialized.includes(link.participantToken) && !serialized.includes(link.code));
});

test("취소·만료·삭제한 프로필과 주행·종료 여행은 연결하지 않고 자리 충돌은 다시 고를 수 있다", async () => {
  const phone = await profile("만료 시험");
  const t = await trip();
  const cancelled = await issue(phone);
  assert.equal((await call("DELETE", `/ride-links/${cancelled.id}`, undefined, phone.token)).status, 204);
  assert.equal((await redeem(t, cancelled)).status, 404);
  const expired = await issue(phone);
  await tripsDb().query("UPDATE ride_links SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  assert.equal((await redeem(t, expired)).status, 404);
  assert.equal((await call("GET", `/ride-links/${expired.id}`, undefined, phone.token)).status, 404);
  const link = await issue(phone);
  for (const status of ["driving", "ended"]) {
    await call("PATCH", `/trips/${t.code}`, { status });
    assert.equal((await redeem(t, link)).status, 409);
  }
  await call("PATCH", `/trips/${t.code}`, { status: "parked" });
  await call("POST", `/trips/${t.code}/participants`, { name: "이미 탄 손님", seat: "ROW_1_RIGHT", consent: false });
  assert.equal((await redeem(t, link)).status, 409);
  assert.equal((await call("GET", `/ride-links/${link.id}`, undefined, phone.token)).data.status, "pending");
  assert.equal((await redeem(t, link, "ROW_2_RIGHT")).status, 201);
  const duplicate = await issue(phone);
  assert.equal((await redeem(t, duplicate, "ROW_2_LEFT")).status, 409);
  const deleted = await profile("지운 프로필");
  const deletedLink = await issue(deleted);
  await call("DELETE", "/profiles/me", undefined, deleted.token);
  assert.equal((await redeem(t, deletedLink, "ROW_2_LEFT")).status, 404);
});

test("같은 QR을 두 여행에서 동시에 읽어도 한 참가자만 생긴다", async () => {
  const phone = await profile("한 번만 연결");
  const link = await issue(phone);
  const [a, b] = await Promise.all([trip(), trip()]);
  const results = await Promise.all([redeem(a, link), redeem(b, link)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const trips = await Promise.all([call("GET", `/trips/${a.code}`), call("GET", `/trips/${b.code}`)]);
  assert.equal(trips.reduce((count, r) => count + r.data.participants.filter((p) => p.profileId === phone.id).length, 0), 1);
});

test("여행 잠금을 기다리는 사이 48시간이 지나면 참가자 추가와 QR 사용을 되돌린다", async () => {
  const phone = await profile("만료 경계");
  const link = await issue(phone);
  const t = await trip();
  const holder = await tripsDb().connect();
  let pending;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM trips WHERE code=$1 FOR UPDATE", [t.code]);
    pending = redeem(t, link);
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const { rows } = await tripsDb().query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT doc FROM trips WHERE code=%'");
      if (rows.length) { waiting = true; break; }
      await sleep(20);
    }
    assert.ok(waiting, "상환이 여행 잠금을 기다리는 상태를 먼저 확인");
    await holder.query("UPDATE trips SET created_at=clock_timestamp()-interval '48 hours'+interval '100 milliseconds' WHERE code=$1", [t.code]);
    await sleep(150);
    await holder.query("COMMIT");
    assert.equal((await pending).status, 404);
    const { rows } = await tripsDb().query("SELECT doc FROM trips WHERE code=$1", [t.code]);
    assert.equal(rows[0].doc.participants.length, 0);
    assert.equal((await call("GET", `/ride-links/${link.id}`, undefined, phone.token)).data.status, "pending");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    await pending;
  }
});
