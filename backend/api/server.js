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
import { embed, matchThreshold, similarity, wavMono } from "./providers/voice.js";

const WEB = fileURLToPath(new URL("../../frontend/web/", import.meta.url));
const TRIPS_SQL = fileURLToPath(new URL("trips.sql", import.meta.url));
const PROFILES_SQL = fileURLToPath(new URL("profiles.sql", import.meta.url));
const LINKS_SQL = fileURLToPath(new URL("profiles-2-links.sql", import.meta.url));
const UTTERANCES_SQL = fileURLToPath(new URL("trips-2-utterances.sql", import.meta.url));
const ALBUM_SQL = fileURLToPath(new URL("profiles-3-moments.sql", import.meta.url));
const GROUPS_SQL = fileURLToPath(new URL("profiles-4-groups.sql", import.meta.url));
const VOICE_SQL = fileURLToPath(new URL("profiles-5-voice.sql", import.meta.url));
const INVITE_BASE = process.env.INVITE_BASE_URL ?? "https://gachita.mangowhois.ai/j"; // QR에 담는 초대 주소(ADR-0009·0010)
const PHOTO_MAX = 1_000_000; // 프로필 사진 상한. 형식은 매직 바이트로만 확인한다(다시 그리기는 T46 화면, ADR-0009 위험)
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
  await profilesDb().query(await readFile(GROUPS_SQL, "utf8"));
  await profilesDb().query(await readFile(VOICE_SQL, "utf8"));
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
const asProfile = (r) => ({
  id: r.id,
  name: r.name,
  prefs: r.prefs,
  consentDefault: r.consent_default,
  character: r.character ?? "",
  hasPhoto: Boolean(r.has_photo),
  links: r.provider ? [r.provider] : [],
});

// 기기 토큰을 하나 더 만든다(ADR-0009). 다른 기기의 토큰은 그대로다.
async function issueToken(profileId, device = "", token = randomBytes(32).toString("base64url")) {
  await profilesDb().query("INSERT INTO tokens (token_hash, profile_id, device) VALUES ($1, $2, $3)", [tokenHash(token), profileId, device]);
  return token;
}

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
  const { rows } = await profilesDb().query(
    "SELECT id, name, prefs, consent_default, provider, character, (photo IS NOT NULL) AS has_photo FROM profiles WHERE id = $1",
    [id]
  );
  return asProfile(rows[0]);
}

// Authorization: Bearer <토큰>. 머리말이 없으면 null(손님), 틀린 토큰이면 401.
// 토큰은 기기마다 하나씩(tokens 표, T45) — 한 프로필을 차량과 폰에서 함께 쓴다(ADR-0009).
// 옛 칸 profiles.token_hash도 본다: 배포 중 옛 파드가 만든 프로필이 다음 기동 전까지도 읽히게.
async function profileOf(req) {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header);
  const { rows } = m
    ? await profilesDb().query(
        `SELECT p.id, p.name, p.prefs, p.consent_default, p.provider, p.character, (p.photo IS NOT NULL) AS has_photo
         FROM profiles p WHERE p.id = (SELECT profile_id FROM tokens WHERE token_hash = $1) OR p.token_hash = $1`,
        [tokenHash(m[1])]
      )
    : { rows: [] };
  if (!rows[0]) fail(401, "알 수 없는 프로필 토큰");
  return asProfile(rows[0]);
}

// 이진 본문(프로필 사진). 크기만 지키고 형식은 매직 바이트로 판별한다.
async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, "본문이 너무 큼");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const photoType = (b) =>
  b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    ? "image/png"
    : b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
      ? "image/jpeg"
      : fail(400, "PNG 또는 JPEG만 됨");

