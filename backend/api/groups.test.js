// 가족·동승 그룹, 아이 프로필, 초대 코드, 자리, 그룹으로 여행 만들기(T133). 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, server } from "./server.js";
import { endStores, profilesDb, tripsDb } from "./db.js";
import { captureLog } from "./log.js";

let base, adminUrl, names, vector;
captureLog(() => {});
before(async () => {
  adminUrl = process.env.DATABASE_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  names = [`${admin.database}_groups_trips_${process.pid}`, `${admin.database}_groups_profiles_${process.pid}`];
  for (const name of names) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  process.env.TRIPS_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[0]}`);
  process.env.PROFILES_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[1]}`);
  await migrate();
  await migrate(); // 여러 번 돌려도 같아야 한다
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
  vector = JSON.parse(await readFile(new URL("voice-vectors.json", import.meta.url), "utf8")).cases[0].vector;
});
after(async () => {
  await new Promise((ok) => server.close(ok));
  await endStores();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

async function call(method, path, body, token, type = "application/json") {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}),
  });
  const json = (res.headers.get("content-type") ?? "").startsWith("application/json");
  return { status: res.status, data: res.status === 204 ? null : json ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
let n = 0;
// 계정을 만들고 계정 동의를 켠다(version을 주면 그 판으로 — 지금 판이 아니면 여행에 이어지지 않는다).
async function person(name, { consent = true, version } = {}) {
  const made = await call("POST", "/accounts", { email: `p${++n}-${process.pid}@example.com`, password: "가족여행가자123", name, character: "bunny" });
  assert.equal(made.status, 201);
  if (consent) await call("PATCH", "/profiles/me", { consent: true, ...(version ? { consentVersion: version } : {}) }, made.data.token);
  return made.data;
}
const family = async (owner, name = "우리 가족", kind = "family") => {
  const made = await call("POST", "/groups", { name, kind }, owner.token);
  assert.equal(made.status, 201);
  return made.data;
};
const invite = async (g, who) => (await call("POST", `/groups/${g.id}/invites`, undefined, who.token)).data.code;
const joinGroup = (code, who) => call("POST", `/group-invites/${code}`, undefined, who?.token);
const child = async (g, guardian, name = "서아", guardianConsent = true) => {
  const made = await call("POST", `/groups/${g.id}/children`, { name, character: "cat", guardianConsent }, guardian.token);
  assert.equal(made.status, 201);
  return made.data.members.find((m) => m.name === name && m.role === "child");
};
const voice = (g, profileId, who, body = { embedder: "logmel-pitch-1", vector, seconds: 7 }) =>
  call("POST", `/groups/${g.id}/members/${profileId}/voice`, JSON.stringify(body), who.token);
const memberOf = (g, id) => g.members.find((m) => m.profileId === id);

test("그룹 만들기: 가족·동승 모두 대표를 운전석에. 내 그룹만 보인다", async () => {
  const dad = await person("아빠");
  const stranger = await person("남");
  const fam = await family(dad);
  assert.deepEqual([fam.name, fam.kind, fam.ownerId, fam.invite], ["우리 가족", "family", dad.id, null]);
  assert.deepEqual(fam.members, [{ profileId: dad.id, name: "아빠", character: "bunny", hasPhoto: false, hasVoice: false, consent: true, role: "owner", seat: "ROW_1_LEFT", pending: false }]);
  const crew = await family(dad, "출근 동승", "guest");
  assert.deepEqual([crew.kind, crew.members[0].seat], ["guest", "ROW_1_LEFT"], "동승 그룹도 만든 사람이 운전석(차 참석 QR, T162)");
  assert.deepEqual((await call("GET", "/groups", undefined, dad.token)).data.items.map((g) => g.id), [fam.id, crew.id]);
  assert.deepEqual((await call("GET", "/groups", undefined, stranger.token)).data, { items: [] }, "남의 그룹은 보이지 않음");

  for (const bad of [{ name: "", kind: "family" }, { name: "가".repeat(21), kind: "family" }, { name: "가족", kind: "crew" }, { name: "가족" }])
    assert.equal((await call("POST", "/groups", bad, dad.token)).status, 400, JSON.stringify(bad));
  assert.equal((await call("GET", "/groups")).status, 401);
  assert.equal((await call("POST", "/groups", { name: "가족", kind: "family" }, "x".repeat(43))).status, 401);
  assert.equal((await call("DELETE", "/groups", undefined, dad.token)).status, 405);
  assert.equal((await call("GET", `/groups/${fam.id}`, undefined, dad.token)).status, 404);
  assert.equal((await call("GET", `/groups/${fam.id}/seats`, undefined, dad.token)).status, 405);
});

test("초대 코드: 모양·24시간·그룹당 하나, 미리보기, 성인으로 들어가기(계정 동의를 따라감), 만료·바뀐 코드는 410", async () => {
  const dad = await person("아빠");
  const mom = await person("엄마");
  const uncle = await person("삼촌", { consent: false });
  const fam = await family(dad);
  const made = await call("POST", `/groups/${fam.id}/invites`, undefined, dad.token);
  assert.equal(made.status, 201);
  assert.match(made.data.code, /^FAMILY-[0-9]{4}$/);
  assert.equal(made.data.url, `/?group=${made.data.code}`, "QR·링크는 같은 출처의 앱 주소");
  assert.ok(Math.abs(made.data.expiresAt - (Date.now() + 24 * 3600_000)) < 60_000);
  const crew = await family(dad, "동승", "guest");
  const trip = await invite(crew, dad);
  assert.match(trip, /^TRIP-[0-9]{4}$/);
  assert.equal((await call("GET", `/group-invites/${trip}`)).data.kind, "guest");

  const preview = await call("GET", `/group-invites/${made.data.code}`);
  assert.deepEqual(preview.data, { groupName: "우리 가족", kind: "family", ownerName: "아빠", expiresAt: made.data.expiresAt });
  assert.equal((await call("GET", `/group-invites/${made.data.code.toLowerCase()}`)).status, 200, "대소문자를 가리지 않음");

  assert.equal((await joinGroup(made.data.code)).status, 401, "들어가려면 프로필 토큰");
  const joined = await joinGroup(made.data.code, mom);
  assert.equal(joined.status, 200);
  assert.deepEqual(memberOf(joined.data, mom.id), { profileId: mom.id, name: "엄마", character: "bunny", hasPhoto: false, hasVoice: false, consent: true, role: "adult", seat: "ROW_1_RIGHT", pending: false });
  assert.deepEqual(joined.data.invite, made.data, "구성원은 지금 초대 코드·주소를 본다");
  const again = await joinGroup(made.data.code, mom);
  assert.equal(again.status, 200);
  assert.equal(again.data.members.length, 2, "같은 사람이 다시 들어와도 한 번");
  const off = await joinGroup(made.data.code, uncle);
  assert.equal(memberOf(off.data, uncle.id).consent, false, "계정 동의가 꺼져 있으면 consent:false로 들어간다");
  const { rows } = await profilesDb().query("SELECT uses FROM invites WHERE code = $1", [made.data.code]);
  assert.equal(rows[0].uses, 2);

  // 새 코드를 만들면 이전 코드는 바로 못 쓴다(재사용 금지). 구성원이면 성인도 만들 수 있다
  const next = await invite(fam, mom);
  assert.notEqual(next, made.data.code);
  const late = await person("늦은 사람");
  assert.equal((await joinGroup(made.data.code, late)).status, 410);
  assert.equal((await call("GET", `/group-invites/${made.data.code}`)).status, 410);
  // 24시간이 지나면 410
  await profilesDb().query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1", [next]);
  assert.equal((await joinGroup(next, late)).status, 410);
  assert.equal((await call("GET", "/groups", undefined, dad.token)).data.items.find((g) => g.id === fam.id).invite, null, "만료된 코드는 그룹에 보이지 않음");
  assert.ok(!(await call("GET", "/groups", undefined, late.token)).data.items.length, "만료·바뀐 코드로는 들어가지 못함");
  for (const bad of ["FAMILY-12345", "FAMILY-abcd", "HOME-1234", "TRIP-0000"]) assert.equal((await call("GET", `/group-invites/${bad}`)).status, 404, bad);
  assert.equal((await call("GET", `/group-invites/${next}/extra`)).status, 404);
  assert.equal((await call("DELETE", `/group-invites/${next}`)).status, 405);
});

test("틀린 초대 코드는 프로필마다 10번까지만 시도한다", async () => {
  const guesser = await person("짐작하는 사람");
  for (let i = 0; i < 10; i++) assert.equal((await joinGroup(`FAMILY-9${String(i).padStart(3, "0")}`, guesser)).status, 404);
  assert.equal((await joinGroup("FAMILY-9999", guesser)).status, 429);
  const dad = await person("아빠");
  const code = await invite(await family(dad), dad);
  assert.equal((await joinGroup(code, guesser)).status, 429, "맞는 코드여도 잠시 막힘");
  assert.equal((await joinGroup(code, await person("다른 사람"))).status, 200, "다른 프로필은 그대로");
});

test("남의 그룹은 없는 그룹과 같다", async () => {
  const dad = await person("아빠");
  const stranger = await person("남");
  const fam = await family(dad);
  const kid = await child(fam, dad);
  for (const [method, path, body] of [
    ["POST", `/groups/${fam.id}/invites`],
    ["POST", `/groups/${fam.id}/children`, { name: "몰래", guardianConsent: true }],
    ["PUT", `/groups/${fam.id}/seats`, { seats: { [stranger.id]: "ROW_1_RIGHT" } }],
    ["PATCH", `/groups/${fam.id}/members/${kid.profileId}`, { guardianConsent: false }],
    ["DELETE", `/groups/${fam.id}/members/${kid.profileId}`],
    ["DELETE", `/groups/${fam.id}/members/${dad.id}`],
    ["DELETE", `/groups/${fam.id}/members/${kid.profileId}/voice`],
  ])
    assert.equal((await call(method, path, body, stranger.token)).status, 404, `${method} ${path}`);
  assert.equal((await voice(fam, kid.profileId, stranger)).status, 404);
  assert.equal((await call("POST", "/trips", { groupId: fam.id }, stranger.token)).status, 404);
  assert.equal((await call("GET", `/profiles/${kid.profileId}/photo`, undefined, stranger.token)).status, 404);
  assert.equal((await call("POST", `/groups/not a group/invites`, undefined, stranger.token)).status, 404);
  const after = (await call("GET", "/groups", undefined, dad.token)).data.items[0];
  assert.deepEqual([after.members.length, memberOf(after, kid.profileId).consent, after.invite], [2, true, null], "아무것도 바뀌지 않음");
});

test("아이 프로필: 만든 사람이 보호자, 목소리는 보호자만·보호자 동의가 켜져 있을 때만", async () => {
  const dad = await person("아빠");
  const mom = await person("엄마");
  const fam = await family(dad);
  await joinGroup(await invite(fam, dad), mom);
  const kid = await child(fam, dad, "서아");
  assert.deepEqual(kid, { profileId: kid.profileId, name: "서아", character: "cat", hasPhoto: false, hasVoice: false, consent: true, role: "child", seat: "ROW_2_LEFT", pending: false, guardianId: dad.id });
  const baby = await child(fam, mom, "도윤", false);
  assert.deepEqual([baby.guardianId, baby.consent], [mom.id, false], "성인도 아이를 만들고 그 보호자가 된다");
  const { rows } = await profilesDb().query("SELECT managed_by, token_hash, consent_version FROM profiles WHERE id = $1", [kid.profileId]);
  assert.deepEqual(rows[0], { managed_by: dad.id, token_hash: null, consent_version: "2026-11-14" }, "아이는 토큰이 없다");
  for (const bad of [{ name: "", guardianConsent: true }, { name: "아이" }, { name: "아이", guardianConsent: "yes" }])
    assert.equal((await call("POST", `/groups/${fam.id}/children`, bad, dad.token)).status, 400, JSON.stringify(bad));

  // 목소리: 보호자가 아닌 성인(대표 포함)은 403, 보호자 동의가 꺼져 있으면 409
  assert.equal((await voice(fam, kid.profileId, mom)).status, 403, "다른 성인은 남의 아이 목소리를 못 올림");
  assert.equal((await voice(fam, baby.profileId, dad)).status, 403, "대표도 보호자가 아니면 못 올림");
  assert.equal((await voice(fam, baby.profileId, mom)).status, 409, "보호자 동의가 꺼져 있음");
  const ok = await voice(fam, kid.profileId, dad);
  assert.deepEqual([ok.status, ok.data], [200, { seconds: 7, dims: 112 }]);
  assert.equal((await voice(fam, kid.profileId, dad, { embedder: "other-1", vector, seconds: 7 })).status, 400, "프로필 등록과 같은 검사");
  assert.equal((await voice(fam, kid.profileId, dad, { embedder: "logmel-pitch-1", vector: vector.slice(1), seconds: 7 })).status, 400);
  assert.equal((await call("POST", `/groups/${fam.id}/members/${kid.profileId}/voice`, Buffer.from("RIFF"), dad.token, "application/octet-stream")).status, 400, "WAV도 같은 길로");
  assert.equal(memberOf((await call("GET", "/groups", undefined, mom.token)).data.items[0], kid.profileId).hasVoice, true);
  assert.equal((await voice(fam, mom.id, mom)).status, 200, "본인 것도 이 길로 됨");
  assert.equal((await voice(fam, dad.id, mom)).status, 403, "다른 성인의 목소리는 안 됨");

  // 보호자가 동의를 고친다(보호자만)
  assert.equal((await call("PATCH", `/groups/${fam.id}/members/${baby.profileId}`, { guardianConsent: true }, dad.token)).status, 403);
  const fixed = await call("PATCH", `/groups/${fam.id}/members/${baby.profileId}`, { guardianConsent: true, name: "도윤이" }, mom.token);
  assert.deepEqual([fixed.status, memberOf(fixed.data, baby.profileId).consent, memberOf(fixed.data, baby.profileId).name], [200, true, "도윤이"]);
  assert.equal((await voice(fam, baby.profileId, mom)).status, 200);
  assert.equal((await call("PATCH", `/groups/${fam.id}/members/${mom.id}`, { name: "엄마2" }, mom.token)).status, 403, "성인은 /profiles/me에서 고침");
  assert.equal((await call("DELETE", `/groups/${fam.id}/members/${kid.profileId}/voice`, undefined, mom.token)).status, 403);
  assert.equal((await call("DELETE", `/groups/${fam.id}/members/${kid.profileId}/voice`, undefined, dad.token)).status, 204);
  assert.equal(memberOf((await call("GET", "/groups", undefined, dad.token)).data.items[0], kid.profileId).hasVoice, false);
});

test("자리: 한 번에 맞바꾸고, 같은 자리에 둘이면 409(동시에 보내도)", async () => {
  const dad = await person("아빠");
  const mom = await person("엄마");
  const fam = await family(dad);
  await joinGroup(await invite(fam, dad), mom);
  const kid = await child(fam, dad);
  const seats = (body, who = dad) => call("PUT", `/groups/${fam.id}/seats`, body, who.token);
  const set = await seats({ seats: { [mom.id]: "ROW_1_RIGHT", [kid.profileId]: "ROW_2_LEFT" } });
  assert.equal(set.status, 200);
  const swap = await seats({ seats: { [dad.id]: "ROW_1_RIGHT", [mom.id]: "ROW_1_LEFT" } }, mom);
  assert.equal(swap.status, 200, "맞바꾸기는 한 번에");
  assert.deepEqual(swap.data.members.map((m) => [m.name, m.seat]), [["아빠", "ROW_1_RIGHT"], ["엄마", "ROW_1_LEFT"], ["서아", "ROW_2_LEFT"]]);
  assert.equal((await seats({ seats: { [kid.profileId]: "ROW_1_LEFT" } })).status, 409, "이미 앉은 자리");
  assert.equal((await seats({ seats: { [dad.id]: "ROW_2_RIGHT", [mom.id]: "ROW_2_RIGHT" } })).status, 409);
  for (const bad of [{ seats: { [dad.id]: "TRUNK" } }, { seats: { "00000000-0000-0000-0000-000000000000": "ROW_2_RIGHT" } }, { seats: [] }, {}])
    assert.equal((await seats(bad)).status, 400, JSON.stringify(bad));
  const unchanged = (await call("GET", "/groups", undefined, dad.token)).data.items[0];
  assert.deepEqual(unchanged.members.map((m) => m.seat), ["ROW_1_RIGHT", "ROW_1_LEFT", "ROW_2_LEFT"], "거절하면 하나도 바뀌지 않음");
  const race = await Promise.all([seats({ seats: { [dad.id]: "ROW_2_RIGHT" } }), seats({ seats: { [kid.profileId]: "ROW_2_RIGHT" } }, mom)]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409], "동시에 같은 빈자리를 고르면 하나만");
  assert.equal((await seats({ seats: { [kid.profileId]: null, [dad.id]: null } })).status, 200, "null은 자리를 비움");
  // 맞바꾸기의 마지막 방어: DB 제약도 같은 자리를 막는다(커밋 때 검사)
  await assert.rejects(profilesDb().query("UPDATE group_members SET seat = 'ROW_1_LEFT' WHERE group_id = $1", [fam.id]), (e) => e.code === "23505");
});

