import assert from "node:assert/strict";
import { before, after, test } from "node:test";
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
  names = [`${admin.database}_shares_trips`, `${admin.database}_shares_profiles`];
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
async function fixture() {
  const people = [];
  for (const name of ["보낸 사람", "받는 사람", "다른 사람"]) people.push((await call("POST", "/profiles", { name, character: "bunny" })).data);
  const trip = (await call("POST", "/trips", { title: "결과 공유 시험" })).data;
  const path = `/trips/${trip.code}`;
  const riders = [];
  for (let i = 0; i < 2; i++) {
    const p = (await call("POST", `${path}/participants`, { seat: i ? "ROW_1_RIGHT" : "ROW_1_LEFT" }, people[i].token)).data;
    riders.push(p);
    assert.equal((await call("PATCH", `${path}/participants/${p.id}`, { consent: true }, p.token)).status, 200);
  }
  const moment = (await call("POST", `${path}/moments`, { label: "선택한 바다", lat: 37.1, lng: 129.2 }, riders[0].token)).data;
  const body = { momentId: moment.id, recipientIds: [riders[1].id], caption: " 직접 확인한 문구 ", includeLocation: false, generation: trip.generation };
  const share = (overrides = {}, token = riders[0].token) => call("POST", `${path}/shares`, { ...body, ...overrides }, token);
  const list = (i) => call("GET", "/profiles/me/shares", null, people[i].token);
  return { trip, path, people, riders, moment, body, share, list };
}

test("선택한 장면과 확인한 문구만 지정한 동승자에게 보이고 보낸 사람만 회수한다", async () => {
  const f = await fixture();
  assert.equal((await call("POST", `${f.path}/shares`, f.body)).status, 401);
  const created = await f.share();
  assert.equal(created.status, 201);
  assert.equal(created.data.caption, "직접 확인한 문구");
  assert.equal(created.data.label, "선택한 바다");
  assert.ok(!("lat" in created.data));
  assert.equal(created.data.expiresAt, null);
  const sent = await f.list(0), received = await f.list(1);
  assert.equal(sent.data.items[0].direction, "sent");
  assert.equal(received.data.items[0].direction, "received");
  assert.equal(received.headers.get("cache-control"), "no-store");
  assert.deepEqual(sent.data.items[0].recipients, [{ name: "받는 사람", character: "bunny" }]);
  assert.equal(received.data.items[0].sender.name, "보낸 사람");
  assert.ok(!("recipients" in received.data.items[0]));
  const json = JSON.stringify(received.data);
  for (const value of [f.trip.code, ...f.people.map((p) => p.token), ...f.riders.map((p) => p.token)]) assert.ok(!json.includes(value));
  assert.equal((await f.list(2)).data.items.length, 0);
  assert.equal((await call("GET", "/profiles/me/shares")).status, 401);
  assert.equal((await call("GET", "/profiles/me/shares", null, f.riders[1].token)).status, 401);
  const target = `/profiles/me/shares/${created.data.id}`;
  assert.equal((await call("DELETE", target, null, f.people[1].token)).status, 404);
  assert.equal((await call("DELETE", target, null, f.people[2].token)).status, 404);
  assert.equal((await call("DELETE", target, null, f.people[0].token)).status, 204);
  assert.equal((await f.list(1)).data.items.length, 0);
  assert.equal((await call("DELETE", target, null, f.people[0].token)).status, 404);
  const located = await f.share({ includeLocation: true });
  assert.equal(located.data.lat, 37.1);
  assert.equal((await f.list(1)).data.items[0].lng, 129.2);
});