async function profiles(req, seg, b) {
  const m = req.method;
  if (!seg[0]) {
    if (m !== "POST") fail(405, "POST만 됨");
    const p = {
      id: randomUUID(),
      name: text(b.name, 20, "name"),
      prefs: rolePrefs(obj(b.prefs ?? {}, "prefs")),
      consentDefault: b.consentDefault === undefined ? false : bool(b.consentDefault, "consentDefault"),
      character: b.character === undefined ? "" : text(b.character, 20, "character"),
    };
    // 첫 토큰은 옛 칸(token_hash)에도 적는다 — 이전 이미지로 되돌려도 이 프로필이 읽히게(칸을 지우는 PR에서 뺀다).
    const token = randomBytes(32).toString("base64url");
    await profilesDb().query("INSERT INTO profiles (id, token_hash, name, prefs, consent_default, character) VALUES ($1, $2, $3, $4, $5, $6)", [p.id, tokenHash(token), p.name, p.prefs, p.consentDefault, p.character]);
    await issueToken(p.id, b.device === undefined ? "" : text(b.device, 20, "device"), token);
    return [201, { ...p, hasPhoto: false, links: [], token }]; // 토큰은 이때 한 번만 준다. 서버에는 해시만 남는다.
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
       WHERE u.profile_id = $1 AND u.text <> '' AND t.created_at > now() - interval '48 hours'
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
  if (seg[1] === "tokens" && !seg[2]) {
    // 이 기기에 쓸 토큰을 하나 더 만든다(ADR-0009). 다른 기기의 토큰은 그대로다.
    if (m !== "POST") fail(405, "POST만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const device = b.device === undefined ? "" : text(b.device, 20, "device");
    const token = await issueToken(me.id, device);
    return [201, { token, device }];
  }
  if (seg[1] === "voice" && !seg[2]) {
    if (m !== "POST" && m !== "DELETE") fail(405, "POST, DELETE만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    return voicePrint(req, m, me.id);
  }
  if (seg[1] === "photo" && !seg[2]) {
    // 프로필 사진. 크기 상한과 형식(매직 바이트)만 확인해 그대로 둔다. 지금은 본인만 받아 간다(ADR-0009).
    if (m === "PUT") {
      const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
      const raw = await readRaw(req, PHOTO_MAX);
      const type = photoType(raw);
      await profilesDb().query("UPDATE profiles SET photo = $2, photo_type = $3, updated_at = now() WHERE id = $1", [me.id, raw, type]);
      return [204];
    }
    if (m === "GET") {
      const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
      const { rows } = await profilesDb().query("SELECT photo, photo_type FROM profiles WHERE id = $1", [me.id]);
      if (!rows[0]?.photo) fail(404, "사진이 없음");
      return [200, rows[0].photo, rows[0].photo_type]; // 이진 응답 — 서버 핸들러가 그대로 보낸다
    }
    if (m === "DELETE") {
      const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
      await profilesDb().query("UPDATE profiles SET photo = NULL, photo_type = '', updated_at = now() WHERE id = $1", [me.id]);
      return [204];
    }
    fail(405, "PUT, GET, DELETE만 됨");
  }
  if (seg[1]) fail(404, "없는 경로");
  if (m !== "GET" && m !== "PATCH" && m !== "DELETE") fail(405, "GET, PATCH, DELETE만 됨");
  const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
  if (m === "GET") return [200, me];
  if (m === "DELETE") {
    // 내가 대표인 그룹과, 내가 만든 계정 없는 구성원(아이)의 프로필도 함께 지운다(ADR-0009).
    await inProfilesTx(async (db) => {
      const { rows: owned } = await db.query("SELECT id FROM groups WHERE owner_id = $1", [me.id]);
      await deleteGroups(db, owned.map((r) => r.id));
      await deleteProfiles(db, [me.id]);
    });
    return [204];
  }
  const next = {
    id: me.id,
    name: b.name === undefined ? me.name : text(b.name, 20, "name"),
    prefs: b.prefs === undefined ? me.prefs : rolePrefs(obj(b.prefs, "prefs"), me.prefs),
    consentDefault: b.consentDefault === undefined ? me.consentDefault : bool(b.consentDefault, "consentDefault"),
    character: b.character === undefined ? me.character : text(b.character, 20, "character"),
    hasPhoto: me.hasPhoto,
    links: me.links,
  };
  await profilesDb().query("UPDATE profiles SET name = $2, prefs = $3, consent_default = $4, character = $5, updated_at = now() WHERE id = $1", [me.id, next.name, next.prefs, next.consentDefault, next.character]);
  return [200, next];
}

// 구글 계정 연결(ADR-0006). 프로필 토큰과 함께 오면 내 프로필에 묶고,
// 토큰 없이 오면 계정의 프로필을 찾아 들어가거나 새로 만든다.
// 찾아 들어가면 이 기기에 쓸 토큰을 하나 더 만든다(기기마다 토큰, ADR-0009) —
// 다른 기기의 토큰은 그대로다. 갱신 자격은 마지막 순간에 다시 본다 — 앞서 본 연결이
// 그 사이에 바뀌어도 오래된 계정으로 토큰을 받아 가지 못하게 한다(리뷰 재현).
// 동시 첫 로그인은 유일 색인 위반(23505)이 막아 준다.
const isTaken = (e) => e?.code === "23505";

// 찾아 들어가기 전에 연결이 지금도 이 계정인지 UPDATE 조건으로 다시 확인한다.
// 조건이 어긋나면 0행 — 테스트가 이 상황을 결정적으로 만들기 위해 직접 부른다.
// profileId가 없으면 계정으로 프로필을 찾는다(동시 첫 로그인 23505 뒤 재시도).
export async function verifyGoogleLink(profileId, providerUserId) {
  const { rows } = await profilesDb().query(
    `UPDATE profiles SET updated_at = now()
     WHERE provider = 'google' AND provider_user_id = $1 ${profileId ? "AND id = $2" : ""}
     RETURNING id, name, prefs, consent_default, provider, character, (photo IS NOT NULL) AS has_photo`,
    profileId ? [providerUserId, profileId] : [providerUserId]
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
      // 조회와 확인 사이에 연결이 바뀌었으면 0행이 돌아온다. 이전 계정의 요청은 토큰을
      // 받지 못하고, 있던 프로필을 새로 만드는 길로 넘어가지도 않는다.
      const current = await verifyGoogleLink(found[0].id, identity.providerUserId);
      if (!current) fail(401, "구글 연결이 바뀌었어요. 다시 로그인해 주세요");
      await issueToken(current.id, b.device === undefined ? "" : text(b.device, 20, "device"), token);
      return [200, { ...asProfile(current), token }];
    }
    const p = { id: randomUUID(), name: identity.name, prefs: rolePrefs({}), consentDefault: false, character: "" };
    try {
      await db.query("INSERT INTO profiles (id, token_hash, name, prefs, consent_default, character, provider, provider_user_id) VALUES ($1, $2, $3, $4, $5, '', 'google', $6)", [p.id, tokenHash(token), p.name, p.prefs, p.consentDefault, identity.providerUserId]);
    } catch (e) {
      // 동시 첫 로그인: 먼저 들어온 요청이 이미 프로필을 만들었다(23505). 그 계정의 프로필로 들어간다.
      if (!isTaken(e)) throw e;
      const current = await verifyGoogleLink(null, identity.providerUserId);
      if (!current) fail(409, "구글 계정 연결이 경합 중이에요. 다시 시도해 주세요");
      await issueToken(current.id, b.device === undefined ? "" : text(b.device, 20, "device"), token);
      return [200, { ...asProfile(current), token }];
    }
    await issueToken(p.id, b.device === undefined ? "" : text(b.device, 20, "device"), token);
    return [201, { ...p, hasPhoto: false, links: ["google"], token }];
  }
  if (m === "DELETE") {
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const { rowCount } = await profilesDb().query("UPDATE profiles SET provider = '', provider_user_id = '', updated_at = now() WHERE id = $1 AND provider = 'google'", [me.id]);
    if (!rowCount) fail(404, "연결된 구글 계정이 없음");
    return [204];
  }
  fail(405, "POST, DELETE만 됨");
}

// 목소리 등록·지우기(ADR-0019). 원본 음성은 대조용 값으로만 바꿔 저장하고 어디에도 남기지 않는다.
async function voicePrint(req, m, profileId) {
  if (m === "DELETE") {
    await profilesDb().query("DELETE FROM voice_prints WHERE profile_id = $1", [profileId]);
    return [204];
  }
  const { samples } = wavMono(await readRaw(req, 1_500_000)); // WAV 파싱 실패는 400으로 돌아온다
  const seconds = samples.length / 16000;
  // ponytail: 임베딩이 이벤트 루프에서 동기로 돈다(20초 ≈ 65 ms). 등록은 문장 몇 개면 되므로 20초로 묶는다.
  if (seconds < 1 || seconds > 20) fail(400, "등록 음성은 1~20초");
  const vector = embed(samples);
  // 본문을 받는 사이 프로필이 지워졌으면 외래 키가 막는다(23503) — 지워진 프로필의 값이 남지 않게.
  await profilesDb()
    .query(
      `INSERT INTO voice_prints (profile_id, vector, seconds) VALUES ($1, $2, $3)
       ON CONFLICT (profile_id) DO UPDATE SET vector = $2, seconds = $3, updated_at = now()`,
      [profileId, vector, seconds]
    )
    .catch((e) => (e?.code === "23503" ? fail(404, "없는 프로필") : Promise.reject(e)));
  return [200, { seconds: Math.round(seconds * 10) / 10, dims: vector.length }];
}

// 발화 대조(ADR-0008·0019): 발화 음성과 좌석 구역을 받아 등록된 목소리와 비교해
// 프로필과 확신도를 돌려준다. 확신이 낮으면 '모름'(profileId: null).
// 원본 음성은 저장하지 않고, 찾으면 그 발화 줄의 profile_id를 채운다(ADR-0014).
// 여행 문서를 바꾸지 않으므로 여행 줄을 잠그지 않는다 — 본문(최대 1 MB)을 받고 계산하는 동안
// 같은 여행의 동의 바꾸기를 막으면, 업로드가 느릴 때 동의 철회가 2초 제한(T26)에 걸려 실패한다.
async function voiceMatch(trip, req, query) {
  if (req.method !== "POST") fail(405, "POST만 됨");
  // 녹음에 동의한 참가자만 — 동의하지 않은 사람이 목소리로 남을 찾아보는 길이 되지 않게.
  const caller = participantOf(req, trip);
  if (!caller.consent) fail(403, "녹음에 동의한 참가자만 대조할 수 있음");
  const { samples } = wavMono(await readRaw(req, 1_000_000));
  const seconds = samples.length / 16000;
  // ponytail: 임베딩은 이벤트 루프에서 동기로 돈다(10초 ≈ 30 ms, 60초 ≈ 185 ms). 발화는 보통 2~4초라 10초로 묶는다.
  if (seconds < 0.5 || seconds > 10) fail(400, "발화 음성은 0.5~10초");
  // 후보: 그 좌석 구역에 앉은 프로필 참가자. 구역을 모르면(T37) 이 여행의 프로필 참가자 모두.
  const seatArea = query.get("seatArea") ? oneOf(query.get("seatArea"), SEATS, "seatArea") : null;
  const candidates = trip.participants.filter((p) => p.profileId && (!seatArea || p.seat === seatArea)).map((p) => p.profileId);
  const threshold = matchThreshold();
  const { rows: prints } = candidates.length
    ? await profilesDb().query("SELECT profile_id, vector FROM voice_prints WHERE profile_id = ANY($1)", [candidates])
    : { rows: [] };
  if (!prints.length) return [200, { profileId: null, confidence: 0, threshold, applied: false }];
  const vector = embed(samples);
  let best = null;
  let bestSim = -1;
  for (const r of prints) {
    const s = similarity(vector, r.vector);
    if (s > bestSim) {
      bestSim = s;
      best = r.profile_id;
    }
  }
  const matched = best && bestSim >= threshold ? best : null;
  let applied = false;
  if (matched && query.get("device") && query.get("seq")) {
    // 찾았으면 그 발화 줄의 profile_id를 채운다(ADR-0014). 발화가 아직 안 왔다면 채우지 않고 결과만 돌려준다.
    // 그 발화를 올린 기기(참가자)만, 아직 화자가 없는 줄에만 붙인다 — 남의 줄에 이름을 붙이거나 바꿔 지우지 못하게.
    const device = text(query.get("device"), 40, "device");
    const seq = int(Number(query.get("seq")), 1, 1_000_000_000, "seq");
    const { rowCount } = await tripsDb().query(
      `UPDATE utterances u SET profile_id = $2 FROM utterance_acks a
       WHERE u.trip_code = $1 AND u.device = $3 AND u.seq = $4 AND u.profile_id IS NULL
         AND a.trip_code = u.trip_code AND a.device = u.device AND a.participant_id = $5`,
      [trip.code, matched, device, seq, caller.id]
    );
    applied = rowCount > 0;
  }
  return [200, { profileId: matched, confidence: Math.round(bestSim * 1000) / 1000, threshold, applied }];
}

// 지우기는 프로필 DB의 한 트랜잭션에서 한다 — 중간에 실패해도 토큰만 지워지고 프로필이 남는 일이 없게.
async function inProfilesTx(fn) {
  const client = await profilesDb().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {}); // 끊긴 연결이면 되돌릴 것도 없다. 원래 오류를 가리지 않게
    throw e;
  } finally {
    client.release();
  }
}