test("들어온 사람은 빈자리에 앉는다: 성인은 조수석부터, 아이는 뒷자리부터. 운전석·뒤 가운데는 고르지 않음(T162)", async () => {
  const dad = await person("아빠");
  const [mom, aunt, uncle] = await Promise.all(["엄마", "이모", "삼촌"].map((n) => person(n)));
  const fam = await family(dad);
  const code = await invite(fam, dad);
  const seatOf = async (id) => memberOf((await call("GET", "/groups", undefined, dad.token)).data.items[0], id).seat;
  await joinGroup(code, mom);
  assert.equal(await seatOf(mom.id), "ROW_1_RIGHT", "초대로 들어온 성인은 조수석");
  const kid = await child(fam, dad, "서준");
  assert.equal(kid.seat, "ROW_2_LEFT", "아이는 뒤 왼쪽부터");
  assert.equal((await child(fam, mom, "하은")).seat, "ROW_2_RIGHT");
  await joinGroup(code, aunt);
  assert.equal(await seatOf(aunt.id), null, "남은 자리가 운전석·뒤 가운데뿐이면 자리 없이(좌석 배정에서 앉힘)");
  await joinGroup(code, mom);
  assert.equal(await seatOf(mom.id), "ROW_1_RIGHT", "다시 들어와도 자리는 그대로");

  // 동시에 들어와도 같은 자리를 받지 않는다(그룹 줄을 잠근 채 고름)
  const crew = await family(dad, "동승", "guest");
  const trip = await invite(crew, dad);
  await Promise.all([joinGroup(trip, uncle), joinGroup(trip, aunt)]);
  const seats = (await call("GET", "/groups", undefined, dad.token)).data.items.find((g) => g.id === crew.id).members.map((m) => m.seat).sort();
  assert.deepEqual(seats, ["ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT"]);
  const made = await call("POST", "/trips", { groupId: crew.id }, dad.token);
  assert.deepEqual([made.status, made.data.participants.length], [201, 3], "출발하면 셋 다 탄다");
  // 구성원 폰은 내 여행 목록에서 이 그룹의 진행 중 여행과 내 자리를 찾아 프로필로 다시 참가한다
  const mine = (await call("GET", "/profiles/me/trips", undefined, uncle.token)).data.items[0];
  const me = made.data.participants.find((p) => p.profileId === uncle.id);
  assert.deepEqual([mine.code, mine.status, mine.groupId, mine.recording, mine.me], [made.data.code, "boarding", crew.id, false, { participantId: me.id, seat: me.seat, consent: true }]);
  const rejoin = await call("POST", `/trips/${mine.code}/participants`, undefined, uncle.token);
  assert.deepEqual([rejoin.status, rejoin.data.id, rejoin.data.seat], [200, me.id, me.seat]);
});

