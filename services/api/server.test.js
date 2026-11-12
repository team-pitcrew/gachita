// 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { migrate, pool, server } from "./server.js";

let base;
before(async () => {
  await migrate();
  await migrate(); // 여러 번 실행해도 같아야 한다
  await pool.query("TRUNCATE trips, profiles");
  await new Promise((ok) => server.listen(0, () => ok((base = `http://localhost:${server.address().port}`))));
});
after(async () => {
  server.close();
  await pool.end();
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
  const { rows } = await pool.query("SELECT token_hash FROM profiles WHERE id = $1", [me.id]);
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
  const stored = (await pool.query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
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
  assert.equal((await fetch(`${base}/..%2F..%2Fservices%2Fapi%2Fserver.js`)).status, 404, "웹앱 폴더 밖은 내보내지 않음");
  assert.equal((await call("GET", "/healthz"))[0], 200);
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /같이타/);
});
