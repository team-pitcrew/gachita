// 같이타 API 서버. Node 22 표준 http와 Postgres 드라이버(pg) 하나만 쓴다.
// 한 프로세스가 API(/api)와 웹앱(frontend/web)을 같이 내보낸다. 경로와 형식은 docs/api/openapi.yaml에 있다.
//
// ponytail: 여행 하나를 JSONB 문서 한 줄로 저장한다. 바꿀 때는 그 줄을 잠그고 통째로 다시 쓴다.
//           여행을 가로질러 조회할 일이 생기면 참가자·부탁을 표로 나눈다.
// ponytail: 프로필 토큰이 없는 손님도 여행 코드만 알면 참가하고 고칠 수 있다.
//           공개 범위를 좁혀야 하면 참가자마다 토큰을 준다.
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { profilesDb, tripsDb } from "./db.js";
import { googleIdentity } from "./providers/google.js";

const WEB = fileURLToPath(new URL("../../frontend/web/", import.meta.url));
const TRIPS_SQL = fileURLToPath(new URL("trips.sql", import.meta.url));
const PROFILES_SQL = fileURLToPath(new URL("profiles.sql", import.meta.url));
const LINKS_SQL = fileURLToPath(new URL("profiles-2-links.sql", import.meta.url));
const UTTERANCES_SQL = fileURLToPath(new URL("trips-2-utterances.sql", import.meta.url));
const ALBUM_SQL = fileURLToPath(new URL("profiles-3-moments.sql", import.meta.url));
const TTL_MS = 48 * 60 * 60 * 1000; // 기획서 v4가 초기 제안으로 적은 보관 기간
const MAX_BODY = 10_000;
// ponytail: 여행 하나의 발화는 2만 줄까지(3시간 여행 ≈ 2,500줄). 48시간 지우기 한 번이 2초 제한(T26) 안에 끝나게 묶는다.
const MAX_TRIP_UTTERANCES = 20_000;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 0·O·1·I·L은 헷갈려서 뺌

// 좌석 이름은 Pleos Vehicle SDK의 SeatArea와 같게 둔다. 차량 앱이 그대로 넘긴다.
// 프로필은 선호를 자리 종류(운전석·조수석·뒷자리)별로 따로 가진다.
const ROLE = { ROW_1_LEFT: "driver", ROW_1_RIGHT: "passenger", ROW_2_LEFT: "rear", ROW_2_CENTER: "rear", ROW_2_RIGHT: "rear" };
export const SEATS = Object.keys(ROLE);
const ROLES = ["driver", "passenger", "rear"];
const TRIP_STATUS = ["boarding", "driving", "parked", "ended"];
const WHEN = ["now", "return", "before_arrival", "after_parking"];
// 부탁의 상태 흐름: 기억(held) → 제안(proposed) → 수락(accepted) → 내비 반영 확인(reflected) → 완료(done).
// 내비 요청이 실패하면 accepted에서 held로 돌아가 부탁이 남는다.
const NEXT = {
  held: ["proposed", "done", "cancelled"],
  proposed: ["accepted", "held", "cancelled"],
  accepted: ["reflected", "held", "cancelled"],
  reflected: ["done", "cancelled"],
  done: [],
  cancelled: [],
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const fail = (status, error) => {
  throw { status, error };
};
const text = (v, max, name) =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : fail(400, `${name}: 글자 1~${max}자`);
const num = (v, min, max, name) =>
  typeof v === "number" && v >= min && v <= max ? v : fail(400, `${name}: ${min}~${max} 사이 숫자`);
const int = (v, min, max, name) => (Number.isInteger(v) ? num(v, min, max, name) : fail(400, `${name}: 정수`));
const oneOf = (v, list, name) => (list.includes(v) ? v : fail(400, `${name}: ${list.join(", ")} 중 하나`));
const bool = (v, name) => (typeof v === "boolean" ? v : fail(400, `${name}: true 또는 false`));
const obj = (v, name) => (v && typeof v === "object" && !Array.isArray(v) ? v : fail(400, `${name}: 객체`));

// 차마다 지원 범위가 다르다. 여기서는 넓게 받고, 차량 앱이 지원 범위에 맞춰 줄인다.
const prefs = (p, name = "prefs") => ({
  tempC: num(p.tempC ?? 22, 16, 30, `${name}.tempC`),
  heat: int(p.heat ?? 0, 0, 3, `${name}.heat`),
  vent: int(p.vent ?? 0, 0, 3, `${name}.vent`),
});
const rolePrefs = (p, base = {}) =>
  Object.fromEntries(ROLES.map((r) => [r, prefs({ ...base[r], ...obj(p[r] ?? {}, `prefs.${r}`) }, `prefs.${r}`)]));

const everyoneConsents = (trip) => trip.participants.length > 0 && trip.participants.every((p) => p.consent);
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
const tokenHash = (token) => createHash("sha256").update(token).digest();

export async function migrate() {
  // 저장소마다 제 표를 만든다. 두 주소가 같으면 한 DB에 둘 표가 생긴다.
  // profiles-2부터는 profiles.sql을 고치지 않고 번호 붙은 마이그레이션을 쌓는다.
  await tripsDb().query(await readFile(TRIPS_SQL, "utf8"));
  await tripsDb().query(await readFile(UTTERANCES_SQL, "utf8"));
  await profilesDb().query(await readFile(PROFILES_SQL, "utf8"));
  await profilesDb().query(await readFile(LINKS_SQL, "utf8"));
  await profilesDb().query(await readFile(ALBUM_SQL, "utf8"));
}

async function readBody(req, limit = MAX_BODY) {
  let raw = "";
  let size = 0;
  req.setEncoding("utf8"); // 조각 경계에 걸친 한글(3바이트)을 깨뜨리지 않는다
  for await (const chunk of req) {
    raw += chunk;
    size += Buffer.byteLength(chunk); // 한도는 글자 수가 아니라 바이트로 센다
    if (size > limit) fail(413, "본문이 너무 큼");
  }
  let v;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    fail(400, "JSON이 아님");
  }
  return obj(v, "본문");
}