test("그룹으로 여행 만들기: 저장된 자리, 각자 계정 동의, 모든 참가자에 profileId, 토큰은 나와 내 아이 몫", async () => {
  const dad = await person("아빠");
  const mom = await person("엄마", { version: "2026-01-01" }); // 옛 문구 판에 동의함 → 여행에서는 꺼진 채
  const aunt = await person("이모");
  const fam = await family(dad);
  const code = await invite(fam, dad);
  for (const who of [mom, aunt]) await joinGroup(code, who);
  const kid = await child(fam, dad, "서아");
  const momsKid = await child(fam, mom, "도윤");
  assert.equal((await voice(fam, kid.profileId, dad)).status, 200);
  await call("PUT", `/groups/${fam.id}/seats`, { seats: { [aunt.id]: null, [mom.id]: "ROW_1_RIGHT", [kid.profileId]: "ROW_2_LEFT", [momsKid.profileId]: "ROW_2_RIGHT" } }, dad.token);

  assert.equal((await call("POST", "/trips", { groupId: fam.id })).status, 401);
  assert.equal((await call("POST", "/trips", { groupId: 3 }, dad.token)).status, 400);
  const made = await call("POST", "/trips", { groupId: fam.id, title: "바다 가는 길" }, dad.token);
  assert.equal(made.status, 201);
  const trip = made.data;
  assert.deepEqual([trip.title, trip.status, trip.recording, trip.groupId, trip.groupName], ["바다 가는 길", "boarding", false, fam.id, "우리 가족"]);
  const by = (profileId) => trip.participants.find((p) => p.profileId === profileId);
  assert.equal(trip.participants.length, 4, "자리 없는 이모는 빠짐");
  assert.equal(by(aunt.id), undefined);
  assert.deepEqual(
    [dad, mom, kid, momsKid].map((x) => [by(x.id ?? x.profileId).seat, by(x.id ?? x.profileId).consent]),
    [["ROW_1_LEFT", true], ["ROW_1_RIGHT", false], ["ROW_2_LEFT", true], ["ROW_2_RIGHT", true]]
  );
  assert.ok(trip.participants.every((p) => p.profileId && !p.tokenHash && !p.olderTokenHashes), "모두 profileId, 토큰 해시는 나가지 않음");
  assert.deepEqual(Object.keys(trip.tokens).sort(), [by(dad.id).id, by(kid.profileId).id].sort(), "부른 사람과 그가 보호자인 아이 몫만");
  const me = await call("GET", `/trips/${trip.code}/me`, undefined, trip.tokens[by(kid.profileId).id]);
  assert.deepEqual(me.data, { id: by(kid.profileId).id, name: "서아", seat: "ROW_2_LEFT", consent: true }, "아이 토큰은 보호자 기기가 쓴다");
  // 다른 성인은 자기 폰에서 프로필로 다시 참가해 토큰을 받는다(있던 참가자, 자리 그대로)
  const rejoin = await call("POST", `/trips/${trip.code}/participants`, { seat: "ROW_2_CENTER" }, mom.token);
  assert.deepEqual([rejoin.status, rejoin.data.id, rejoin.data.seat], [200, by(mom.id).id, "ROW_1_RIGHT"]);
  // 차 안 화자 식별: 여행의 대조 값 조회가 아이의 프로필 목소리 값을 profileId로 찾아 준다(ADR-0023)
  await call("PATCH", `/trips/${trip.code}/participants/${by(mom.id).id}`, { consent: true }, rejoin.data.token);
  const prints = await call("GET", `/trips/${trip.code}/voice-prints`, undefined, trip.tokens[by(dad.id).id]);
  assert.equal(prints.status, 200);
  assert.deepEqual(prints.data.items.map((i) => [i.participantId, i.source]), [[by(kid.profileId).id, "profile"]]);
  const open = (await call("GET", `/trips/${trip.code}`)).data;
  assert.deepEqual([open.groupId, open.groupName], [undefined, undefined], "토큰 없는 여행 문서에는 그룹을 싣지 않음");
  const stored = (await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [trip.code])).rows[0].doc;
  assert.deepEqual([stored.groupId, stored.groupName], [fam.id, "우리 가족"], "여행 문서 안에는 남김(내 여행 목록이 읽음)");
  assert.ok(!JSON.stringify(stored).includes(trip.tokens[by(dad.id).id]), "토큰은 저장하지 않음");

  // 자리가 정해진 구성원이 없으면 409
  const empty = await family(dad, "빈 동승", "guest");
  assert.equal((await call("PUT", `/groups/${empty.id}/seats`, { seats: { [dad.id]: null } }, dad.token)).status, 200, "동승 그룹도 대표가 운전석이라 먼저 비움");
  assert.equal((await call("POST", "/trips", { groupId: empty.id }, dad.token)).status, 409);
  // 그룹 없이 만드는 여행은 그대로
  assert.deepEqual((await call("POST", "/trips", {})).data.participants, []);
});

