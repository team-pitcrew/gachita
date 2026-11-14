// 여행 장소 기록과 내 여행·콘텐츠 목록(T131). 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
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
  names = [`${admin.database}_places_trips_${process.pid}`, `${admin.database}_places_profiles_${process.pid}`];
  for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.TRIPS_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[0]}`);
  process.env.PROFILES_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[1]}`);
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
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: res.status === 204 || res.status === 304 ? null : await res.json() };
}
const profile = async (name, character) => {
  const made = await call("POST", "/profiles", { name, ...(character ? { character } : {}) });
  assert.equal(made.status, 201);
  return made.data;
};
const newTrip = async (title = "바다 여행") => (await call("POST", "/trips", { title })).data;
// 프로필(토큰 있음)은 이름을 프로필에서, 손님은 이름을 본문으로
const join = async (code, who, seat, consent = true) =>
  (await call("POST", `/trips/${code}/participants`, who.token ? { seat, consent } : { name: who.name, seat, consent }, who.token)).data;

test("차가 장소를 남기면 여행 문서의 places에 쌓이고, 참가자 토큰이 있어야 하며 200개까지", async () => {
  const trip = await newTrip();
  assert.deepEqual(trip.places, [], "새 여행은 빈 목록");
  const driver = await join(trip.code, { name: "운전자" }, "ROW_1_LEFT");
  const path = `/trips/${trip.code}/places`;
  const made = await call("POST", path, { kind: "destination", name: " 속초 해수욕장 ", lat: 38.19, lng: 128.6, etaSeconds: 7200 }, driver.token);
  assert.equal(made.status, 201);
  assert.deepEqual(
    [made.data.kind, made.data.name, made.data.lat, made.data.lng, made.data.etaSeconds, made.data.by],
    ["destination", "속초 해수욕장", 38.19, 128.6, 7200, driver.id]
  );
  assert.ok(Math.abs(made.data.at - Date.now()) < 5000);
  const late = await call("POST", path, { kind: "approaching", name: "속초 해수욕장", at: trip.createdAt + 1000, etaSeconds: 240 }, driver.token);
  assert.equal(late.status, 201);
  assert.equal(late.data.lat, undefined, "좌표 없는 장소도 남긴다");
  const seen = (await call("GET", `/trips/${trip.code}`)).data;
  assert.deepEqual(seen.places.map((p) => p.id), [made.data.id, late.data.id]);

  // 권한과 입력
  assert.equal((await call("POST", path, { kind: "stop", name: "휴게소" })).status, 401, "참가자 토큰이 없으면 거절");
  const other = await newTrip();
  const stranger = await join(other.code, { name: "다른 여행" }, "ROW_1_LEFT");
  assert.equal((await call("POST", path, { kind: "stop", name: "휴게소" }, stranger.token)).status, 401, "다른 여행의 토큰은 거절");
  for (const bad of [
    { kind: "home", name: "집" },
    { kind: "stop", name: "" },
    { kind: "stop", name: "가".repeat(101) },
    { kind: "stop", name: "휴게소", lat: 37 },
    { kind: "stop", name: "휴게소", lat: 91, lng: 127 },
    { kind: "stop", name: "휴게소", etaSeconds: -1 },
    { kind: "stop", name: "휴게소", etaSeconds: 1.5 },
    { kind: "stop", name: "휴게소", at: trip.createdAt - 120_000 },
    { kind: "stop", name: "휴게소", at: Date.now() + 120_000 },
  ])
    assert.equal((await call("POST", path, bad, driver.token)).status, 400, JSON.stringify(bad));
  assert.equal((await call("GET", path, undefined, driver.token)).status, 405);
  assert.equal((await call("POST", `${path}/x`, { kind: "stop", name: "휴게소" }, driver.token)).status, 404);
  assert.equal((await call("GET", `/trips/${trip.code}`)).data.places.length, 2, "거절한 요청은 남지 않음");

  // 한도: 200개
  const doc = (await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
  doc.places = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, kind: "stop", name: `경유 ${i}`, at: trip.createdAt, by: driver.id }));
  await tripsDb().query("UPDATE trips SET doc = $2 WHERE code = $1", [trip.code, doc]);
  assert.equal((await call("POST", path, { kind: "arrived", name: "속초" }, driver.token)).status, 409);
});