// profiles 표의 한 줄을 API가 돌려주는 프로필 모양으로 바꾼다.
const asProfile = (r) => ({ id: r.id, name: r.name, prefs: r.prefs, consentDefault: r.consent_default, links: r.provider ? [r.provider] : [] });

// 여행 문서의 참가자를 API가 돌려주는 모양으로 바꾼다. 참가자 토큰 해시는 절대 나가지 않는다.
const asParticipant = ({ tokenHash, ...p }) => p;
const tripView = (trip) => ({ ...trip, participants: trip.participants.map(asParticipant) });

// 참가자 토큰(ADR-0007·docs/api/voice.md). 여행·참가에 묶이고 문서에는 해시만 남는다.
// 프로필 토큰과 별개다 — 발화 올리기·기록본 같은 음성 경로의 인증에 쓴다.
const participantOf = (req, trip) => {
  const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization ?? "");
  const p = m && trip.participants.find((x) => x.tokenHash === tokenHash(m[1]).toString("hex"));
  return p ?? fail(401, "참가자 토큰이 필요함");
};

// 동의 세대를 올리고 옛 세대의 발화를 지운다(ADR-0007).
// 동의 철회 뒤에 늦게 올라온 옛 세대 발화는 받은 것으로만 치고 저장하지 않는다(POST /utterances).
async function bumpGeneration(trip, client) {
  trip.generation = (trip.generation ?? 1) + 1;
  await client.query("DELETE FROM utterances WHERE trip_code = $1 AND generation < $2", [trip.code, trip.generation]);
}

// utterances 표의 한 줄을 API가 돌려주는 발화 모양으로 바꾼다. 비어 있는 칸은 아예 안 넣는다.
const asUtterance = (r) => ({
  device: r.device,
  seq: Number(r.seq),
  at: Number(r.at),
  text: r.text,
  seatArea: r.seat_area,
  ...(r.profile_id ? { profileId: r.profile_id } : {}),
  ...(r.confidence !== null ? { confidence: r.confidence } : {}),
  ...(r.lat !== null ? { lat: r.lat, lng: r.lng } : {}),
});

async function profileById(id) {
  const { rows } = await profilesDb().query("SELECT id, name, prefs, consent_default, provider FROM profiles WHERE id = $1", [id]);
  return asProfile(rows[0]);
}

// Authorization: Bearer <토큰>. 머리말이 없으면 null(손님), 틀린 토큰이면 401.
async function profileOf(req) {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header);
  const { rows } = m ? await profilesDb().query("SELECT id, name, prefs, consent_default, provider FROM profiles WHERE token_hash = $1", [tokenHash(m[1])]) : { rows: [] };
  if (!rows[0]) fail(401, "알 수 없는 프로필 토큰");
  return asProfile(rows[0]);
}