test("빼기·나가기: 대표는 남을, 성인은 자기만. 아이를 빼거나 보호자가 나가면 아이 프로필을 지우고, 대표가 나가면 그룹이 없어진다", async () => {
  const dad = await person("아빠");
  const mom = await person("엄마");
  const aunt = await person("이모");
  const fam = await family(dad);
  const code = await invite(fam, dad);
  for (const who of [mom, aunt]) await joinGroup(code, who);
  const kid = await child(fam, dad, "서아");
  const momsKid = await child(fam, mom, "도윤");
  const auntsKid = await child(fam, aunt, "하준");
  const remove = (who, target) => call("DELETE", `/groups/${fam.id}/members/${target}`, undefined, who.token);
  const exists = async (id) => (await profilesDb().query("SELECT 1 FROM profiles WHERE id = $1", [id])).rowCount === 1;

  assert.equal((await remove(mom, aunt.id)).status, 403, "성인은 다른 성인을 못 뺌");
  assert.equal((await remove(mom, dad.id)).status, 403, "대표는 본인만 나감");
  assert.equal((await remove(mom, kid.profileId)).status, 403, "남의 아이는 대표나 보호자만");
  assert.equal((await remove(dad, "00000000-0000-0000-0000-000000000000")).status, 404);

  // 사진: 같은 그룹 구성원은 서로의 사진을 본다(아이 포함). 그룹을 떠나면 다시 404
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await fetch(`${base}/api/profiles/me/photo`, { method: "PUT", headers: { authorization: `Bearer ${aunt.token}` }, body: png });
  const photo = await call("GET", `/profiles/${aunt.id}/photo`, undefined, mom.token);
  assert.deepEqual([photo.status, photo.data], [200, png]);

  assert.equal((await remove(aunt, aunt.id)).status, 204, "성인은 스스로 나감");
  assert.equal(await exists(auntsKid.profileId), false, "나간 사람이 보호자인 아이도 함께 지움");
  assert.equal(await exists(aunt.id), true, "나간 사람의 프로필은 그대로");
  assert.equal((await call("GET", `/profiles/${aunt.id}/photo`, undefined, mom.token)).status, 404, "그룹을 떠나면 사진도 못 봄");

  assert.equal((await remove(mom, momsKid.profileId)).status, 204, "보호자는 자기 아이를 뺌");
  assert.equal(await exists(momsKid.profileId), false);
  assert.equal((await remove(dad, mom.id)).status, 204, "대표는 성인을 뺌");
  assert.deepEqual((await call("GET", "/groups", undefined, mom.token)).data, { items: [] });

  // 아이가 탔던 여행은 프로필 지우기와 같게 정리된다
  await call("PUT", `/groups/${fam.id}/seats`, { seats: { [kid.profileId]: "ROW_2_LEFT" } }, dad.token);
  const trip = (await call("POST", "/trips", { groupId: fam.id }, dad.token)).data;
  assert.equal((await remove(dad, dad.id)).status, 204, "대표가 나가면 그룹이 없어짐");
  assert.equal(await exists(kid.profileId), false, "그룹의 아이도 지움");
  assert.deepEqual((await call("GET", "/groups", undefined, dad.token)).data, { items: [] });
  const after = (await call("GET", `/trips/${trip.code}`)).data;
  assert.deepEqual([after.participants.map((p) => p.profileId), after.generation], [[dad.id], 2]);
  assert.equal((await profilesDb().query("SELECT count(*)::int AS n FROM invites WHERE group_id = $1", [fam.id])).rows[0].n, 0);
});

test("대표가 프로필을 지우면 그룹과 그룹의 아이(다른 보호자의 아이 포함)도 지운다", async () => {
  const dad = await person("아빠");
  const mom = await person("엄마");
  const fam = await family(dad);
  await joinGroup(await invite(fam, dad), mom);
  const momsKid = await child(fam, mom, "도윤");
  assert.equal((await voice(fam, momsKid.profileId, mom)).status, 200);
  assert.equal((await call("DELETE", "/profiles/me", undefined, dad.token)).status, 204);
  const left = await profilesDb().query("SELECT id FROM profiles WHERE id = ANY($1::uuid[])", [[dad.id, mom.id, momsKid.profileId]]);
  assert.deepEqual(left.rows.map((r) => r.id), [mom.id]);
  assert.equal((await profilesDb().query("SELECT count(*)::int AS n FROM voice_prints WHERE profile_id = $1", [momsKid.profileId])).rows[0].n, 0, "아이 목소리 값도 함께");
  assert.deepEqual((await call("GET", "/groups", undefined, mom.token)).data, { items: [] });
});