test("옛 여행 문서도 places를 빈 목록으로 주고, 출발·끝 시각을 상태가 바뀔 때 남긴다", async () => {
  const trip = await newTrip();
  const doc = (await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
  delete doc.places;
  await tripsDb().query("UPDATE trips SET doc = $2 WHERE code = $1", [trip.code, doc]);
  assert.deepEqual((await call("GET", `/trips/${trip.code}`)).data.places, []);

  const status = (s) => call("PATCH", `/trips/${trip.code}`, { status: s });
  assert.equal((await status("driving")).data.startedAt > 0, true);
  const started = (await call("GET", `/trips/${trip.code}`)).data.startedAt;
  await status("parked");
  await status("driving");
  assert.equal((await call("GET", `/trips/${trip.code}`)).data.startedAt, started, "다시 출발해도 처음 시각");
  const ended = (await status("ended")).data.endedAt;
  assert.ok(ended >= started);
  assert.equal((await status("ended")).data.endedAt, ended, "끝낸 여행을 다시 끝내도 그대로");
  assert.equal((await status("driving")).data.endedAt, undefined, "끝낸 뒤 다시 출발하면 끝 시각을 지움");
});

test("내 여행: 내 프로필이 참가한 여행만 최신 순으로, 구성원·장소·줄인 경로·콘텐츠와 함께", async () => {
  const me = await profile("지우", "bunny");
  const sister = await profile("서아", "cat");
  const stranger = await profile("남");
  assert.equal((await call("GET", "/profiles/me/trips")).status, 401);
  assert.equal((await call("POST", "/profiles/me/trips", {}, me.token)).status, 405);
  assert.deepEqual((await call("GET", "/profiles/me/trips", undefined, me.token)).data, { items: [] });

  // 첫 여행: 동의함, 발화 250줄(좌표 있음 240줄), 장소, 장면, 보관한 영상
  const first = await newTrip("가족 바다 여행");
  const a = await join(first.code, me, "ROW_1_LEFT");
  const b = await join(first.code, sister, "ROW_1_RIGHT");
  await join(first.code, { name: "할머니" }, "ROW_2_LEFT");
  const t0 = first.createdAt;
  await call("POST", `/trips/${first.code}/places`, { kind: "start", name: "집", at: t0 }, a.token);
  await call("POST", `/trips/${first.code}/places`, { kind: "arrived", name: "속초 해수욕장", at: t0 + 30_000 }, a.token);
  await call("PATCH", `/trips/${first.code}`, { status: "driving" });
  const items = Array.from({ length: 250 }, (_, i) => ({ seq: i + 1, at: t0 + i * 100, text: `말 ${i}`, ...(i % 25 === 24 ? {} : { lat: 37 + i / 1000, lng: 127 + i / 1000 }) }));
  assert.equal((await call("POST", `/trips/${first.code}/utterances`, { device: "car", generation: 1, items }, a.token)).status, 200);
  const moment = (await call("POST", `/trips/${first.code}/moments`, { at: t0 + 40_000, lat: 38.19, lng: 128.6, label: "파도 소리" }, a.token)).data;
  const plain = (await call("POST", `/trips/${first.code}/moments`, { at: t0 + 10_000 }, a.token)).data;
  // 보관을 마친 영상 줄을 직접 넣는다(파일 검사·업로드는 short-assets 시험이 본다). 정리 작업이 원본 해시를 다시 보지 않게 임대 시각을 뒤로 둔다.
  const assetId = randomUUID();
  await tripsDb().query(
    `INSERT INTO short_assets (id, trip_code, participant_id, generation, moment_id, source_hash, idempotency_key, request_hash, sha256, media, object_key, state, attempt, lease_until)
     VALUES ($1, $2, $3, 1, $4, 'h', 'key-1', 'r', 's', $5, 'k1', 'completed', $6, now() + interval '1 hour'), ($7, $2, $3, 1, $4, 'h', 'key-2', 'r', 's', $5, 'k2', 'uploading', $6, now() + interval '1 hour')`,
    [assetId, first.code, a.id, moment.id, { seconds: 12.5, mimeType: "video/mp4" }, randomUUID(), randomUUID()]
  );
  const genId = randomUUID();
  await tripsDb().query(
    `INSERT INTO short_generations (id, trip_code, participant_id, generation, moment_id, idempotency_key, request_hash, plan, source_key, state)
     VALUES ($1, $2, $3, 1, $4, 'g-1', 'r', $5, '', 'completed'), ($6, $2, $3, 1, $4, 'g-2', 'r', $5, '', 'failed')`,
    [genId, first.code, a.id, plain.id, { seconds: 8, templateId: "t" }, randomUUID()]
  );
  await call("PATCH", `/trips/${first.code}`, { status: "ended" });

  // 둘째 여행: 나는 동의하지 않음 → 경로·콘텐츠는 비움
  const second = await newTrip("출근길");
  const quiet = await join(second.code, me, "ROW_1_LEFT", false);
  await call("POST", `/trips/${second.code}/places`, { kind: "destination", name: "회사" }, quiet.token);
  // 남의 여행은 나오지 않는다
  const others = await newTrip("남의 여행");
  await join(others.code, stranger, "ROW_1_LEFT");

  const { status, data } = await call("GET", "/profiles/me/trips", undefined, me.token);
  assert.equal(status, 200);
  assert.deepEqual(data.items.map((t) => t.code), [second.code, first.code], "최신 순, 남의 여행은 빠짐");
  const [quietTrip, trip] = data.items;
  assert.deepEqual([quietTrip.route, quietTrip.contents, quietTrip.places.map((p) => p.name)], [[], [], ["회사"]], "동의하지 않은 여행은 장소만");

  assert.deepEqual([trip.title, trip.status, trip.createdAt, trip.groupName], ["가족 바다 여행", "ended", t0, null]);
  assert.ok(trip.startedAt >= t0 && trip.endedAt >= trip.startedAt);
  assert.deepEqual(trip.members, [
    { participantId: a.id, name: "지우", character: "bunny", seat: "ROW_1_LEFT", profileId: me.id },
    { participantId: b.id, name: "서아", character: "cat", seat: "ROW_1_RIGHT", profileId: sister.id },
    { participantId: trip.members[2].participantId, name: "할머니", character: "", seat: "ROW_2_LEFT" },
  ]);
  assert.deepEqual(trip.places.map((p) => [p.kind, p.name]), [["start", "집"], ["arrived", "속초 해수욕장"]]);

  // 경로: 좌표 있는 240점을 200점 이하로, 시간순, 첫 점·끝 점 포함
  assert.ok(trip.route.length <= 200 && trip.route.length >= 100, `${trip.route.length}점`);
  assert.deepEqual(trip.route[0], [37, 127, t0]);
  assert.deepEqual(trip.route.at(-1), [37 + 248 / 1000, 127 + 248 / 1000, t0 + 24_800]);
  assert.ok(trip.route.every((p, i) => i === 0 || p[2] > trip.route[i - 1][2]));

  // 콘텐츠: 완료된 것만, 장면의 제목·좌표·그때의 장소, 시각순
  assert.deepEqual(trip.contents, [
    { id: genId, momentId: plain.id, title: "가족 바다 여행", seconds: 8, at: t0 + 10_000, lat: null, lng: null, place: "집", kind: "generated", url: `/api/trips/${first.code}/short-generations/${genId}/file` },
    { id: assetId, momentId: moment.id, title: "파도 소리", seconds: 12.5, at: t0 + 40_000, lat: 38.19, lng: 128.6, place: "속초 해수욕장", kind: "device", url: `/api/trips/${first.code}/short-assets/${assetId}/file` },
  ]);

  // 동의를 철회하면(세대가 오름) 옛 세대의 경로와 콘텐츠는 빠진다
  await call("PATCH", `/trips/${first.code}/participants/${b.id}`, { consent: false });
  const after = (await call("GET", "/profiles/me/trips", undefined, me.token)).data.items.find((t) => t.code === first.code);
  assert.deepEqual([after.route, after.contents], [[], []]);
});

test("내 여행은 50개까지", async () => {
  const me = await profile("자주 타는 사람");
  for (let i = 0; i < 52; i++) await join((await newTrip(`여행 ${i}`)).code, me, "ROW_1_LEFT");
  const { status, data } = await call("GET", "/profiles/me/trips", undefined, me.token);
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.items.length, 50);
  assert.equal(data.items[0].title, "여행 51");
});