// 프로필과 거기 딸린 것(앨범, 기기 토큰, 그룹 자리)을 지운다. 목소리 값은 외래 키로 함께 지워진다(ADR-0019). 그 프로필이 만든 아이 프로필도 함께 —
// 아이 프로필은 토큰이 없어 대표가 아니면 지울 사람이 없다(ADR-0009). 두 DB라 여행 쪽 발화는 48시간 시계로 지워진다.
async function deleteProfiles(db, ids) {
  const { rows } = await db.query("SELECT id FROM profiles WHERE managed_by = ANY($1::uuid[])", [ids]);
  const all = [...ids, ...rows.map((r) => r.id)];
  await db.query("DELETE FROM profile_moments WHERE profile_id = ANY($1::uuid[])", [all]);
  await db.query("DELETE FROM tokens WHERE profile_id = ANY($1::uuid[])", [all]);
  await db.query("DELETE FROM group_members WHERE profile_id = ANY($1::uuid[])", [all]);
  await db.query("DELETE FROM profiles WHERE id = ANY($1::uuid[])", [all]);
}

// 그룹을 지운다. 대표가 만든 아이 프로필은 함께 지운다.
async function deleteGroups(db, ids) {
  const { rows: kids } = await db.query(
    `SELECT p.id FROM group_members m JOIN profiles p ON p.id = m.profile_id JOIN groups g ON g.id = m.group_id
     WHERE m.group_id = ANY($1::text[]) AND p.managed_by = g.owner_id`,
    [ids]
  );
  await deleteProfiles(db, kids.map((r) => r.id));
  await db.query("DELETE FROM group_members WHERE group_id = ANY($1::text[])", [ids]);
  await db.query("DELETE FROM invites WHERE group_id = ANY($1::text[])", [ids]);
  await db.query("DELETE FROM groups WHERE id = ANY($1::text[])", [ids]);
}