test("본인 앨범과 동의한 같은 여행 참가자만 선택하고 오래된 세대·잘못된 입력은 거절한다", async () => {
  const f = await fixture();
  assert.equal((await f.share({}, f.people[0].token)).status, 401);
  assert.equal((await f.share({ recipientIds: [f.riders[0].id] })).status, 403);
  assert.equal((await f.share({ recipientIds: [f.people[2].id] })).status, 403);
  assert.equal((await f.share({ recipientIds: [] })).status, 400);
  assert.equal((await f.share({ recipientIds: [f.riders[1].id, f.riders[1].id] })).status, 400);
  assert.equal((await f.share({ momentId: "does-not-exist" })).status, 404);
  for (const odd of ["abc\u0000", "\ud800", "", "a b", "가".repeat(3)]) assert.equal((await f.share({ momentId: odd })).status, 400, "DB에 닿기 전에 400");
  assert.equal((await f.share({ recipientIds: [f.riders[0].id] }, f.riders[1].token)).status, 404, "다른 사람의 앨범 장면을 공유하지 못함");
  for (const caption of [null, "x".repeat(501), "\0", "\uD800"]) assert.equal((await f.share({ caption })).status, 400);
  assert.equal((await f.share({ includeLocation: "false" })).status, 400);
  assert.equal((await f.share({ generation: 0 })).status, 409);
  const plain = (await call("POST", `${f.path}/moments`, { label: "위치 없는 장면" }, f.riders[0].token)).data;
  assert.equal((await f.share({ momentId: plain.id, includeLocation: true })).status, 400);
  assert.equal((await f.share({ momentId: plain.id, caption: "" })).status, 201);
  await call("PATCH", `${f.path}/participants/${f.riders[1].id}`, { consent: false });
  assert.equal((await f.share()).status, 409);
  assert.equal((await f.list(1)).data.items.length, 0);
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM result_shares WHERE trip_code = $1", [f.trip.code])).rows[0].n, 0, "동의 철회는 저장된 문구도 지움");
  const current = (await call("GET", f.path)).data;
  assert.equal((await f.share({ generation: current.generation })).status, 403);
});

test("원본 앨범·프로필 삭제는 공유를 없애지만 시간 경과는 보존하고 여행 삭제 시 함께 지워진다", async () => {
  const previous = await fixture();
  assert.equal((await previous.share()).status, 201);
  await tripsDb().query("UPDATE trips SET doc = jsonb_set(doc, '{generation}', to_jsonb((doc->>'generation')::int + 1)) WHERE code = $1", [previous.trip.code]);
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM result_shares WHERE trip_code = $1", [previous.trip.code])).rows[0].n, 0, "공유를 모르는 구 이미지가 세대만 올려도 공유 문구 삭제");
  const source = await fixture();
  assert.equal((await source.share()).status, 201);
  assert.equal((await call("DELETE", `/profiles/me/moments/${source.moment.id}`, null, source.people[0].token)).status, 204);
  assert.equal((await source.list(1)).data.items.length, 0);
  const erased = await fixture();
  assert.equal((await erased.share()).status, 201);
  assert.equal((await call("DELETE", "/profiles/me", null, erased.people[0].token)).status, 204);
  assert.equal((await erased.list(1)).data.items.length, 0);
  const expired = await fixture();
  assert.equal((await expired.share()).status, 201);
  await tripsDb().query("UPDATE trips SET created_at = now() - interval '49 hours' WHERE code = $1", [expired.trip.code]);
  assert.equal((await expired.list(1)).data.items.length, 1);
  assert.equal((await expired.share()).status, 201);
  await tripsDb().query("DELETE FROM trips WHERE code = $1", [expired.trip.code]);
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM result_shares WHERE trip_code = $1", [expired.trip.code])).rows[0].n, 0);
});

test("옛 그룹의 관리 대상 프로필은 수신·회수할 자기 프로필 토큰이 없어 공유 대상에서 제외한다", async () => {
  const f = await fixture();
  await profilesDb().query("UPDATE profiles SET managed_by = $1 WHERE id = $2", [f.people[0].id, f.people[1].id]);
  assert.equal((await f.share()).status, 403);
  await profilesDb().query("UPDATE profiles SET managed_by = NULL WHERE id = $1", [f.people[1].id]);
  await profilesDb().query("UPDATE profiles SET managed_by = $1 WHERE id = $2", [f.people[2].id, f.people[0].id]);
  assert.equal((await f.share()).status, 403);
});


test("이전 48시간 공유 기한을 무기한으로 바꿔도 내용·동의·명시 회수는 보존합니다(T90)", async () => {
  const f=await fixture(); const shared=await f.share();
  await tripsDb().query("UPDATE trips SET created_at=now()-interval '90 days' WHERE code=$1",[f.trip.code]);
  await tripsDb().query("UPDATE result_shares s SET expires_at=t.created_at+interval '48 hours' FROM trips t WHERE s.trip_code=t.code AND s.id=$1",[shared.data.id]);
  await migrate(); await migrate();
  const items=(await f.list(1)).data.items;
  assert.equal(items.length,1); assert.equal(items[0].expiresAt,null); assert.equal(items[0].caption,shared.data.caption);
  assert.equal((await call("DELETE", `/profiles/me/shares/${shared.data.id}`,null,f.people[0].token)).status,204);
  assert.equal((await f.list(1)).data.items.length,0);
});
