// 이메일 계정·로그인·계정 동의·사진 범위(T128). 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, server } from "./server.js";
import { hashPassword, verifyPassword } from "./accounts.js";
import { endStores, profilesDb } from "./db.js";
import { captureLog } from "./log.js";
import { withVoice } from "./voice-fixture.js";

let base, adminUrl, names;
const logs = [];
captureLog((line) => logs.push(line));
before(async () => {
  adminUrl = process.env.DATABASE_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  names = [`${admin.database}_accounts_trips_${process.pid}`, `${admin.database}_accounts_profiles_${process.pid}`];
  for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.TRIPS_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[0]}`);
  process.env.PROFILES_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[1]}`);
  await migrate();
  await migrate(); // 여러 번 돌려도 같아야 한다
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

async function call(method, path, body, token, raw) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: raw ?? JSON.stringify(body) } : {}),
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, data: res.status === 204 ? null : type.startsWith("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
const signup = (email, more = {}) => call("POST", "/accounts", { email, password: "바다보러가자1234", name: "지우", ...more });
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("가입하면 프로필과 토큰을 주고, 이메일은 본인 응답에만 있고, 비밀번호는 scrypt 값으로만 남는다", async () => {
  const made = await signup("  Jiwoo@Example.COM ", { character: "bunny", device: "폰" });
  assert.equal(made.status, 201);
  assert.match(made.data.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(
    [made.data.email, made.data.name, made.data.character, made.data.hasVoice, made.data.consent, made.data.consentAt, made.data.hasPhoto],
    ["jiwoo@example.com", "지우", "bunny", false, false, null, false]
  );
  const me = await call("GET", "/profiles/me", undefined, made.data.token);
  assert.equal(me.data.email, "jiwoo@example.com");
  assert.equal(me.data.token, undefined, "토큰은 발급할 때만");
  assert.equal(me.headers.get("cache-control"), "no-store");

  const { rows } = await profilesDb().query("SELECT email, password_hash FROM profiles WHERE id = $1", [made.data.id]);
  assert.match(rows[0].password_hash, /^scrypt:16384:8:1:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]{88}$/);
  assert.ok(!rows[0].password_hash.includes("바다보러가자"));
  assert.ok(!logs.join("\n").includes("바다보러가자"), "비밀번호가 로그에 남지 않음");
  // 같은 비밀번호도 소금이 달라 값이 다르다
  const other = await signup("other@example.com");
  const { rows: two } = await profilesDb().query("SELECT password_hash FROM profiles WHERE id = ANY($1::uuid[])", [[made.data.id, other.data.id]]);
  assert.notEqual(two[0].password_hash, two[1].password_hash);

  // 이메일 중복(대소문자·공백 무시)은 409
  assert.equal((await signup("JIWOO@example.com")).status, 409);
  const dup = await Promise.all([signup("race@example.com"), signup("race@example.com")]);
  assert.deepEqual(dup.map((r) => r.status).sort(), [201, 409], "동시에 같은 이메일로 가입해도 하나만");
});

test("입력 검사: 이메일 모양, 비밀번호 8~72자, 이름", async () => {
  for (const email of ["", "jiwoo", "a@b", "a b@c.d", 3, `${"a".repeat(250)}@b.cd`]) assert.equal((await signup(email)).status, 400, String(email));
  // NUL·짝 없는 서로게이트는 DB에 묻기 전에 400(그대로 보내면 Postgres가 받지 않아 500이 된다) — 가입과 로그인 모두
  for (const email of ["a\0b@example.com", "\ud800@example.com", "a@exam\udfffple.com"]) {
    assert.equal((await signup(email)).status, 400, JSON.stringify(email));
    const login = await call("POST", "/sessions", { email, password: "바다보러가자1234" });
    assert.deepEqual([login.status, login.data.type], [400, "invalid"], JSON.stringify(email));
  }
  for (const password of ["1234567", "가".repeat(73), 12345678, "\0abcdefgh"]) assert.equal((await signup("p@example.com", { password })).status, 400, String(password));
  assert.equal((await signup("p@example.com", { password: "가".repeat(72) })).status, 201, "72자까지 됨(바이트가 아니라 글자)");
  assert.equal((await signup("q@example.com", { password: "12345678" })).status, 201, "8자부터 됨");
  assert.equal((await signup("r@example.com", { name: undefined })).status, 400, "새 계정에는 이름이 필요함");
  assert.equal((await call("GET", "/accounts")).status, 405);
  assert.equal((await call("POST", "/sessions", { email: "x@example.com" })).status, 400);
});

test("로그인: 맞으면 새 기기 토큰, 틀린 비밀번호와 없는 이메일은 같은 401", async () => {
  const made = await signup("login@example.com");
  const ok = await call("POST", "/sessions", { email: " LOGIN@example.com", password: "바다보러가자1234", device: "차량" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.id, made.data.id);
  assert.notEqual(ok.data.token, made.data.token, "기기마다 다른 토큰");
  for (const token of [ok.data.token, made.data.token]) assert.equal((await call("GET", "/profiles/me", undefined, token)).data.id, made.data.id, "앞 기기의 토큰도 그대로");
  const { rows } = await profilesDb().query("SELECT device FROM tokens WHERE profile_id = $1 ORDER BY created_at", [made.data.id]);
  assert.deepEqual(rows.map((r) => r.device), ["", "차량"]);

  const wrong = await call("POST", "/sessions", { email: "login@example.com", password: "바다보러가자12345" });
  const nobody = await call("POST", "/sessions", { email: "nobody@example.com", password: "바다보러가자1234" });
  const short = await call("POST", "/sessions", { email: "login@example.com", password: "1" });
  for (const r of [wrong, nobody, short]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, wrong.data, "어느 쪽이 틀렸는지 말하지 않음");
    assert.equal(r.data.token, undefined);
  }
  // 이메일 없는 기기 프로필은 비밀번호로 들어갈 수 없다
  await call("POST", "/profiles", { name: "기기만" });
  assert.equal((await call("POST", "/sessions", { email: "", password: "" })).status, 401);
});

test("기기 프로필에 계정을 붙이면 같은 프로필이 되고, 이미 계정이 있거나 남의 이메일이면 409", async () => {
  const device = (await call("POST", "/profiles", { name: "기기 프로필", character: "cat" })).data;
  const attached = await call("POST", "/accounts", { email: "attach@example.com", password: "12345678" }, device.token);
  assert.equal(attached.status, 200);
  assert.deepEqual([attached.data.id, attached.data.name, attached.data.character, attached.data.email, attached.data.token], [device.id, "기기 프로필", "cat", "attach@example.com", device.token]);
  const login = await call("POST", "/sessions", { email: "attach@example.com", password: "12345678" });
  assert.equal(login.data.id, device.id);
  assert.equal((await call("POST", "/accounts", { email: "attach2@example.com", password: "12345678" }, device.token)).status, 409, "비밀번호 바꾸기가 아님");
  const second = (await call("POST", "/profiles", { name: "둘째" })).data;
  assert.equal((await call("POST", "/accounts", { email: "attach@example.com", password: "12345678" }, second.token)).status, 409);
  assert.equal((await call("POST", "/accounts", { email: "attach3@example.com", password: "12345678" }, "x".repeat(43))).status, 401, "틀린 토큰은 새 계정으로 넘어가지 않음");
  const { rows } = await profilesDb().query("SELECT count(*)::int AS n FROM profiles WHERE email = 'attach3@example.com'");
  assert.equal(rows[0].n, 0);
});

test("계정 동의는 시각과 문구 판을 남기고, 끄면 비운다. 목소리 등록 여부가 프로필에 보인다", async () => {
  const { data: me } = await signup("consent@example.com");
  const on = await call("PATCH", "/profiles/me", { consent: true }, me.token);
  assert.equal(on.status, 200);
  assert.equal(on.data.consent, true);
  assert.ok(Math.abs(on.data.consentAt - Date.now()) < 5000);
  assert.equal(on.data.consentVersion, "2026-11-14");
  const v2 = await call("PATCH", "/profiles/me", { consent: true, consentVersion: "v2" }, me.token);
  assert.equal(v2.data.consentVersion, "v2");
  const named = await call("PATCH", "/profiles/me", { name: "지우개" }, me.token);
  assert.deepEqual([named.data.name, named.data.consent, named.data.consentVersion], ["지우개", true, "v2"], "동의를 보내지 않으면 그대로");
  const off = await call("PATCH", "/profiles/me", { consent: false }, me.token);
  assert.deepEqual([off.data.consent, off.data.consentAt, off.data.consentVersion], [false, null, null]);
  for (const bad of [{ consent: "yes" }, { consent: true, consentVersion: "" }]) assert.equal((await call("PATCH", "/profiles/me", bad, me.token)).status, 400);

  const { cases } = JSON.parse(await readFile(new URL("voice-vectors.json", import.meta.url), "utf8"));
  const value = JSON.stringify({ embedder: "logmel-pitch-1", vector: cases[0].vector, seconds: 7 });
  assert.equal((await call("POST", "/profiles/me/voice", null, me.token, value)).status, 200);
  assert.equal((await call("GET", "/profiles/me", undefined, me.token)).data.hasVoice, true);
  // 다른 임베더 길이의 옛 값은 차가 쓰지 못하니 '등록함'으로 세지 않는다
  await profilesDb().query("UPDATE voice_prints SET vector = $2 WHERE profile_id = $1", [me.id, [1, 0, 0]]);
  assert.equal((await call("GET", "/profiles/me", undefined, me.token)).data.hasVoice, false);
  assert.equal((await call("DELETE", "/profiles/me/voice", undefined, me.token)).status, 204);
  assert.equal((await call("GET", "/profiles/me", undefined, me.token)).data.hasVoice, false);
});

test("선택 칸(device, character, 붙일 때의 name)의 빈 글은 보내지 않은 것과 같다", async () => {
  const made = await signup("empty@example.com", { character: "", device: "" });
  assert.equal(made.status, 201);
  assert.equal(made.data.character, "");
  const login = await call("POST", "/sessions", { email: "empty@example.com", password: "바다보러가자1234", device: "" });
  assert.equal(login.status, 200);
  const { rows } = await profilesDb().query("SELECT device FROM tokens WHERE profile_id = $1", [made.data.id]);
  assert.deepEqual(rows.map((r) => r.device), ["", ""]);
  const device = (await call("POST", "/profiles", { name: "고양이 기기", character: "cat" })).data;
  const attached = await call("POST", "/accounts", { email: "empty2@example.com", password: "12345678", name: "", character: "", device: "" }, device.token);
  assert.equal(attached.status, 200);
  assert.deepEqual([attached.data.name, attached.data.character], ["고양이 기기", "cat"], "붙일 때 빈 글은 있던 값을 그대로 둠");
  assert.equal((await signup("empty3@example.com", { name: "" })).status, 400, "새 계정의 이름은 빈 글이면 안 됨");
  assert.equal((await signup("empty4@example.com", { character: " " })).status, 400, "공백만은 빈 글이 아님");
});

test("계정 동의(지금 판)는 본인이 자기 토큰으로 들어가는 여행에 이어지고, 여행별 철회는 그대로다", async () => {
  const consented = async (email, version) => {
    const { data } = await signup(email);
    await call("PATCH", "/profiles/me", { consent: true, ...(version ? { consentVersion: version } : {}) }, data.token);
    await withVoice(base, data.token); // 프로필로 참가하려면 목소리 먼저(T173)
    return data;
  };
  const yes = await consented("join-yes@example.com");
  const old = await consented("join-old@example.com", "2026-01-01");
  const no = (await signup("join-no@example.com")).data;
  await withVoice(base, no.token);
  const trip = (await call("POST", "/trips", {})).data;
  const t = `/trips/${trip.code}`;
  // (가) 프로필 토큰으로 참가: 동의를 보내지 않으면 계정 동의, 다른 판이거나 꺼져 있으면 지금처럼 기본값(false)
  const a = (await call("POST", `${t}/participants`, { seat: "ROW_1_LEFT" }, yes.token)).data;
  const b = (await call("POST", `${t}/participants`, { seat: "ROW_1_RIGHT" }, old.token)).data;
  const c = (await call("POST", `${t}/participants`, { seat: "ROW_2_LEFT" }, no.token)).data;
  assert.deepEqual([a.consent, b.consent, c.consent], [true, false, false]);
  const other = (await call("POST", "/trips", {})).data;
  assert.equal((await call("POST", `/trips/${other.code}/participants`, { seat: "ROW_1_LEFT", consent: false }, yes.token)).data.consent, false, "참가하며 보낸 값이 먼저");
  // (다) 여행에서 끄면 그 여행만 꺼지고 동의 세대가 오른다. 계정 동의는 그대로
  await call("PATCH", `${t}/participants/${a.id}`, { consent: false });
  const after = (await call("GET", t)).data;
  assert.deepEqual([after.participants.find((p) => p.id === a.id).consent, after.generation], [false, 2]);
  assert.equal((await call("GET", "/profiles/me", undefined, yes.token)).data.consent, true);
  assert.equal((await call("POST", `${t}/participants`, { seat: "ROW_2_RIGHT" }, yes.token)).data.consent, false, "다시 참가해도 여행에서 끈 동의를 되살리지 않음");

  // (나) 차량 QR 초대: 계정 동의(지금 판)가 켜진 사람만 켠 채로
  const ride = (await call("POST", "/trips", { title: "QR" })).data;
  const driver = (await call("POST", `/trips/${ride.code}/participants`, { name: "운전자", seat: "ROW_1_LEFT", consent: true })).data;
  const invite = (await call("POST", `/trips/${ride.code}/boarding-invites`, {}, driver.token)).data;
  const code = new URL(invite.url, base).searchParams.get("join");
  const board = (who, seat) => call("POST", `/boarding-invites/${code}/participants`, { seat }, who.token);
  const joined = await Promise.all([board(yes, "ROW_1_RIGHT"), board(old, "ROW_2_LEFT"), board(no, "ROW_2_RIGHT")]);
  assert.deepEqual(joined.map((r) => [r.status, r.data.participant.consent]), [[201, true], [201, false], [201, false]]);
  assert.equal((await call("POST", `/boarding-invites/${code}/participants`, { seat: "ROW_2_CENTER", consent: true }, no.token)).status, 400, "입력으로 대신 켜지 못함");
});

test("다른 프로필의 사진 주소는 지금 본인만 받는다(그룹은 A2)", async () => {
  const { data: a } = await signup("photo-a@example.com");
  const { data: b } = await signup("photo-b@example.com");
  const put = await fetch(`${base}/api/profiles/me/photo`, { method: "PUT", headers: { authorization: `Bearer ${a.token}` }, body: PNG });
  assert.equal(put.status, 204);
  const own = await call("GET", `/profiles/${a.id}/photo`, undefined, a.token);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "image/png");
  assert.equal(own.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(own.data, PNG);
  assert.equal((await call("GET", `/profiles/${a.id}/photo`, undefined, b.token)).status, 404, "남의 사진은 없는 것과 같게");
  assert.equal((await call("GET", `/profiles/${a.id}/photo`)).status, 401);
  assert.equal((await call("GET", `/profiles/not-a-uuid/photo`, undefined, a.token)).status, 404);
  assert.equal((await call("PUT", `/profiles/${a.id}/photo`, undefined, a.token)).status, 405);
  assert.equal((await call("GET", `/profiles/${a.id}`, undefined, a.token)).status, 404);
  assert.equal((await call("GET", `/profiles/${b.id}/photo`, undefined, b.token)).status, 404, "사진이 없으면 404");
});

test("비밀번호 값: 맞는 것만 통과하고 모양이 이상한 저장값은 틀린 것으로 본다", async () => {
  const stored = await hashPassword("abcdefgh");
  assert.equal(await verifyPassword("abcdefgh", stored), true);
  assert.equal(await verifyPassword("abcdefgi", stored), false);
  for (const bad of [null, "", "bcrypt:x", "scrypt:16384:8:1::", stored.slice(0, -4)]) assert.equal(await verifyPassword("abcdefgh", bad), false);
});