// 가족·동승자 그룹과 QR 초대(ADR-0009, T45). 모든 경로의 인증은 프로필 토큰이다.
const GROUP_KIND = ["family", "crew"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function groups(req, seg, b) {
  const m = req.method;
  const db = profilesDb();
  if (!seg[0]) {
    if (m !== "POST") fail(405, "POST만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const g = { id: randomUUID().slice(0, 8), kind: oneOf(b.kind ?? "family", GROUP_KIND, "kind"), name: b.name === undefined ? "" : text(b.name, 40, "name"), ownerId: me.id };
    await db.query("INSERT INTO groups (id, kind, name, owner_id) VALUES ($1, $2, $3, $4)", [g.id, g.kind, g.name, g.ownerId]);
    await db.query("INSERT INTO group_members (group_id, profile_id) VALUES ($1, $2)", [g.id, me.id]);
    return [201, { ...g, members: [{ profileId: me.id, name: me.name, character: me.character, isOwner: true }] }];
  }
  const [id, sub, arg, leaf] = seg;
  // 인증보다 먼저 못 쓰는 메서드를 가른다(없는 경로·메서드는 404·405로 답한다).
  if (leaf !== undefined && (sub !== "members" || leaf !== "voice" || seg[4] !== undefined)) fail(404, "없는 경로");
  if (!sub && m !== "GET" && m !== "DELETE") fail(405, "GET, DELETE만 됨");
  if (sub === "members" && !arg && m !== "POST") fail(405, "POST만 됨");
  if (sub === "members" && arg && !leaf && m !== "DELETE") fail(405, "DELETE만 됨");
  if (leaf && m !== "POST" && m !== "DELETE") fail(405, "POST, DELETE만 됨");
  if (sub === "invites" && !arg && m !== "POST" && m !== "GET") fail(405, "POST, GET만 됨");
  if (sub === "invites" && arg && m !== "DELETE") fail(405, "DELETE만 됨");
  if (sub && sub !== "members" && sub !== "invites") fail(404, "없는 경로");
  if (sub === "members" && arg && !UUID.test(arg)) fail(404, "없는 구성원");
  const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
  const { rows: found } = await db.query("SELECT id, kind, name, owner_id FROM groups WHERE id = $1", [id]);
  const group = found[0] ?? fail(404, "없는 그룹");
  const isOwner = group.owner_id === me.id;
  const isMember = isOwner || (await db.query("SELECT 1 FROM group_members WHERE group_id = $1 AND profile_id = $2", [id, me.id])).rows.length > 0;
  const memberRows = () =>
    db.query(
      `SELECT m.profile_id, p.name, p.character, (p.photo IS NOT NULL) AS has_photo, g.owner_id
       FROM group_members m JOIN profiles p ON p.id = m.profile_id JOIN groups g ON g.id = m.group_id
       WHERE m.group_id = $1 ORDER BY m.joined_at`,
      [id]
    );

  if (!sub) {
    if (m === "GET") {
      if (!isMember) fail(403, "구성원만 볼 수 있음");
      const { rows } = await memberRows();
      return [200, { id: group.id, kind: group.kind, name: group.name, ownerId: group.owner_id, members: rows.map((r) => ({ profileId: r.profile_id, name: r.name, character: r.character, hasPhoto: r.has_photo, isOwner: r.owner_id === r.profile_id })) }];
    }
    // 그룹을 지워도 계정 있는 구성원의 기록본과 앨범은 프로필 소유라 그대로 남는다(ADR-0009).
    // 대표가 만든 아이 프로필은 함께 지운다.
    if (!isOwner) fail(403, "대표만 지울 수 있음");
    await inProfilesTx((tx) => deleteGroups(tx, [id]));
    return [204];
  }

  if (sub === "members" && !arg) {
    // 계정 없는 구성원(아이) 프로필을 대표가 만든다. 토큰은 없다 — 대표의 기기가 참가시킨다.
    if (!isOwner) fail(403, "대표만 구성원을 만들 수 있음");
    const p = { id: randomUUID(), name: text(b.name, 20, "name"), prefs: rolePrefs({}), consentDefault: false, character: b.character === undefined ? "" : text(b.character, 20, "character") };
    await db.query("INSERT INTO profiles (id, name, prefs, consent_default, character, managed_by) VALUES ($1, $2, $3, false, $4, $5)", [p.id, p.name, p.prefs, p.character, me.id]);
    await db.query("INSERT INTO group_members (group_id, profile_id) VALUES ($1, $2)", [id, p.id]);
    return [201, { profileId: p.id, name: p.name, character: p.character, isOwner: false }];
  }
  if (leaf) {
    // 계정 없는 구성원(아이)의 목소리는 그 아이를 만든 대표가 대신 등록하고 지운다(ADR-0009·0019).
    // 보호자 동의 문구는 등록 화면(T37·T46)에 붙인다.
    if (!isOwner) fail(403, "대표만 아이의 목소리를 등록할 수 있음");
    const { rows: kid } = await db.query(
      "SELECT 1 FROM profiles p JOIN group_members gm ON gm.profile_id = p.id WHERE p.id = $1 AND gm.group_id = $2 AND p.managed_by = $3",
      [arg, id, me.id]
    );
    if (!kid[0]) fail(404, "이 그룹에서 대표가 만든 구성원이 아님");
    return voicePrint(req, m, arg);
  }
  if (sub === "members" && arg) {
    if (!isOwner && arg !== me.id) fail(403, "대표만 내보낼 수 있음");
    if (arg === group.owner_id) fail(409, "대표는 그룹을 지워야 나갈 수 있음");
    const { rowCount } = await db.query("DELETE FROM group_members WHERE group_id = $1 AND profile_id = $2", [id, arg]);
    if (!rowCount) fail(404, "없는 구성원");
    // 대표가 만든 아이 프로필은 내보내면 지울 사람이 없어지므로 함께 지운다. 계정 있는 구성원의 기록은 그대로다.
    const { rows: kid } = await db.query("SELECT id FROM profiles WHERE id = $1 AND managed_by = $2", [arg, group.owner_id]);
    if (kid[0]) await inProfilesTx((tx) => deleteProfiles(tx, [arg]));
    return [204];
  }

  if (sub === "invites" && !arg) {
    if (m === "POST") {
      if (!isOwner) fail(403, "대표만 초대를 만들 수 있음");
      const code = randomBytes(12).toString("base64url");
      const maxUses = b.maxUses === undefined ? 5 : int(b.maxUses, 0, 100, "maxUses");
      const minutes = b.expiresInMinutes === undefined ? 60 : int(b.expiresInMinutes, 1, 1440, "expiresInMinutes");
      const expiresAt = Date.now() + minutes * 60_000;
      await db.query("INSERT INTO invites (code, group_id, max_uses, expires_at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))", [code, id, maxUses, expiresAt]);
      return [201, { code, url: `${INVITE_BASE}/${code}`, expiresAt, maxUses }]; // QR에 담을 주소(ADR-0009)
    }
    if (!isOwner) fail(403, "대표만 봄");
    const { rows } = await db.query("SELECT code, max_uses, uses, expires_at, cancelled_at FROM invites WHERE group_id = $1 ORDER BY created_at DESC", [id]);
    return [200, { invites: rows.map((r) => ({ code: r.code, url: `${INVITE_BASE}/${r.code}`, maxUses: r.max_uses, uses: r.uses, expiresAt: r.expires_at.getTime(), cancelled: r.cancelled_at !== null })) }];
  }
  if (sub === "invites" && arg) {
    if (!isOwner) fail(403, "대표만 취소할 수 있음");
    const { rowCount } = await db.query("UPDATE invites SET cancelled_at = now() WHERE code = $1 AND group_id = $2 AND cancelled_at IS NULL", [arg, id]);
    if (!rowCount) fail(404, "없는 초대");
    return [204];
  }
  fail(404, "없는 경로");
}

// 초대 수락. QR 주소(/j/<코드>)로 들어온 폰 브라우저가 부른다(ADR-0009).
async function acceptInvite(req, code, b) {
  const db = profilesDb();
  // 프로필 토큰이 있으면 있던 프로필로, 없으면 새 프로필을 만들어 이 기기 토큰을 준다.
  // 입력과 토큰은 횟수를 쓰기 전에 본다 — 거절된 수락이 횟수를 쓰지 않게.
  const me = await profileOf(req);
  const profile = me ?? { id: randomUUID(), name: text(b.name, 20, "name"), prefs: rolePrefs(obj(b.prefs ?? {}, "prefs")), consentDefault: false, character: b.character === undefined ? "" : text(b.character, 20, "character"), links: [] };
  const device = b.device === undefined ? "" : text(b.device, 20, "device");
  // 이미 구성원이면(QR을 다시 찍음) 횟수를 쓰지 않는다.
  const { rows: member } = me
    ? await db.query("SELECT i.group_id FROM invites i JOIN group_members m ON m.group_id = i.group_id WHERE i.code = $1 AND m.profile_id = $2", [code, me.id])
    : { rows: [] };
  // 횟수 소진·만료·취소와의 경합은 UPDATE 조건으로 막는다(마지막 한 번을 두 명이 못 쓴다).
  const { rows } = member[0]
    ? { rows: member }
    : await db.query(
        `UPDATE invites SET uses = uses + 1
         WHERE code = $1 AND cancelled_at IS NULL AND expires_at > now() AND (max_uses = 0 OR uses < max_uses)
         RETURNING group_id`,
        [code]
      );
  if (!rows[0]) {
    const { rows: check } = await db.query("SELECT cancelled_at, expires_at, (max_uses = 0 OR uses < max_uses) AS usable FROM invites WHERE code = $1", [code]);
    if (!check[0]) fail(404, "없는 초대");
    fail(409, check[0].cancelled_at ? "취소된 초대" : new Date(check[0].expires_at).getTime() <= Date.now() ? "만료된 초대" : "쓸 수 있는 횟수가 다한 초대");
  }
  const token = me ? null : randomBytes(32).toString("base64url");
  if (!me) {
    // 첫 토큰은 옛 칸에도(POST /profiles와 같은 까닭)
    await db.query("INSERT INTO profiles (id, token_hash, name, prefs, consent_default, character) VALUES ($1, $2, $3, $4, false, $5)", [profile.id, tokenHash(token), profile.name, profile.prefs, profile.character]);
    await issueToken(profile.id, device, token);
  }
  await db.query("INSERT INTO group_members (group_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [rows[0].group_id, profile.id]);
  const { rows: g } = await db.query("SELECT id, kind, name FROM groups WHERE id = $1", [rows[0].group_id]);
  // 진행 중인 그룹 여행이 있으면 코드만 알려 준다. 자리는 본인이 골라 기존 참가 경로로 들어온다 —
  // 동의·기록·자리 겹침 규칙이 그 경로 한 곳에만 있다(ADR-0009: 수락한 사람은 자리만 고르면 된다).
  const { rows: trips } = await tripsDb().query(
    `SELECT code FROM trips WHERE doc->>'groupId' = $1 AND created_at > now() - interval '48 hours'
     AND (doc->>'status') IN ('boarding', 'driving') ORDER BY created_at DESC LIMIT 1`,
    [rows[0].group_id]
  );
  return [200, { group: g[0], profile: { ...profile, hasPhoto: me?.hasPhoto ?? false }, ...(token ? { token } : {}), ...(trips[0] ? { trip: { code: trips[0].code } } : {}) }];
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
    await client.query("ROLLBACK").catch(() => {}); // 끊긴 연결이면 되돌릴 것도 없다. 원래 오류를 가리지 않게
    throw e;
  } finally {
    client.release();
  }
}

async function trips(req, [code, sub, id], b, query) {
  const m = req.method;
  if (!code) {
    if (m !== "POST") fail(405, "POST만 됨");
    // 그룹 여행(ADR-0009): 대표가 그룹을 지정하면 초대를 수락한 구성원이 이 여행 코드를 받아 자리를 골라 참가한다.
    let groupId = null;
    if (b.groupId !== undefined) {
      groupId = text(b.groupId, 8, "groupId");
      const me = await profileOf(req);
      const { rows } = me ? await profilesDb().query("SELECT id FROM groups WHERE id = $1 AND owner_id = $2", [groupId, me.id]) : { rows: [] };
      if (!rows[0]) fail(403, "그룹의 대표만 그룹 여행을 만들 수 있음");
    }
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
      ...(groupId ? { groupId } : {}),
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
  if (sub === "voice-match" && !id) return voiceMatch(await withTrip(code, false, (trip) => trip), req, query);
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
      // 대표가 그룹의 계정 없는 구성원(아이) 프로필로 참가시킬 수 있다(ADR-0009).
      let kidOf = null;
      if (b.profileId !== undefined) {
        if (!profile) fail(401, "프로필 토큰이 필요함");
        if (typeof b.profileId !== "string" || !UUID.test(b.profileId)) fail(400, "profileId: 프로필 id");
        // 내가 만든 계정 없는 구성원(아이)만 — 계정 있는 어른의 자리와 동의는 그 사람이 정한다.
        const { rows: kid } = await profilesDb().query(
          `SELECT p.id, p.name, p.prefs, p.consent_default FROM profiles p
           JOIN group_members gm ON gm.profile_id = p.id
           JOIN groups g ON g.id = gm.group_id
           WHERE p.id = $1 AND g.owner_id = $2 AND p.managed_by = $2 LIMIT 1`,
          [b.profileId, profile.id]
        );
        if (!kid[0]) fail(403, "내가 만든 계정 없는 구성원만 참가시킬 수 있음");
        if (trip.participants.some((p) => p.profileId === kid[0].id)) fail(409, "이미 참가한 구성원");
        kidOf = kid[0];
      }
      // 같은 프로필이 다시 참가하면 이미 있는 참가자를 돌려준다(폰에서 다시 열었을 때).
      // 참가자 토큰은 문서에 해시만 남으니 다시 참가할 때마다 새로 만들어 준다(옛 토큰은 못 쓰게 됨).
      const again = !kidOf && profile && trip.participants.find((p) => p.profileId === profile.id);
      if (again) {
        const token = randomBytes(32).toString("base64url");
        again.tokenHash = tokenHash(token).toString("hex");
        return changed(200, { ...asParticipant(again), token });
      }
      const seat = oneOf(b.seat, SEATS, "seat");
      const p = kidOf
        ? { name: kidOf.name, prefs: kidOf.prefs[ROLE[seat]], consent: b.consent === undefined ? false : bool(b.consent, "consent"), profileId: kidOf.id } // 아이는 동의 기본값 꺼짐
        : profile
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
      // 동의하지 않은 탑승자가 있는 동안은 받지 않는다(voice.md). 확인 순번도 오르지 않으니 차량은 모두 동의한 뒤 다시 보낸다.
      if (!everyoneConsents(trip)) fail(403, "동의하지 않은 탑승자가 있어 올릴 수 없음");
      const items = Array.isArray(b.items) ? b.items : fail(400, "items: 배열");
      if (items.length > 500) fail(400, "items: 한 번에 500개까지");
      // 화자(profileId)는 받지 않는다. 서버의 화자 대조(T38)만 붙인다 — 올리는 쪽이 남의 이름을 붙이지 못하게.
      const rows = items.map((it, i) => {
        const u = obj(it, `items[${i}]`);
        const seq = int(u.seq, 1, 1_000_000_000, `items[${i}].seq`);
        const generation = int(u.generation ?? b.generation, 1, current, `items[${i}].generation`);
        // 옛 세대는 저장하지 않으니 순번과 세대만 본다. 차량은 동의가 꺼질 때 내용을 버리고 {seq, generation}만 보내 확인받는다(ADR-0007).
        if (generation < current) return [trip.code, device, seq, null, null, null, null, null, null, generation];
        const hasLat = u.lat !== undefined;
        if (hasLat !== (u.lng !== undefined)) fail(400, `items[${i}].lat, lng: 둘 다 있거나 둘 다 없음`);
        return [
          trip.code,
          device,
          seq,
          int(u.at, 0, Date.now() + 600_000, `items[${i}].at`),
          text(u.text, 500, `items[${i}].text`),
          u.seatArea == null ? null : oneOf(u.seatArea, SEATS, `items[${i}].seatArea`), // 모르는 구역은 비워 둔다(T37)
          u.confidence === undefined ? null : num(u.confidence, 0, 1, `items[${i}].confidence`),
          hasLat ? num(u.lat, -90, 90, `items[${i}].lat`) : null,
          hasLat ? num(u.lng, -180, 180, `items[${i}].lng`) : null,
          generation,
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
      let where = "trip_code = $1 AND text <> ''"; // 내용을 비운 줄(지운 글)은 빼고
      if (device) {
        params.push(device, int(Number(query.get("after") ?? 0), 0, 1_000_000_000, "after"));
        where += " AND device = $2 AND seq > $3";
      }
      const { rows } = await client.query(`SELECT device, seq, at, text, seat_area, profile_id, confidence, lat, lng FROM utterances WHERE ${where} ORDER BY at`, params);
      return [200, { generation: trip.generation ?? 1, recording: trip.recording, items: rows.map(asUtterance) }];
    }
    if (m === "DELETE") {
      // 자기 글 지우기. 프로필로 참가한 사람만, 자기 이름이 붙은 발화만 지운다. 세대는 올리지 않는다 —
      // 세대를 올리면 옛 세대 전부, 곧 그 여행의 모든 사람 글이 지워진다.
      // 줄은 지우지 않고 내용만 비운다: 순번에 빈자리가 있던 기기가 같은 순번을 다시 보내도(멱등 키에 걸려) 되살아나지 않게.
      if (!caller.profileId) fail(403, "프로필로 참가한 사람의 글만 지울 수 있음");
      const { rowCount } = await client.query(
        "UPDATE utterances SET text = '', seat_area = NULL, confidence = NULL, lat = NULL, lng = NULL WHERE trip_code = $1 AND profile_id = $2 AND text <> ''",
        [trip.code, caller.profileId]
      );
      return [200, { deleted: rowCount }];
    }
  }

  if (sub === "transcript") {
    // 기록본: 발화를 시간순으로, 부탁과 도착 할 일과 함께(T39).
    if (m !== "GET") fail(405, "GET만 됨");
    if (!participantOf(req, trip).consent) fail(403, "녹음에 동의한 참가자만 볼 수 있음"); // 이 여행의 허용된 참가자만 본다
    const { rows } = await client.query("SELECT device, seq, at, text, seat_area, profile_id, confidence, lat, lng FROM utterances WHERE trip_code = $1 AND text <> '' ORDER BY at", [trip.code]);
    // 도착 할 일 뽑기(LLM)는 아직 구현 전이다. 기록본 모양을 미리 맞춰 둔다(ADR-0007).
    return [200, { generation: trip.generation ?? 1, utterances: rows.map(asUtterance), requests: trip.requests, todos: [] }];
  }

  fail(404, "없는 경로");
}

// 확장자 없는 주소는 화면이다: 그 폴더의 index.html(/demo), 없으면 웹앱 첫 화면 — 초대 주소 /j/<코드>처럼 웹앱이 주소를 읽는다.
async function serveFile(path, res) {
  const page = !extname(path);
  const file = normalize(join(WEB, page ? join(path, "index.html") : path));
  if (!file.startsWith(WEB)) fail(404, "없는 파일");
  const data = await readFile(file).catch(() => (page ? readFile(join(WEB, "index.html")) : fail(404, "없는 파일")));
  res.writeHead(200, { "content-type": `${MIME[page ? ".html" : extname(file)] ?? "application/octet-stream"}; charset=utf-8` });
  res.end(data);
}

export const server = createServer(async (req, res) => {
  const send = (status, data) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(data === undefined ? undefined : JSON.stringify(data));
  };
  const sendRaw = (status, buf, type) => {
    // 매직 바이트만 본 파일이라 브라우저가 다른 형식으로 추측해 열지 못하게 한다.
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(buf);
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
      // 목소리 등록(…/voice)·발화 대조는 이진 본문(WAV)이다 — JSON으로 먼저 읽지 않는다.
      const binary = req.method === "POST" && (seg.at(-1) === "voice" || (seg[1] === "trips" && seg[3] === "voice-match"));
      const body = !binary && (req.method === "POST" || req.method === "PATCH") ? await readBody(req, big ? 1_000_000 : MAX_BODY) : {};
      if (seg[1] === "profiles") {
        const r = await profiles(req, seg.slice(2), body);
        if (Buffer.isBuffer(r[1])) return void sendRaw(r[0], r[1], r[2]); // 사진 같은 이진 응답
        return send(...r);
      }
      if (seg[1] === "groups") return send(...(await groups(req, seg.slice(2), body)));
      if (seg[1] === "j" && seg[2] && !seg[3]) {
        if (req.method !== "POST") fail(405, "POST만 됨");
        return send(...(await acceptInvite(req, seg[2], body)));
      }
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