async function profiles(req, seg, b) {
  const m = req.method;
  if (!seg[0]) {
    if (m !== "POST") fail(405, "POST만 됨");
    const token = randomBytes(32).toString("base64url");
    const p = {
      id: randomUUID(),
      name: text(b.name, 20, "name"),
      prefs: rolePrefs(obj(b.prefs ?? {}, "prefs")),
      consentDefault: b.consentDefault === undefined ? false : bool(b.consentDefault, "consentDefault"),
    };
    await profilesDb().query("INSERT INTO profiles (id, token_hash, name, prefs, consent_default) VALUES ($1, $2, $3, $4, $5)", [p.id, tokenHash(token), p.name, p.prefs, p.consentDefault]);
    return [201, { ...p, links: [], token }]; // 토큰은 이때 한 번만 준다. 서버에는 해시만 남는다.
  }
  if (seg[0] !== "me") fail(404, "없는 경로");
  if (seg[1] === "links" && seg[2] === "google") return googleLink(req, m, b);
  if (seg[1] === "feed" && !seg[2]) {
    // 자기 피드: 발화(여행이 살아 있는 동안)와 장면 앨범(여행이 닫힌 뒤에도 남는 복사본)을
    // 여행을 가로질러 최신순으로 합친다. 두 저장소를 함께 읽는다(T23 구조, ADR-0014).
    if (m !== "GET") fail(405, "GET만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const utterances = await tripsDb().query(
      `SELECT u.trip_code, u.at, u.text, u.seat_area FROM utterances u
       JOIN trips t ON t.code = u.trip_code
       WHERE u.profile_id = $1 AND t.created_at > now() - interval '48 hours'
       ORDER BY u.at DESC LIMIT 100`,
      [me.id]
    );
    const moments = await profilesDb().query(
      "SELECT id, trip_code, at, lat, lng, label FROM profile_moments WHERE profile_id = $1 ORDER BY at DESC LIMIT 100",
      [me.id]
    );
    const items = [
      ...utterances.rows.map((r) => ({ kind: "utterance", tripCode: r.trip_code, at: Number(r.at), text: r.text, seatArea: r.seat_area })),
      ...moments.rows.map((r) => ({ kind: "moment", id: r.id, tripCode: r.trip_code, at: Number(r.at), label: r.label, ...(r.lat !== null ? { lat: r.lat, lng: r.lng } : {}) })),
    ].sort((a, b) => b.at - a.at);
    return [200, { items: items.slice(0, 100) }];
  }
  if (seg[1] === "moments" && seg[2] && !seg[3]) {
    // 앨범에 남은 장면 복사본을 지운다. 여행의 moments에는 영향이 없다.
    if (m !== "DELETE") fail(405, "DELETE만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const { rowCount } = await profilesDb().query("DELETE FROM profile_moments WHERE id = $1 AND profile_id = $2", [seg[2], me.id]);
    if (!rowCount) fail(404, "앨범에 없는 장면");
    return [204];
  }
  if (seg[1]) fail(404, "없는 경로");
  if (m !== "GET" && m !== "PATCH" && m !== "DELETE") fail(405, "GET, PATCH, DELETE만 됨");
  const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
  if (m === "GET") return [200, me];
  if (m === "DELETE") {
    await profilesDb().query("DELETE FROM profile_moments WHERE profile_id = $1", [me.id]); // 앨범도 함께 지운다
    await profilesDb().query("DELETE FROM profiles WHERE id = $1", [me.id]);
    return [204];
  }
  const next = {
    id: me.id,
    name: b.name === undefined ? me.name : text(b.name, 20, "name"),
    prefs: b.prefs === undefined ? me.prefs : rolePrefs(obj(b.prefs, "prefs"), me.prefs),
    consentDefault: b.consentDefault === undefined ? me.consentDefault : bool(b.consentDefault, "consentDefault"),
    links: me.links,
  };
  await profilesDb().query("UPDATE profiles SET name = $2, prefs = $3, consent_default = $4, updated_at = now() WHERE id = $1", [me.id, next.name, next.prefs, next.consentDefault]);
  return [200, next];
}

// 구글 계정 연결(ADR-0006). 프로필 토큰과 함께 오면 내 프로필에 묶고,
// 토큰 없이 오면 계정의 프로필을 찾아 들어가거나 새로 만든다.
// 토큰은 해시만 남으니 찾아 들어갈 때는 새로 발급한다(이전 기기의 토큰은 못 쓰게 됨).
// 갱신 자격은 마지막 순간에 다시 본다 — 앞서 본 연결이 그 사이에 바뀌어도 오래된 계정으로
// 토큰을 받아 가지 못하게 한다(리뷰 재현). 동시 첫 로그인은 유일 색인 위반(23505)이 막아 준다.
const isTaken = (e) => e?.code === "23505";

// 찾아 들어가기의 토큰 갱신. 연결이 지금도 이 계정인지 UPDATE 조건으로 다시 확인한다.
// 조건이 어긋나면 0행 — 테스트가 이 상황을 결정적으로 만들기 위해 직접 부른다.
// profileId가 없으면 계정으로 프로필을 찾아 갱신한다(동시 첫 로그인 23505 뒤 재시도).
export async function rotateGoogleToken(profileId, hash, providerUserId) {
  const { rows } = await profilesDb().query(
    `UPDATE profiles SET token_hash = $1, updated_at = now()
     WHERE provider = 'google' AND provider_user_id = $2 ${profileId ? "AND id = $3" : ""}
     RETURNING id, name, prefs, consent_default, provider`,
    profileId ? [hash, providerUserId, profileId] : [hash, providerUserId]
  );
  return rows[0] ?? null;
}

async function googleLink(req, m, b) {
  if (m === "POST") {
    const identity = await googleIdentity(text(b.code, 500, "code"), text(b.redirectUri, 500, "redirectUri"));
    const db = profilesDb();
    const { rows: found } = await db.query("SELECT id FROM profiles WHERE provider = 'google' AND provider_user_id = $1", [identity.providerUserId]);
    const me = await profileOf(req);
    if (me) {
      if (found[0] && found[0].id !== me.id) fail(409, "이미 다른 프로필에 연결된 구글 계정");
      // 묶는 순간 다른 프로필이 같은 계정을 가져가면 색인이 막는다(23505) → 409로 바꾼다.
      await db.query("UPDATE profiles SET provider = 'google', provider_user_id = $2, updated_at = now() WHERE id = $1", [me.id, identity.providerUserId]).catch((e) => {
        if (isTaken(e)) fail(409, "이미 다른 프로필에 연결된 구글 계정");
        throw e;
      });
      return [200, await profileById(me.id)];
    }
    const token = randomBytes(32).toString("base64url");
    if (found[0]) {
      // 조회와 갱신 사이에 연결이 바뀌었으면 0행이 돌아온다. 이전 계정의 요청은 토큰을
      // 받지 못하고, 있던 프로필을 새로 만드는 길로 넘어가지도 않는다.
      const rotated = await rotateGoogleToken(found[0].id, tokenHash(token), identity.providerUserId);
      if (!rotated) fail(401, "구글 연결이 바뀌었어요. 다시 로그인해 주세요");
      return [200, { ...asProfile(rotated), token }];
    }
    const p = { id: randomUUID(), name: identity.name, prefs: rolePrefs({}), consentDefault: false };
    try {
      await db.query("INSERT INTO profiles (id, token_hash, name, prefs, consent_default, provider, provider_user_id) VALUES ($1, $2, $3, $4, $5, 'google', $6)", [p.id, tokenHash(token), p.name, p.prefs, p.consentDefault, identity.providerUserId]);
    } catch (e) {
      // 동시 첫 로그인: 먼저 들어온 요청이 이미 프로필을 만들었다(23505). 그 계정의 프로필로 들어간다.
      if (!isTaken(e)) throw e;
      const rotated = await rotateGoogleToken(null, tokenHash(token), identity.providerUserId);
      if (!rotated) fail(409, "구글 계정 연결이 경합 중이에요. 다시 시도해 주세요");
      return [200, { ...asProfile(rotated), token }];
    }
    return [201, { ...p, links: ["google"], token }];
  }
  if (m === "DELETE") {
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const { rowCount } = await profilesDb().query("UPDATE profiles SET provider = '', provider_user_id = '', updated_at = now() WHERE id = $1 AND provider = 'google'", [me.id]);
    if (!rowCount) fail(404, "연결된 구글 계정이 없음");
    return [204];
  }
  fail(405, "POST, DELETE만 됨");
}

// 여행 한 줄을 읽어 fn에 넘긴다. 바꾸는 요청이면 그 줄을 잠그고, 끝나면 문서를 다시 쓴다.
async function withTrip(code, write, fn) {
  const client = await tripsDb().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT doc, created_at FROM trips WHERE code = $1 ${write ? "FOR UPDATE" : ""}`, [String(code).toUpperCase()]);
    if (!rows[0]) fail(404, "없는 여행 코드");
    if (Date.now() - rows[0].created_at.getTime() > TTL_MS) fail(404, "보관 기간이 지난 여행");
    const trip = rows[0].doc;
    const before = trip.version;
    const result = await fn(trip, client);
    if (trip.version !== before) await client.query("UPDATE trips SET doc = $2 WHERE code = $1", [trip.code, trip]);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function trips(req, [code, sub, id], b, query) {
  const m = req.method;
  if (!code) {
    if (m !== "POST") fail(405, "POST만 됨");
    const trip = {
      code: "",
      title: b.title === undefined ? "" : text(b.title, 40, "title"),
      status: "boarding",
      recording: false,
      generation: 1, // 동의 세대(ADR-0007). 동의 철회로 올라간다.
      participants: [],
      requests: [],
      moments: [],
      version: 1,
      createdAt: Date.now(),
    };
    // 48시간 지난 여행과 그 발화·확인 순번을 한 문장으로 지운다. 지운 여행의 코드로만 찾으니(기본 키 앞부분)
    // 발화 표 전체를 훑지 않는다 — 질의 하나는 2초에서 끊긴다(T26).
    // 한 번에 여행 5개(발화 최대 10만 줄)까지. 여행을 만들 때마다 도니 밀린 것도 곧 따라잡는다.
    // 치우기는 여행 만들기를 막지 않는다 — 실패하면 다음 여행을 만들 때 다시 한다.
    await tripsDb()
      .query(`WITH gone AS (DELETE FROM trips WHERE code IN (SELECT code FROM trips WHERE created_at < now() - interval '48 hours' LIMIT 5) RETURNING code),
        u AS (DELETE FROM utterances WHERE trip_code IN (SELECT code FROM gone))
        DELETE FROM utterance_acks WHERE trip_code IN (SELECT code FROM gone)`)
      .catch((e) => console.error("묵은 여행 치우기 실패(다음에 다시):", e.message));
    for (;;) {
      trip.code = newCode();
      const { rowCount } = await tripsDb().query("INSERT INTO trips (code, doc) VALUES ($1, $2) ON CONFLICT DO NOTHING", [trip.code, trip]);
      if (rowCount) return [201, trip];
    }
  }
  const profile = sub === "participants" && m === "POST" && !id ? await profileOf(req) : null;
  return withTrip(code, m !== "GET", (trip, client) => handle(trip, { req, m, sub, id, b, query, profile }, client));
}

async function handle(trip, { req, m, sub, id, b, query, profile }, client) {
  const changed = (status, data) => {
    trip.version++;
    return [status, data];
  };
  // 응답에 여행 문서를 통째로 담을 때는 버전을 올린 뒤에 담는다(changed가 문서를 고친 뒤의 모습).
  const changedView = (status) => {
    const out = changed(status);
    out[1] = tripView(trip);
    return out;
  };

  if (!sub) {
    if (m === "GET") return query.get("v") === String(trip.version) ? [304] : [200, tripView(trip)];
    if (m !== "PATCH") fail(405, "GET, PATCH만 됨");
    if (b.status !== undefined) {
      trip.status = oneOf(b.status, TRIP_STATUS, "status");
      // 동의가 모이면 주행과 함께 기록을 시작하고, 주차·종료에서 그 구간을 마감한다.
      trip.recording = trip.status === "driving" && everyoneConsents(trip);
    }
    if (b.recording !== undefined) {
      if (bool(b.recording, "recording") && trip.status !== "driving") fail(409, "주행 중에만 기록함");
      if (b.recording && !everyoneConsents(trip)) fail(409, "동의하지 않은 탑승자가 있음");
      trip.recording = b.recording;
    }
    return changedView(200);
  }

  if (sub === "participants") {
    const seatFree = (seat, self) => trip.participants.every((p) => p === self || p.seat !== seat);
    if (m === "POST" && !id) {
      // 같은 프로필이 다시 참가하면 이미 있는 참가자를 돌려준다(폰에서 다시 열었을 때).
      // 참가자 토큰은 문서에 해시만 남으니 다시 참가할 때마다 새로 만들어 준다(옛 토큰은 못 쓰게 됨).
      const again = profile && trip.participants.find((p) => p.profileId === profile.id);
      if (again) {
        const token = randomBytes(32).toString("base64url");
        again.tokenHash = tokenHash(token).toString("hex");
        return changed(200, { ...asParticipant(again), token });
      }
      const seat = oneOf(b.seat, SEATS, "seat");
      const p = profile
        ? { name: profile.name, prefs: profile.prefs[ROLE[seat]], consent: b.consent === undefined ? profile.consentDefault : bool(b.consent, "consent"), profileId: profile.id }
        : { name: text(b.name, 20, "name"), prefs: prefs(obj(b.prefs ?? {}, "prefs")), consent: bool(b.consent, "consent") };
      if (!seatFree(seat)) fail(409, "이미 다른 사람이 앉은 자리");
      // 참가자 토큰(프로필·손님 모두)은 이때 한 번씩 준다. 음성 경로의 인증에 쓴다(ADR-0007).
      const token = randomBytes(32).toString("base64url");
      Object.assign(p, { id: randomUUID().slice(0, 8), seat, tokenHash: tokenHash(token).toString("hex") });
      trip.participants.push(p);
      if (!p.consent) trip.recording = false; // 새 탑승자의 동의를 확인할 때까지 멈춘다
      return changed(201, { ...asParticipant(p), token });
    }
    if (m === "PATCH" && id) {
      const p = trip.participants.find((x) => x.id === id) ?? fail(404, "없는 참가자");
      if (b.seat !== undefined) {
        if (!seatFree(oneOf(b.seat, SEATS, "seat"), p)) fail(409, "이미 다른 사람이 앉은 자리");
        p.seat = b.seat;
        // 프로필로 참가한 사람은 옮긴 자리의 선호를 프로필 저장소에서 다시 불러온다.
        // 여행 잠금과는 다른 저장소라 이 읽기에는 원자성이 없다. 값을 읽기만 하니 견딘다.
        const { rows } = p.profileId ? await profilesDb().query("SELECT prefs FROM profiles WHERE id = $1", [p.profileId]) : { rows: [] };
        if (rows[0]) p.prefs = rows[0].prefs[ROLE[p.seat]];
      }
      if (b.prefs !== undefined) p.prefs = prefs({ ...p.prefs, ...obj(b.prefs, "prefs") });
      if (b.consent !== undefined) {
        const was = p.consent;
        p.consent = bool(b.consent, "consent");
        if (!p.consent) trip.recording = false;
        // 켜져 있던 동의를 끊을 때만 세대를 올린다. 받아 둔 발화도 못 쓰게 한다(ADR-0007). 이미 꺼진 것을 다시 꺼도 그대로.
        if (was && !p.consent) await bumpGeneration(trip, client);
      }
      return changed(200, asParticipant(p));
    }
    fail(405, "POST /participants, PATCH /participants/:id만 됨");
  }

  if (sub === "requests") {
    if (m === "POST" && !id) {
      if (trip.requests.length >= 50) fail(409, "부탁이 너무 많음");
      if (!trip.participants.some((p) => p.id === b.by)) fail(400, "by: 이 여행의 참가자 id");
      const r = {
        id: randomUUID().slice(0, 8),
        by: b.by,
        text: text(b.text, 200, "text"),
        when: oneOf(b.when ?? "now", WHEN, "when"),
        status: "held",
        createdAt: Date.now(),
      };
      trip.requests.push(r);
      return changed(201, r);
    }
    if (m === "PATCH" && id) {
      const r = trip.requests.find((x) => x.id === id) ?? fail(404, "없는 부탁");
      if (!NEXT[r.status].includes(b.status)) fail(409, `${r.status}에서 갈 수 있는 상태: ${NEXT[r.status].join(", ") || "없음"}`);
      r.status = b.status;
      return changed(200, r);
    }
    fail(405, "POST /requests, PATCH /requests/:id만 됨");
  }

  if (sub === "moments" && m === "POST" && !id) {
    // 대화가 재미있던 순간의 시각과 위치. 클립과 주행 기억 지도가 이 기록을 쓴다.
    // 위치 없는 장면도 저장한다(ADR-0007): 목록에는 있고 지도에는 없다. 좌표는 둘 다 있거나 둘 다 없음만 받는다.
    if (trip.moments.length >= 500) fail(409, "장면이 너무 많음");
    const hasLat = b.lat !== undefined;
    if (hasLat !== (b.lng !== undefined)) fail(400, "lat, lng: 둘 다 있거나 둘 다 없음");
    // 고른 사람은 본문이 아니라 요청의 참가자 토큰으로 정한다. 토큰 없이 남긴 장면은 여행에만 남는다.
    const picker = req.headers.authorization ? participantOf(req, trip) : null;
    const now = Date.now();
    const moment = {
      id: randomUUID().slice(0, 8),
      at: b.at === undefined ? now : int(b.at, trip.createdAt, now + 60_000, "at"), // 통신이 끊겼다가 나중에 올리는 경우
      ...(hasLat ? { lat: num(b.lat, -90, 90, "lat"), lng: num(b.lng, -180, 180, "lng") } : {}),
      label: b.label === undefined ? "" : text(b.label, 60, "label"),
    };
    trip.moments.push(moment);
    // 사람이 장면으로 확정하면 고른 사람의 프로필 앨범에 복사해 남긴다(ADR-0014).
    // 여행 잠금과 다른 저장소라 이 쓰기에는 원자성이 없다. 같은 장면 id로는 다시 복사되지 않는다.
    if (picker?.profileId) {
      await profilesDb().query(
        `INSERT INTO profile_moments (id, profile_id, trip_code, at, lat, lng, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (profile_id, id) DO NOTHING`,
        [moment.id, picker.profileId, trip.code, moment.at, moment.lat ?? null, moment.lng ?? null, moment.label]
      );
    }
    return changed(201, moment);
  }

  if (sub === "utterances") {
    // 발화 묶음 올리기·기록본 동기화(ADR-0007·ADR-0014). 인증은 참가자 토큰이다.
    if (m !== "GET" && m !== "POST" && m !== "DELETE") fail(405, "GET, POST, DELETE만 됨");
    const caller = participantOf(req, trip);
    if (m === "POST") {
      // 세대는 발화마다 받는다(묶음에 하나만 주면 모든 발화가 그 값). 지금보다 옛 세대의 발화는 동의 철회 전에
      // 받아 적은 것이라 저장하지 않되 받은 것으로 쳐서 확인 순번에 넣는다. 409로 돌려보내면 확인 순번이
      // 그 앞에서 멈춰 차량이 같은 묶음을 끝없이 다시 보낸다(ADR-0007).
      const current = trip.generation ?? 1;
      const device = text(b.device, 40, "device");
      // 기기 이름은 처음 올린 참가자의 것이다. 다른 참가자가 같은 이름으로 순번을 먼저 차지해 진짜 발화를 밀어내지 못하게.
      const { rows: ack } = await client.query("SELECT last_seq, participant_id FROM utterance_acks WHERE trip_code = $1 AND device = $2", [trip.code, device]);
      if (ack[0] && ack[0].participant_id !== caller.id) fail(403, "다른 참가자가 올리는 기기");
      const items = Array.isArray(b.items) ? b.items : fail(400, "items: 배열");
      if (items.length > 500) fail(400, "items: 한 번에 500개까지");
      // 화자(profileId)는 받지 않는다. 서버의 화자 대조(T38)만 붙인다 — 올리는 쪽이 남의 이름을 붙이지 못하게.
      const rows = items.map((it, i) => {
        const u = obj(it, `items[${i}]`);
        const hasLat = u.lat !== undefined;
        if (hasLat !== (u.lng !== undefined)) fail(400, `items[${i}].lat, lng: 둘 다 있거나 둘 다 없음`);
        return [
          trip.code,
          device,
          int(u.seq, 1, 1_000_000_000, `items[${i}].seq`),
          int(u.at, 0, Date.now() + 600_000, `items[${i}].at`),
          text(u.text, 500, `items[${i}].text`),
          u.seatArea == null ? null : oneOf(u.seatArea, SEATS, `items[${i}].seatArea`), // 모르는 구역은 비워 둔다(T37)
          u.confidence === undefined ? null : num(u.confidence, 0, 1, `items[${i}].confidence`),
          hasLat ? num(u.lat, -90, 90, `items[${i}].lat`) : null,
          hasLat ? num(u.lng, -180, 180, `items[${i}].lng`) : null,
          int(u.generation ?? b.generation, 1, current, `items[${i}].generation`),
        ];
      });
      const fresh = rows.filter((r) => r[9] === current);
      const { rows: count } = await client.query("SELECT count(*)::int AS n FROM utterances WHERE trip_code = $1", [trip.code]);
      if (count[0].n + fresh.length > MAX_TRIP_UTTERANCES) fail(409, `이 여행의 발화가 한도(${MAX_TRIP_UTTERANCES}줄)에 닿음`);
      // 같은 (기기, 순번)은 다시 보내도 한 번만 남는다(멱등). 순서는 섞여도 좋다.
      for (let i = 0; i < fresh.length; i += 100) {
        const chunk = fresh.slice(i, i + 100);
        const values = chunk.map((_, j) => `(${Array.from({ length: 10 }, (_, k) => `$${j * 10 + k + 1}`).join(", ")})`).join(", ");
        await client.query(
          `INSERT INTO utterances (trip_code, device, seq, at, text, seat_area, confidence, lat, lng, generation)
           VALUES ${values} ON CONFLICT (trip_code, device, seq) DO NOTHING`,
          chunk.flat()
        );
      }
      // 빠짐없이 받은 마지막 순번을 돌려준다. 차량은 그 뒤만 다시 보낸다(ADR-0014).
      // 확인 순번은 발화 줄과 따로 둔다: 동의 철회나 글 지우기로 줄이 지워져도 뒤로 가지 않는다.
      let lastSeq = Number(ack[0]?.last_seq ?? 0);
      const { rows: seqs } = await client.query("SELECT seq FROM utterances WHERE trip_code = $1 AND device = $2 AND seq > $3", [trip.code, device, lastSeq]);
      const got = new Set([...rows.map((r) => r[2]), ...seqs.map((r) => Number(r.seq))]);
      while (got.has(lastSeq + 1)) lastSeq++;
      await client.query(
        `INSERT INTO utterance_acks (trip_code, device, participant_id, last_seq) VALUES ($1, $2, $3, $4)
         ON CONFLICT (trip_code, device) DO UPDATE SET last_seq = EXCLUDED.last_seq`,
        [trip.code, device, caller.id, lastSeq]
      );
      return [200, { lastSeq, generation: current }];
    }
    if (m === "GET") {
      if (!caller.consent) fail(403, "녹음에 동의한 참가자만 볼 수 있음");
      const device = query.get("device");
      const params = [trip.code];
      let where = "trip_code = $1";
      if (device) {
        params.push(device, int(Number(query.get("after") ?? 0), 0, 1_000_000_000, "after"));
        where += " AND device = $2 AND seq > $3";
      }
      const { rows } = await client.query(`SELECT device, seq, at, text, seat_area, profile_id, confidence, lat, lng FROM utterances WHERE ${where} ORDER BY at`, params);
      return [200, { generation: trip.generation ?? 1, recording: trip.recording, items: rows.map(asUtterance) }];
    }
    if (m === "DELETE") {
      // 자기 글 지우기. 프로필로 참가한 사람만, 자기 이름이 붙은 발화만 지운다. 세대는 올리지 않는다 —
      // 세대를 올리면 옛 세대 전부, 곧 그 여행의 모든 사람 글이 지워진다. 지운 줄의 순번은 이미 확인 순번 안이라
      // 차량이 다시 보내지 않는다.
      if (!caller.profileId) fail(403, "프로필로 참가한 사람의 글만 지울 수 있음");
      const { rowCount } = await client.query("DELETE FROM utterances WHERE trip_code = $1 AND profile_id = $2", [trip.code, caller.profileId]);
      return [200, { deleted: rowCount }];
    }
  }

  if (sub === "transcript") {
    // 기록본: 발화를 시간순으로, 부탁과 도착 할 일과 함께(T39).
    if (m !== "GET") fail(405, "GET만 됨");
    if (!participantOf(req, trip).consent) fail(403, "녹음에 동의한 참가자만 볼 수 있음"); // 이 여행의 허용된 참가자만 본다
    const { rows } = await client.query("SELECT device, seq, at, text, seat_area, profile_id, confidence, lat, lng FROM utterances WHERE trip_code = $1 ORDER BY at", [trip.code]);
    // 도착 할 일 뽑기(LLM)는 아직 구현 전이다. 기록본 모양을 미리 맞춰 둔다(ADR-0007).
    return [200, { generation: trip.generation ?? 1, utterances: rows.map(asUtterance), requests: trip.requests, todos: [] }];
  }

  fail(404, "없는 경로");
}

async function serveFile(path, res) {
  const file = normalize(join(WEB, path === "/" ? "index.html" : path));
  if (!file.startsWith(WEB)) fail(404, "없는 파일");
  const data = await readFile(file).catch(() => fail(404, "없는 파일"));
  res.writeHead(200, { "content-type": `${MIME[extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  res.end(data);
}

export const server = createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(data === undefined ? undefined : JSON.stringify(data));
  };
  try {
    const url = new URL(req.url, "http://localhost");
    const seg = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/healthz") {
      if (req.method !== "GET") fail(405, "GET만 됨");
      await Promise.all([tripsDb().query("SELECT 1"), profilesDb().query("SELECT 1")]); // 두 저장소 모두 닿는지 본다
      return send(200, { ok: true });
    }
    if (seg[0] === "api") {
      // 발화 묶음은 본문이 커서 그 경로만 따로 한도를 둔다(docs/api/voice.md).
      const big = seg[1] === "trips" && seg[3] === "utterances";
      const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req, big ? 1_000_000 : MAX_BODY) : {};
      if (seg[1] === "profiles") return send(...(await profiles(req, seg.slice(2), body)));
      if (seg[1] === "trips") return send(...(await trips(req, seg.slice(2), body, url.searchParams)));
      fail(404, "없는 경로");
    }
    if (req.method !== "GET") fail(405, "GET만 됨");
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      fail(400, "잘못된 주소");
    }
    await serveFile(path, res);
  } catch (e) {
    if (!e.status) console.error(e);
    send(e.status ?? 500, { error: e.error ?? "서버 오류" });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  await migrate();
  server.listen(port, () => console.log(`같이타 서버: http://localhost:${port}`));
}
