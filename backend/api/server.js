// 가치타 API 서버. Node 22 표준 http와 Postgres 드라이버(pg), 클립 버킷용 S3 SDK만 쓴다(ADR-0019 의존성 원칙).
// 한 프로세스가 API(/api)와 웹앱(frontend/web)을 같이 내보낸다. 경로와 형식은 docs/api/openapi.yaml에 있다.
//
// ponytail: 여행 하나를 JSONB 문서 한 줄로 저장한다. 바꿀 때는 그 줄을 잠그고 통째로 다시 쓴다.
//           여행을 가로질러 조회할 일이 생기면 참가자·부탁을 표로 나눈다.
// ponytail: 프로필 토큰이 없는 손님도 여행 코드만 알면 참가하고 자리를 고치고 동의를 끌 수 있다.
//           동의 켜기와 음성 경로는 참가자 토큰으로 본인만 한다(T68).
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { profilesDb, tripsDb } from "./db.js";
import { withActiveProfile, withDeletingProfiles } from "./profile-lifecycle.js";
import { createShare, sharedResults } from "./result-shares.js";
import { errFields, log } from "./log.js";
import { asrReady, contextOf, retranscribe, toWav, transcribe } from "./providers/asr.js";
import { clipStore } from "./providers/clips.js";
import { googleIdentity, googlePublicConfig } from "./providers/google.js";
import { cues, momentSpan, suggest } from "./scenes.js";
import { checkVector, DIMS, embed, EMBEDDER, matchFloor, matchMargin, matchThreshold, similarity, wavMono } from "./providers/voice.js";
import { accountConsents, accounts, CONSENT_VERSION } from "./accounts.js";
import { groupForTrip, groupInvites, groups, shareGroup } from "./groups.js";
import { rideLinks, redeemRideLink } from "./ride-links.js";
import { boardingInvites, tripBoardingInvites } from "./boarding-invites.js";
import { restStops, SOURCE as REST_STOPS_SOURCE } from "./rest-stops.js";
import { shortGenerations, shortTemplateCatalog } from "./short-generations.js";
import { shortAssets, revokeShortAssets } from "./short-assets.js";
import { tripAudio } from "./trip-audio.js";
import { arrivalBriefing, deriveTodos, TODO_METHOD } from "./todos.js";
import { addPlace, myTrips, tripContents } from "./places.js";

const WEB = fileURLToPath(new URL("../../frontend/web/", import.meta.url));
const TRIPS_SQL = fileURLToPath(new URL("trips.sql", import.meta.url));
const PROFILES_SQL = fileURLToPath(new URL("profiles.sql", import.meta.url));
const LINKS_SQL = fileURLToPath(new URL("profiles-2-links.sql", import.meta.url));
const UTTERANCES_SQL = fileURLToPath(new URL("trips-2-utterances.sql", import.meta.url));
const RECORDINGS_SQL = fileURLToPath(new URL("trips-3-recordings.sql", import.meta.url));
const CAPTIONS_SQL = fileURLToPath(new URL("trips-6-captions.sql", import.meta.url));
const ASR_SQL = fileURLToPath(new URL("trips-4-asr.sql", import.meta.url));
const TRIP_VOICE_SQL = fileURLToPath(new URL("trips-5-voice.sql", import.meta.url));
const ALBUM_SQL = fileURLToPath(new URL("profiles-3-moments.sql", import.meta.url));
const GROUPS_SQL = fileURLToPath(new URL("profiles-4-groups.sql", import.meta.url));
const VOICE_SQL = fileURLToPath(new URL("profiles-5-voice.sql", import.meta.url));
const NO_PREFS_SQL = fileURLToPath(new URL("profiles-6-no-prefs.sql", import.meta.url));
const ACCOUNTS_SQL = fileURLToPath(new URL("profiles-7-accounts.sql", import.meta.url));
const NEW_GROUPS_SQL = fileURLToPath(new URL("profiles-8-groups.sql", import.meta.url));
const PHOTO_MAX = 1_000_000; // 프로필 사진 상한. 형식은 매직 바이트로만 확인한다(다시 그리기는 T46 화면, ADR-0009 위험)
const MAX_BODY = 10_000;
// ponytail: 여행 하나의 발화는 2만 줄까지(3시간 여행 ≈ 2,500줄). 명시적 삭제 한 번이 2초 제한(T26) 안에 끝나게 묶는다.
const MAX_TRIP_UTTERANCES = 20_000;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 0·O·1·I·L은 헷갈려서 뺌

// 좌석 이름은 Pleos Vehicle SDK의 SeatArea와 같게 둔다. 차량 앱이 그대로 넘긴다.
export const SEATS = ["ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_CENTER", "ROW_2_RIGHT"];
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
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/vnd.microsoft.icon",
};

// 옛 QR 초대(/j)와 다른 프로필을 대신 참가시키는 profileId는 계속 닫혀 있다. 그룹은 새 모양으로 되살렸다(T133, groups.js).
const RETIRED_GROUP = "그룹 초대는 종료됐어요. 탑승자 폰에서 동승 연결 QR을 열고, 주차 중인 차에서 읽어 주세요.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status, error) => {
  throw { status, error };
};

// 오류 종류(T71): 응답의 type과 로그의 err.type. 상태에서 정하는 닫힌 목록이라 클라이언트는 문장이 아니라 종류로 가른다.
const ERROR_TYPE = { 400: "invalid", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict", 410: "gone", 413: "too_large", 422: "invalid", 429: "rate_limited", 502: "unavailable", 503: "unavailable", 504: "unavailable" };
// DB에 닿지 않거나(연결 끊김·거절, 연결 수 초과) 질의 시간 제한(57014, T26)에 걸린 것: 다시 해도 되는 503.
// Postgres 오류 번호 08xxx 연결, 53xxx 자원 부족, 57014 질의 취소, 57P0x 서버 종료·시작 중.
const DB_DOWN = /^(08|53|57014|57P0)/;
const DB_DOWN_MESSAGE = /Connection terminated|timeout exceeded when trying to connect|not queryable/;
// 던진 것을 응답으로: fail()의 {status, error}는 그대로, DB 문제는 503 unavailable, 나머지는 500 internal.
export function classify(e) {
  if (e?.status) return { status: e.status, type: ERROR_TYPE[e.status] ?? "internal", message: e.error };
  const down = DB_DOWN.test(e?.code ?? "") || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(e?.code) || DB_DOWN_MESSAGE.test(e?.message ?? "");
  return down ? { status: 503, type: "unavailable", message: "서버가 잠시 바빠요. 잠시 뒤 다시 해 주세요" } : { status: 500, type: "internal", message: "서버 오류" };
}

// 로그의 경로 틀: 정한 낱말이 아닌 마디(여행 코드, id, 초대 코드)는 :p로 가린다. 웹 파일은 /(web) 하나로.
const ROUTE_WORDS = new Set(["api", "config", "trips", "participants", "requests", "moments", "utterances", "transcript", "transcriptions", "captions", "voice-match", "voice-prints", "recordings", "scene-suggestions", "shortform", "short-templates", "short-plans", "short-generations", "file", "profiles", "me", "links", "google", "feed", "tokens", "photo", "voice", "groups", "members", "invites", "j"]);
for (const word of ["todos", "arrival-briefing"]) ROUTE_WORDS.add(word);
for (const word of ["short-assets", "source", "short-worker", "claim", "jobs", "audio", "result", "fail", "thumbnail"]) ROUTE_WORDS.add(word);
ROUTE_WORDS.add("places");
ROUTE_WORDS.add("contents");
ROUTE_WORDS.add("rest-stops");
ROUTE_WORDS.add("boarding-invites");
for (const word of ["accounts", "sessions"]) ROUTE_WORDS.add(word);
for (const word of ["group-invites", "children", "seats"]) ROUTE_WORDS.add(word);
for (const word of ["audio", "parts", "start", "complete"]) ROUTE_WORDS.add(word);
const routeOf = (pathname) =>
  pathname === "/healthz" ? pathname : pathname.startsWith("/api/") ? `/${pathname.split("/").filter(Boolean).map((s) => (ROUTE_WORDS.has(s) ? s : ":p")).join("/")}` : "/(web)";
// ALB가 붙이는 추적 id(X-Amzn-Trace-Id)를 그대로 쓴다. 없거나 모양이 이상하면 새로.
const requestIdOf = (req) => {
  const v = req.headers["x-amzn-trace-id"];
  return typeof v === "string" && /^[\w=;.-]{1,200}$/.test(v) ? v : randomUUID();
};
// NUL 문자와 짝 없는 서로게이트는 Postgres의 text·jsonb가 받지 않아(22021·22P05·22P02) 저장할 때 500이 된다.
// 받을 때 400으로 거른다.
const text = (v, max, name) =>
  typeof v === "string" && (v.includes("\0") || !v.isWellFormed()) ? fail(400, `${name}: 쓸 수 없는 문자(NUL, 짝 없는 서로게이트)`)
  : typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : fail(400, `${name}: 글자 1~${max}자`);
const num = (v, min, max, name) =>
  typeof v === "number" && v >= min && v <= max ? v : fail(400, `${name}: ${min}~${max} 사이 숫자`);
const int = (v, min, max, name) => (Number.isInteger(v) ? num(v, min, max, name) : fail(400, `${name}: 정수`));
const oneOf = (v, list, name) => (list.includes(v) ? v : fail(400, `${name}: ${list.join(", ")} 중 하나`));
const bool = (v, name) => (typeof v === "boolean" ? v : fail(400, `${name}: true 또는 false`));
const obj = (v, name) => (v && typeof v === "object" && !Array.isArray(v) ? v : fail(400, `${name}: 객체`));

// 경로 위 휴게소(T97, rest-stops.js). 위치는 로그에 남지 않게 주소가 아니라 본문으로 받고 저장하지 않는다.
// 범위는 우리나라 안(제주·독도 포함). 차가 위치를 모르면(0, 0) 400이고 차는 고정 목록으로 돌아간다.
const point = (v, name) => (obj(v, name), { lat: num(v.lat, 33, 39, `${name}.lat`), lng: num(v.lng, 124, 132, `${name}.lng`) });
function restStopsOf(b) {
  const from = point(b.from, "from");
  const heading = b.from.heading == null ? null : num(b.from.heading, 0, 360, "from.heading");
  const to = b.to == null ? null : point(b.to, "to");
  const remain = b.remainMeters == null ? null : int(b.remainMeters, 0, 2_000_000, "remainMeters");
  const limit = b.limit == null ? 3 : int(b.limit, 1, 10, "limit");
  return { items: restStops({ from, heading, to, remain, limit }), source: REST_STOPS_SOURCE };
}

const everyoneConsents = (trip) => trip.participants.length > 0 && trip.participants.every((p) => p.consent);
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
const tokenHash = (token) => createHash("sha256").update(token).digest();

export async function migrate() {
  // 저장소마다 제 표를 만든다. 두 주소가 같으면 한 DB에 둘 표가 생긴다.
  // profiles-2부터는 profiles.sql을 고치지 않고 번호 붙은 마이그레이션을 쌓는다.
  await tripsDb().query(await readFile(TRIPS_SQL, "utf8"));
  await tripsDb().query(await readFile(UTTERANCES_SQL, "utf8"));
  await tripsDb().query(await readFile(RECORDINGS_SQL, "utf8"));
  await tripsDb().query(await readFile(ASR_SQL, "utf8"));
  await tripsDb().query(await readFile(new URL("trips-5-ride-links.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(TRIP_VOICE_SQL, "utf8"));
  await tripsDb().query(await readFile(CAPTIONS_SQL, "utf8"));
  await tripsDb().query(await readFile(new URL("trips-7-result-shares.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-8-short-generations.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-9-retention.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-10-todos.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-11-boarding-invites.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-12-short-assets.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-13-utterance-segments.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-14-utterance-speaker.sql", import.meta.url), "utf8"));
  await tripsDb().query(await readFile(new URL("trips-15-trip-audio.sql", import.meta.url), "utf8"));
  await profilesDb().query(await readFile(PROFILES_SQL, "utf8"));
  await profilesDb().query(await readFile(LINKS_SQL, "utf8"));
  await profilesDb().query(await readFile(ALBUM_SQL, "utf8"));
  await profilesDb().query(await readFile(GROUPS_SQL, "utf8"));
  await profilesDb().query(await readFile(VOICE_SQL, "utf8"));
  await profilesDb().query(await readFile(NO_PREFS_SQL, "utf8"));
  await profilesDb().query(await readFile(ACCOUNTS_SQL, "utf8"));
  await profilesDb().query(await readFile(NEW_GROUPS_SQL, "utf8"));
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

// profiles 표의 한 줄을 API가 돌려주는 프로필 모양으로 바꾼다. 이 모양은 본인에게만 간다(이메일이 들어 있다).
const asProfile = (r) => ({
  id: r.id,
  name: r.name,
  consentDefault: r.consent_default,
  character: r.character ?? "",
  hasPhoto: Boolean(r.has_photo),
  links: r.provider ? [r.provider] : [],
  email: r.email ?? null,
  hasVoice: Boolean(r.has_voice),
  consent: Boolean(r.consent),
  consentAt: r.consent_at ? new Date(r.consent_at).getTime() : null,
  consentVersion: r.consent_version || null,
});
// asProfile이 읽는 칸(별칭 p). 목소리는 지금 임베더의 길이(DIMS)인 값만 센다 — 차가 받아 대조할 수 있는 값만 '등록함'(ADR-0023).
const PROFILE_COLUMNS = `p.id, p.name, p.consent_default, p.provider, p.character, (p.photo IS NOT NULL) AS has_photo,
  p.email, p.consent, p.consent_at, p.consent_version,
  EXISTS (SELECT 1 FROM voice_prints v WHERE v.profile_id = p.id AND cardinality(v.vector) = ${DIMS}) AS has_voice`;

// 기기 토큰을 하나 더 만든다(ADR-0009). 다른 기기의 토큰은 그대로다.
async function issueToken(profileId, device = "", token = randomBytes(32).toString("base64url")) {
  await profilesDb().query("INSERT INTO tokens (token_hash, profile_id, device) VALUES ($1, $2, $3)", [tokenHash(token), profileId, device]);
  return token;
}

// 여행 문서의 참가자를 API가 돌려주는 모양으로 바꾼다. 참가자 토큰 해시는 절대 나가지 않는다.
// prefs는 좌석·공조 선호를 걷어내기(T68) 전에 만든 여행 문서에만 있다(응답에서는 제외함).
const asParticipant = ({ tokenHash, olderTokenHashes, prefs, ...p }) => p;
// arrival(도착한 장소 이름, T119)은 토큰 없이 읽는 여행 문서에 싣지 않는다. 동의한 참가자가 GET /todos로만 읽는다.
// places(차가 남긴 장소, T131)도 같다 — 가족이 어디로 가고 어디에 닿았는지를 여행 코드만 아는 사람(과 서비스 워커 캐시)에게 내주지 않는다.
// 동의한 참가자가 GET /places·/transcript로만 읽는다.
// 그룹으로 만든 여행의 그룹 id·이름(T133)도 싣지 않는다 — 구성원은 자기 그룹 목록(GET /groups)과 내 여행 목록으로 안다.
const tripView = ({ arrival, places, groupId, groupName, ...trip }) => ({ ...trip, participants: trip.participants.map(asParticipant) });

// 참가자 토큰(ADR-0007·docs/api/voice.md). 여행·참가에 묶이고 문서에는 해시만 남는다.
// 프로필 토큰과 별개다 — 발화 올리기·기록본·동의 켜기의 인증에 쓴다.
// 가장 최근에 준 토큰의 해시는 tokenHash, 그 앞의 것은 olderTokenHashes에 둔다(T68) —
// 배포 중 함께 도는 옛 파드와 되돌린 이미지는 tokenHash만 읽으니, 그쪽에서도 가장 최근 기기는 통한다.
const participantOf = (req, trip) => {
  const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization ?? "");
  const h = m && tokenHash(m[1]).toString("hex");
  const p = h && trip.participants.find((x) => x.tokenHash === h || x.olderTokenHashes?.includes(h));
  return p ?? fail(401, "참가자 토큰이 필요함");
};

// 동의 세대를 올리고 옛 세대의 발화를 지운다(ADR-0007).
// 동의 철회 뒤에 늦게 올라온 옛 세대 발화는 받은 것으로만 치고 저장하지 않는다(POST /utterances).
async function bumpGeneration(trip, client) {
  trip.generation = (trip.generation ?? 1) + 1;
  delete trip.arrival;
  await client.query("DELETE FROM utterances WHERE trip_code = $1 AND generation < $2", [trip.code, trip.generation]);
  await revokeShortAssets(client, trip.code, trip.generation);
  await client.query("DELETE FROM todo_states WHERE trip_code = $1 AND generation < $2", [trip.code, trip.generation]);
  // 그 여행의 클립도 모두 지운다(T76). 같은 트랜잭션에서 지울 키를 적고 버킷은 커밋 뒤에 비운다(sweepClips) —
  // 잠금을 쥔 채 S3를 기다리지 않고, 되돌려지면 적은 것도 되돌려진다. 늦게 올라오는 옛 세대 클립은 세대 확인이 막는다.
  // 사람이 지운 표시(deleted_at)는 남긴다 — 철회 뒤 다시 동의해도 지운 장면의 클립을 다시 받지 않게(여행이 닫힐 때 함께 지움).
  await client.query(
    `WITH r AS (DELETE FROM recordings WHERE trip_code = $1 AND deleted_at IS NULL RETURNING object_key)
     INSERT INTO clip_trash (object_key) SELECT object_key FROM r ON CONFLICT DO NOTHING`,
    [trip.code]
  );
}

// utterances 표의 한 줄을 API가 돌려주는 발화 모양으로 바꾼다. 비어 있는 칸은 아예 안 넣는다.
const asUtterance = (r) => ({
  device: r.device,
  seq: Number(r.seq),
  at: Number(r.at),
  ...(r.end_at != null ? { endAt: Number(r.end_at) } : {}),
  ...(r.speaker_label && r.speaker_scope ? { speakerLabel: r.speaker_label, speakerScope: r.speaker_scope } : {}),
  text: r.text,
  displayText: r.edited_text ?? r.asr_text ?? r.text,
  editedText: r.edited_text ?? null,
  editVersion: Number(r.edit_version ?? 0),
  ...(r.edited_by ? { editedBy: r.edited_by, editedAt: new Date(r.edited_at).getTime() } : {}),
  seatArea: r.seat_area,
  ...(r.participant_id ? { participantId: r.participant_id } : {}),
  ...(r.profile_id ? { profileId: r.profile_id } : {}),
  ...(r.participant_id && r.speaker_method ? { speakerMethod: r.speaker_method, ...(r.speaker_confidence != null ? { speakerConfidence: r.speaker_confidence } : {}) } : {}),
  ...(r.confidence !== null ? { confidence: r.confidence } : {}),
  ...(r.lat !== null ? { lat: r.lat, lng: r.lng } : {}),
  ...(r.asr_text ? { asrText: r.asr_text } : {}), // 재전사(T75)한 글. 읽어 온 질의에 있을 때만
});

async function profileById(id, db = profilesDb()) {
  const { rows } = await db.query(`SELECT ${PROFILE_COLUMNS} FROM profiles p WHERE p.id = $1`, [id]);
  return rows[0] ? asProfile(rows[0]) : null;
}

// Authorization: Bearer <토큰>. 머리말이 없으면 null(손님), 틀린 토큰이면 401.
// 토큰은 기기마다 하나씩(tokens 표, T45) — 한 프로필을 차량과 폰에서 함께 쓴다(ADR-0009).
// 옛 칸 profiles.token_hash도 본다: 배포 중 옛 파드가 만든 프로필이 다음 기동 전까지도 읽히게.
async function profileOf(req, db = profilesDb()) {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header);
  const { rows } = m
    ? await db.query(
        `SELECT ${PROFILE_COLUMNS} FROM profiles p WHERE p.id = (SELECT profile_id FROM tokens WHERE token_hash = $1) OR p.token_hash = $1`,
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
// 프로필 사진 바이트. 없으면 404. 볼 수 있는지는 부르는 쪽이 먼저 정한다.
async function photoOf(id) {
  const { rows } = await profilesDb().query("SELECT photo, photo_type FROM profiles WHERE id = $1", [id]);
  if (!rows[0]?.photo) fail(404, "사진이 없음");
  return [200, rows[0].photo, rows[0].photo_type]; // 이진 응답 — 서버 핸들러가 그대로 보낸다
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
      consentDefault: b.consentDefault === undefined ? false : bool(b.consentDefault, "consentDefault"),
      character: b.character === undefined ? "" : text(b.character, 20, "character"),
    };
    // 첫 토큰은 옛 칸(token_hash)에도 적는다 — 이전 이미지로 되돌려도 이 프로필이 읽히게(칸을 지우는 PR에서 뺀다).
    const token = randomBytes(32).toString("base64url");
    await profilesDb().query("INSERT INTO profiles (id, token_hash, name, consent_default, character) VALUES ($1, $2, $3, $4, $5)", [p.id, tokenHash(token), p.name, p.consentDefault, p.character]);
    await issueToken(p.id, b.device === undefined ? "" : text(b.device, 20, "device"), token);
    return [201, { ...(await profileById(p.id)), token }]; // 토큰은 이때 한 번만 준다. 서버에는 해시만 남는다.
  }
  if (seg[0] !== "me") {
    // 다른 프로필의 사진(T128): 본인 것과 같은 그룹 구성원의 것(T133, 아이 포함).
    // 볼 수 없는 프로필은 없는 것과 같게 404로 답한다(있는 id인지 알려 주지 않게).
    if (seg[1] !== "photo" || seg[2]) fail(404, "없는 경로");
    if (m !== "GET") fail(405, "GET만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    if (seg[0] !== me.id && !(UUID.test(seg[0]) && (await shareGroup(me.id, seg[0])))) fail(404, "사진이 없음");
    return photoOf(seg[0]);
  }
  if (seg[1] === "shares" && !seg[3]) {
    if (m !== (seg[2] ? "DELETE" : "GET")) fail(405, seg[2] ? "DELETE만 됨" : "GET만 됨");
    return sharedResults((await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함"), m, seg[2]);
  }
  if (seg[1] === "links" && seg[2] === "google") return googleLink(req, m, b);
  if (seg[1] === "feed" && !seg[2]) {
    // 자기 피드: 발화(여행이 살아 있는 동안)와 장면 앨범(여행이 닫힌 뒤에도 남는 복사본)을
    // 여행을 가로질러 최신순으로 합친다. 두 저장소를 함께 읽는다(T23 구조, ADR-0014).
    if (m !== "GET") fail(405, "GET만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const utterances = await tripsDb().query(
      `SELECT u.trip_code, u.at, u.text, u.seat_area, u.end_at, u.speaker_label, u.speaker_scope FROM utterances u
       JOIN trips t ON t.code = u.trip_code
       WHERE u.profile_id = $1 AND u.text <> ''
       ORDER BY u.at DESC LIMIT 100`,
      [me.id]
    );
    const moments = await profilesDb().query(
      "SELECT id, trip_code, at, lat, lng, label FROM profile_moments WHERE profile_id = $1 ORDER BY at DESC LIMIT 100",
      [me.id]
    );
    const items = [
      ...utterances.rows.map((r) => ({ kind: "utterance", tripCode: r.trip_code, at: Number(r.at), text: r.text, seatArea: r.seat_area,
        ...(r.end_at != null ? { endAt: Number(r.end_at) } : {}), ...(r.speaker_label && r.speaker_scope ? { speakerLabel: r.speaker_label, speakerScope: r.speaker_scope } : {}) })),
      ...moments.rows.map((r) => ({ kind: "moment", id: r.id, tripCode: r.trip_code, at: Number(r.at), label: r.label, ...(r.lat !== null ? { lat: r.lat, lng: r.lng } : {}) })),
    ].sort((a, b) => b.at - a.at);
    return [200, { items: items.slice(0, 100) }];
  }
  if (seg[1] === "trips" && !seg[2]) {
    // 내 여행과 콘텐츠 목록(T131, places.js): 콘텐츠 기록 화면(갤러리·타임라인·지도)이 읽는다.
    if (m !== "GET") fail(405, "GET만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    // ?status=active(T165): 끝나지 않은 여행만, 경로·장소·콘텐츠는 셈하지 않고 빈 목록으로. 폰 처음 화면이 진행 중 여행을 6초마다 찾는다.
    const status = new URL(req.url, "http://localhost").searchParams.get("status");
    if (status !== null && status !== "active") fail(400, "status: active만 됨");
    return myTrips(me, freshMedia, { active: status === "active" });
  }
  if (seg[1] === "moments" && !seg[2]) {
    // 한 여행의 내 앨범 장면(T81 공유 후보). 피드와 달리 발화와 섞지도 100개로 자르지도 않는다 — 여행당 장면은 500개가 상한이다.
    // 앨범 복사본이라 여행이 닫힌 뒤에도 나온다(공유할 수 있는 기간은 부르는 쪽이 여행 시각으로 본다).
    if (m !== "GET") fail(405, "GET만 됨");
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const trip = new URL(req.url, "http://localhost").searchParams.get("trip") ?? "";
    if (!/^[A-Za-z2-9]{6}$/.test(trip)) fail(400, "trip: 여행 코드 6자");
    const { rows } = await profilesDb().query(
      "SELECT id, trip_code, at, lat, lng, label FROM profile_moments WHERE profile_id = $1 AND trip_code = $2 ORDER BY at, id",
      [me.id, trip.toUpperCase()]
    );
    return [200, { items: rows.map((r) => ({ id: r.id, tripCode: r.trip_code, at: Number(r.at), label: r.label, ...(r.lat !== null ? { lat: r.lat, lng: r.lng } : {}) })) }];
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
    if (m === "GET") return photoOf(((await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함")).id);
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
    await deleteProfiles(me.id);
    return [204];
  }
  const name = b.name === undefined ? me.name : text(b.name, 20, "name");
  const consentDefault = b.consentDefault === undefined ? me.consentDefault : bool(b.consentDefault, "consentDefault");
  const character = b.character === undefined ? me.character : text(b.character, 20, "character");
  // 계정의 녹음 동의(T128, C03). 켜면 시각과 문구의 판을 남기고, 끄면 둘 다 비운다. 여행별 동의·철회는 그대로다.
  const consent = b.consent === undefined ? null : bool(b.consent, "consent");
  const version = b.consentVersion === undefined ? CONSENT_VERSION : text(b.consentVersion, 40, "consentVersion");
  await profilesDb().query(
    `UPDATE profiles SET name = $2, consent_default = $3, character = $4, consent = COALESCE($5::boolean, consent),
       consent_at = CASE WHEN $5::boolean IS NULL THEN consent_at WHEN $5::boolean THEN now() END,
       consent_version = CASE WHEN $5::boolean IS NULL THEN consent_version WHEN $5::boolean THEN $6 ELSE '' END,
       updated_at = now() WHERE id = $1`,
    [me.id, name, consentDefault, character, consent, version]
  );
  return [200, await profileById(me.id)];
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
    `UPDATE profiles p SET updated_at = now()
     WHERE p.provider = 'google' AND p.provider_user_id = $1 ${profileId ? "AND p.id = $2" : ""}
     RETURNING ${PROFILE_COLUMNS}`,
    profileId ? [providerUserId, profileId] : [providerUserId]
  );
  return rows[0] ?? null;
}

async function googleLink(req, m, b) {
  if (m === "POST") {
    const identity = await googleIdentity(text(b.code, 500, "code"), text(b.redirectUri, 500, "redirectUri"), b.codeVerifier);
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
    const p = { id: randomUUID(), name: identity.name, consentDefault: false, character: "" };
    try {
      await db.query("INSERT INTO profiles (id, token_hash, name, consent_default, character, provider, provider_user_id) VALUES ($1, $2, $3, $4, '', 'google', $5)", [p.id, tokenHash(token), p.name, p.consentDefault, identity.providerUserId]);
    } catch (e) {
      // 동시 첫 로그인: 먼저 들어온 요청이 이미 프로필을 만들었다(23505). 그 계정의 프로필로 들어간다.
      if (!isTaken(e)) throw e;
      const current = await verifyGoogleLink(null, identity.providerUserId);
      if (!current) fail(409, "구글 계정 연결이 경합 중이에요. 다시 시도해 주세요");
      await issueToken(current.id, b.device === undefined ? "" : text(b.device, 20, "device"), token);
      return [200, { ...asProfile(current), token }];
    }
    await issueToken(p.id, b.device === undefined ? "" : text(b.device, 20, "device"), token);
    return [201, { ...(await profileById(p.id)), token }];
  }
  if (m === "DELETE") {
    const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
    const { rowCount } = await profilesDb().query("UPDATE profiles SET provider = '', provider_user_id = '', updated_at = now() WHERE id = $1 AND provider = 'google'", [me.id]);
    if (!rowCount) fail(404, "연결된 구글 계정이 없음");
    return [204];
  }
  fail(405, "POST, DELETE만 됨");
}

// 등록 음성(WAV)을 받아 대조용 값으로 바꾼다. 원본은 어디에도 남기지 않는다(ADR-0019).
// 본문이 JSON이면 기기가 같은 임베더로 계산한 값이다(ADR-0023) — 소리는 기기를 떠나지 않는다. 이름이 다른 임베더의 값은 섞지 않는다.
async function enrollment(req) {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() === "application/json") {
    let b;
    try {
      b = JSON.parse((await readRaw(req, MAX_BODY)).toString("utf8"));
    } catch (e) {
      if (e?.status) throw e;
      fail(400, "JSON이 아님");
    }
    b = obj(b, "본문");
    if (b.embedder !== EMBEDDER) fail(400, `embedder: ${EMBEDDER}만 됨`);
    return { vector: checkVector(b.vector), seconds: num(b.seconds, 1, 20, "seconds") };
  }
  const { samples } = wavMono(await readRaw(req, 1_500_000)); // WAV 파싱 실패는 400으로 돌아온다
  const seconds = samples.length / 16000;
  // ponytail: 임베딩이 이벤트 루프에서 동기로 돈다(20초 ≈ 65 ms). 등록은 문장 몇 개면 되므로 20초로 묶는다.
  if (seconds < 1 || seconds > 20) fail(400, "등록 음성은 1~20초");
  return { vector: checkVector(embed(samples)), seconds }; // 값 등록과 같은 기준: 말소리가 없으면 400
}
const enrolled = ({ vector, seconds }) => [200, { seconds: Math.round(seconds * 10) / 10, dims: vector.length }];

// 프로필의 목소리 등록·지우기(ADR-0019).
async function voicePrint(req, m, profileId) {
  if (m === "DELETE") {
    await profilesDb().query("DELETE FROM voice_prints WHERE profile_id = $1", [profileId]);
    return [204];
  }
  const { vector, seconds } = await enrollment(req);
  // 본문을 받는 사이 프로필이 지워졌으면 외래 키가 막는다(23503) — 지워진 프로필의 값이 남지 않게.
  await profilesDb()
    .query(
      `INSERT INTO voice_prints (profile_id, vector, seconds) VALUES ($1, $2, $3)
       ON CONFLICT (profile_id) DO UPDATE SET vector = $2, seconds = $3, updated_at = now()`,
      [profileId, vector, seconds]
    )
    .catch((e) => (e?.code === "23503" ? fail(404, "없는 프로필") : Promise.reject(e)));
  return enrolled({ vector, seconds });
}

// 여행 참가자의 목소리 등록(T38). 차의 가족은 손님 참가자라 프로필 등록값이 없다 — 여행마다 둔다.
// 본인의 참가자 토큰으로, 녹음에 동의한 동안만. 값은 동의가 꺼지거나 여행이 지워질 때 함께 지운다.
async function participantVoice(code, id, req) {
  if (req.method !== "POST") fail(405, "POST만 됨");
  const check = (trip) => {
    const p = trip.participants.find((x) => x.id === id) ?? fail(404, "없는 참가자");
    if (participantOf(req, trip) !== p) fail(403, "목소리는 본인만 등록할 수 있음");
    if (!p.consent) fail(409, "녹음에 동의한 뒤 등록함");
    return trip.generation ?? 1;
  };
  // 본문(최대 1.5 MB)을 받고 계산하는 동안은 여행 줄을 잠그지 않는다(voiceMatch와 같은 까닭).
  // 저장할 때 잠그고 다시 보되, 동의 세대까지 같아야 한다 — 그사이 동의를 껐다 다시 켰으면(세대가 오름)
  // 철회 전에 시작한 등록이 되살아나지 않게. 세대는 누구의 철회로도 오르니, 그때는 다시 등록한다.
  const generation = await withTrip(code, false, check);
  const print = await enrollment(req);
  await withTrip(code, true, async (trip, client) => {
    if (check(trip) !== generation) fail(409, "등록하는 사이 동의가 바뀜. 다시 등록함");
    await client.query(
      `INSERT INTO trip_voice_prints (trip_code, participant_id, vector, seconds) VALUES ($1, $2, $3, $4)
       ON CONFLICT (trip_code, participant_id) DO UPDATE SET vector = $3, seconds = $4, updated_at = now()`,
      [trip.code, id, print.vector, print.seconds]
    );
  });
  return enrolled(print);
}

// 웹의 첫 전사(T96). 서버는 소리와 글을 저장하지 않는다. 받은 글의 저장·화자 대조는 기존 API로 한다.
async function transcriptions(code, req, query, signal) {
  if (req.method !== "POST") fail(405, "POST만 됨");
  const generation = int(Number(query.get("generation")), 1, 2_147_483_647, "generation");
  const check = () => withTrip(code, false, (trip) => {
    participantOf(req, trip);
    if (!everyoneConsents(trip)) fail(403, "모두 녹음에 동의한 뒤 전사할 수 있음");
    if (generation !== (trip.generation ?? 1)) fail(409, "동의 세대가 바뀜. 음성을 다시 녹음해 주세요");
  });
  await check(); // 본문을 읽기 전에 인증한다.
  if (!asrReady()) fail(503, "음성 전사 서버가 준비되지 않았어요");
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "audio/wav") fail(400, "Content-Type은 audio/wav");
  const wav = await readRaw(req, 400_000);
  const { samples, channels } = wavMono(wav);
  // 잘린 data를 허용하는 기존 대조 파서보다 엄격하게 확인한다. 유실된 음성을 정상 전사로 보이지 않게 한다.
  if (wav.readUInt32LE(4) !== wav.length - 8) fail(400, "WAV 길이가 맞지 않음");
  const chunks = new Set();
  for (let pos = 12; pos < wav.length;) {
    if (pos + 8 > wav.length) fail(400, "잘린 WAV 머리말");
    const id = wav.toString("latin1", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    const end = pos + 8 + size + size % 2;
    if (end > wav.length) fail(400, "잘린 WAV 본문");
    if (id === "fmt " || id === "data") {
      if (chunks.has(id)) fail(400, "중복 WAV 구간");
      chunks.add(id);
      if (id === "data" && size % 2) fail(400, "잘린 WAV 표본");
      if (id === "fmt " && (wav.readUInt32LE(pos + 16) !== 32000 || wav.readUInt16LE(pos + 20) !== 2)) fail(400, "16 kHz 모노 PCM16 WAV만 됨");
    }
    pos = end;
  }
  const seconds = samples.length / 16000;
  if (channels !== 1 || seconds < 0.5 || seconds > 10) fail(400, "발화 음성은 16 kHz 모노 PCM16 WAV 0.5~10초");
  if (!samples.some((sample) => sample !== 0)) fail(422, "받아 적을 음성이 없어요");
  const result = await transcribe(wav, check, signal, seconds); // 대기 뒤, 공급자로 보내기 직전에 다시 확인한다.
  await check(); // 철회·재동의·참가자 삭제 뒤에 도착한 결과는 돌려주지 않는다.
  if (result.text) return [200, {
    text: result.text, seconds, generation, providerText: result.providerText, segments: result.segments,
    diarization: { method: "provider-window", scope: "request", requestId: randomUUID(), ...result.diarization },
  }];
  if (result.reason === "empty") fail(422, "받아 적을 음성이 없어요");
  if (result.reason === "rate_limited") fail(429, "음성 전사 요청이 많아요. 잠시 뒤 다시 해 주세요");
  if (result.reason === "timeout") fail(504, "음성 전사 응답 시간이 지났어요");
  fail(503, "음성을 받아 적지 못했어요. 원음을 보관하고 다시 시도해 주세요");
}

// 녹음에 동의한 참가자(그리고 which에 맞는 사람)의 등록값: [참가자, {vector, seconds, source}].
// 이 여행에 등록한 것을 먼저, 없으면 그 사람 프로필의 등록값 — 동의하지 않은 사람의 값은 쓰지도 내주지도 않는다.
async function printsOf(trip, which = () => true) {
  const seated = trip.participants.filter((p) => p.consent && which(p));
  if (!seated.length) return [];
  const { rows: own } = await tripsDb().query("SELECT participant_id, vector, seconds FROM trip_voice_prints WHERE trip_code = $1 AND participant_id = ANY($2)", [trip.code, seated.map((p) => p.id)]);
  const ownOf = new Map(own.map((r) => [r.participant_id, { vector: r.vector, seconds: r.seconds, source: "trip" }]));
  const profileIds = seated.filter((p) => p.profileId && !ownOf.has(p.id)).map((p) => p.profileId);
  const { rows: fromProfiles } = profileIds.length
    ? await profilesDb().query("SELECT profile_id, vector, seconds FROM voice_prints WHERE profile_id = ANY($1)", [profileIds])
    : { rows: [] };
  const printOf = new Map(fromProfiles.map((r) => [r.profile_id, { vector: r.vector, seconds: r.seconds, source: "profile" }]));
  return seated.map((p) => [p, ownOf.get(p.id) ?? printOf.get(p.profileId)]).filter(([, v]) => v);
}

// 대조 값 조회(ADR-0023): 차가 이 여행의 등록값을 받아 가 차 안에서 대조한다. 녹음에 동의한 참가자가, 동의한 참가자의 값만.
// 다른 임베더로 만든 값(길이가 다름)은 주지 않는다. 기준값을 함께 줘 차가 서버와 같은 기준을 쓴다.
// 값을 모으는 동안(여행 DB와 프로필 DB는 서로 달라 한 트랜잭션으로 묶이지 않는다) 누군가 동의를 철회하면, 철회 전의 참가자 목록으로
// 그 사람의 프로필 등록값을 읽어 내줄 수 있다. 그래서 값을 다 읽은 뒤 여행을 다시 읽어, 동의 세대가 그대로일 때만 돌려준다 —
// 철회는 세대를 올리므로 세대가 같으면 그 사이 꺼진 동의가 없다. 달라졌으면 읽은 값을 버리고 새 여행으로 다시 한다.
// 동의·세대·값이 한 시점의 것이 되고, 응답의 generation도 그 시점의 값이다. 여행 줄은 잠그지 않는다(voiceMatch와 같은 까닭).
async function voicePrints(code, req) {
  if (req.method !== "GET") fail(405, "GET만 됨");
  const read = async () => {
    const trip = await withTrip(code, false, (t) => t);
    if (!participantOf(req, trip).consent) fail(403, "녹음에 동의한 참가자만 받을 수 있음");
    return trip;
  };
  let trip = await read();
  for (let tries = 0; tries < 3; tries++) {
    const prints = await printsOf(trip);
    const after = await read();
    if ((after.generation ?? 1) === (trip.generation ?? 1)) {
      // 세대를 올리지 않고 빠진 사람(참가자 삭제)도 뺀다
      const here = new Set(after.participants.filter((p) => p.consent).map((p) => p.id));
      const items = prints.filter(([p, v]) => here.has(p.id) && v.vector.length === DIMS)
        .map(([p, v]) => ({ participantId: p.id, vector: v.vector, seconds: v.seconds, source: v.source }));
      return [200, { generation: after.generation ?? 1, embedder: EMBEDDER, dims: DIMS, threshold: matchThreshold(), floor: matchFloor(), margin: matchMargin(), items }, "private, no-store"];
    }
    trip = after;
  }
  fail(409, "동의가 바뀌는 중. 다시 받아 주세요");
}

// 발화 대조(ADR-0008·0019): 발화 음성과 좌석 구역(앞줄·뒷줄)을 받아 그 줄 참가자의 등록 목소리와 비교해
// 참가자와 확신도를 돌려준다. 확신이 낮으면 '모름'(participantId: null).
// 원본 음성은 저장하지 않고, 찾으면 그 발화 줄의 participant_id(프로필 참가자면 profile_id도)를 채운다(ADR-0014).
// 여행 문서를 바꾸지 않으므로 여행 줄을 잠그지 않는다 — 본문(최대 1 MB)을 받고 계산하는 동안
// 같은 여행의 동의 바꾸기를 막으면, 업로드가 느릴 때 동의 철회가 2초 제한(T26)에 걸려 실패한다.
async function voiceMatch(code, req, query) {
  if (req.method !== "POST") fail(405, "POST만 됨");
  // 녹음에 동의한 참가자만 — 동의하지 않은 사람이 목소리로 남을 찾아보는 길이 되지 않게.
  const consenting = (trip) => {
    const caller = participantOf(req, trip);
    return caller.consent ? caller : fail(403, "녹음에 동의한 참가자만 대조할 수 있음");
  };
  await withTrip(code, false, consenting);
  const { samples } = wavMono(await readRaw(req, 1_000_000));
  const seconds = samples.length / 16000;
  // ponytail: 임베딩은 이벤트 루프에서 동기로 돈다(10초 ≈ 30 ms, 60초 ≈ 185 ms). 발화는 보통 2~4초라 10초로 묶는다.
  if (seconds < 0.5 || seconds > 10) fail(400, "발화 음성은 0.5~10초");
  // 본문을 받는 동안 동의·자리가 바뀌었을 수 있으니 최신 여행으로 다시 보고 후보를 정한다(잠그지 않고 읽기만).
  const trip = await withTrip(code, false, (t) => t);
  const caller = consenting(trip);
  // 후보: 그 줄(row 1 앞줄, 2 뒷줄 — 차량 앱의 좌석 구역 판정, T37)에 앉은, 녹음에 동의한 참가자. 줄을 모르면 그 줄 조건만 뺀다.
  // 값은 이 여행에 등록한 것을 먼저, 없으면 그 사람 프로필의 등록값을 쓴다 — 동의하지 않은 사람의 이름은 발화에 붙지 않는다.
  const row = query.get("row") ? oneOf(query.get("row"), ["1", "2"], "row") : null;
  const threshold = matchThreshold();
  const candidates = await printsOf(trip, (p) => !row || p.seat.startsWith(`ROW_${row}_`));
  if (!candidates.length) return [200, { participantId: null, profileId: null, confidence: 0, threshold, applied: false }];
  const vector = embed(samples);
  let best = null;
  let bestSim = -1;
  for (const [p, { vector: v }] of candidates) {
    const s = similarity(vector, v);
    if (s > bestSim) {
      bestSim = s;
      best = p;
    }
  }
  const matched = bestSim >= threshold ? best : null;
  let applied = false;
  if (matched && query.get("device") && query.get("seq")) {
    // 찾았으면 그 발화 줄에 화자를 채운다(ADR-0014). 발화가 아직 안 왔다면 채우지 않고 결과만 돌려준다.
    // 그 발화를 올린 기기(참가자)만, 아직 화자가 없는 줄에만 붙인다 — 남의 줄에 이름을 붙이거나 바꿔 지우지 못하게.
    const device = text(query.get("device"), 40, "device");
    const seq = int(Number(query.get("seq")), 1, 1_000_000_000, "seq");
    const { rowCount } = await tripsDb().query(
      `UPDATE utterances u SET participant_id = $2, profile_id = $6, speaker_confidence = $7, speaker_method = 'server-voice' FROM utterance_acks a
       WHERE u.trip_code = $1 AND u.device = $3 AND u.seq = $4 AND u.participant_id IS NULL AND u.profile_id IS NULL AND NOT u.speaker_by_hand
         AND a.trip_code = u.trip_code AND a.device = u.device AND a.participant_id = $5`,
      [trip.code, matched.id, device, seq, caller.id, matched.profileId ?? null, bestSim]
    );
    applied = rowCount > 0;
  }
  return [200, { participantId: matched?.id ?? null, profileId: matched?.profileId ?? null, confidence: Math.round(bestSim * 1000) / 1000, threshold, applied }];
}

// 녹음 클립(T76, docs/api/voice.md): 사람이 장면으로 고른 구간의 원음. 장면 하나에 클립 하나라 클립 id는 장면 id다.
// 소리는 클립 버킷(providers/clips.js)에, 정보는 recordings 표에 둔다. 차가 자른 WAV를 그대로 두고 다시 자르지 않는다.
const CLIP_MAX = 5_000_000;
const asRecording = (r) => ({ id: r.moment_id, momentId: r.moment_id, startAt: Number(r.start_at), seconds: r.seconds, bytes: r.bytes });

// 지울 키(clip_trash)를 버킷에서 지운다. 커밋 뒤와 치우기(10분마다)에서 돈다. 실패하면 키가 남아 다음에 다시 한다.
// 던지지 않는다 — 부르는 쪽은 기다리지 않는다. 그래도 남는 것(DB에도 못 적은 것)은 버킷 수명 규칙(2일, T64)이 치운다.
async function sweepClips() {
  const store = clipStore();
  if (!store) return;
  try {
    const { rows } = await tripsDb().query("SELECT object_key FROM clip_trash ORDER BY since LIMIT 1000");
    if (!rows.length) return;
    const keys = rows.map((r) => r.object_key);
    await store.remove(keys);
    await tripsDb().query("DELETE FROM clip_trash WHERE object_key = ANY($1::text[])", [keys]);
  } catch (e) {
    log("warn", "clip_sweep_failed", { err: errFields(e) });
  }
}
// 남기지 못한 소리의 키를 적고 바로 한 번 비운다. 던지지 않는다.
const trashClips = (keys) =>
  tripsDb()
    .query("INSERT INTO clip_trash (object_key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [keys])
    .then(() => void sweepClips())
    .catch((e) => log("warn", "clip_trash_failed", { err: errFields(e) }));

async function recordings(code, id, req, query) {
  const m = req.method;
  if (!id && m !== "POST") fail(405, "POST만 됨");
  if (id && m !== "GET" && m !== "DELETE") fail(405, "GET, DELETE만 됨");
  const store = clipStore() ?? fail(503, "클립 저장소가 없음"); // CLIPS_BUCKET이 없는 환경(로컬·E2E)
  const live = async (client, trip) =>
    (await client.query("SELECT object_key FROM recordings WHERE trip_code = $1 AND moment_id = $2 AND deleted_at IS NULL", [trip.code, id])).rows[0] ?? fail(404, "없는 클립");

  if (m === "GET") {
    // 기록본과 같은 규칙: 녹음에 동의한 참가자만. 소리는 잠금 밖에서 받는다. 토큰은 머리말로만 —
    // 웹은 fetch → blob → <audio>로 튼다(클립 하나 약 0.5~1.1 MB). 서명한 S3 주소는 주지 않는다(ADR-0021).
    const { object_key } = await withTrip(code, false, (trip, client) =>
      participantOf(req, trip).consent ? live(client, trip) : fail(403, "녹음에 동의한 참가자만 들을 수 있음")
    );
    return [200, (await store.get(object_key)) ?? fail(404, "없는 클립"), "audio/wav"];
  }
  if (m === "DELETE") {
    // 이 여행의 참가자라면 누구나 — 동의 끄기처럼 지우는 쪽은 넓게 둔다. 버킷에서 먼저 지우고(실패하면 503, 다시 하면 됨)
    // 줄에는 지운 표시를 남긴다: 차가 늦게 다시 올려도 되살아나지 않게. 받아 적은 글과 장면은 그대로다.
    const { caller, row } = await withTrip(code, false, async (t, client) => ({ caller: participantOf(req, t), row: await live(client, t) }));
    await store.remove([row.object_key]);
    // 버킷을 기다리는 사이 동의 철회가 줄을 지웠거나 같은 장면이 새로 올라왔을 수 있다. 여행 줄을 잠그고(철회·올리기와 차례를 맞춤) 다시 본다:
    // 다른 키의 새 클립이 살아 있으면 건드리지 않고 409(다시 지우면 됨), 아니면 지운 표시를 남긴다 — 줄이 없어졌으면 표시만 있는 줄을 새로 적는다.
    return withTrip(code, true, async (t, client) => {
      const { rows } = await client.query("SELECT object_key, deleted_at FROM recordings WHERE trip_code = $1 AND moment_id = $2", [t.code, id]);
      const now = rows[0];
      if (now && !now.deleted_at && now.object_key !== row.object_key) fail(409, "그 사이 같은 장면의 클립이 새로 올라옴 — 다시 지워 주세요");
      if (now) await client.query("UPDATE recordings SET deleted_at = now() WHERE trip_code = $1 AND moment_id = $2 AND deleted_at IS NULL", [t.code, id]);
      else
        await client.query(
          "INSERT INTO recordings (trip_code, moment_id, generation, participant_id, object_key, start_at, bytes, seconds, deleted_at) VALUES ($1, $2, $3, $4, $5, 0, 0, 0, now())",
          [t.code, id, t.generation ?? 1, caller.id, row.object_key]
        );
      return [204];
    });
  }

  // 올리기. 본문(5 MB까지)을 받아 버킷에 두는 동안 여행 줄을 잠그지 않는다(voice-match와 같은 까닭: 느린 업로드가
  // 동의 철회를 2초 제한에 걸리게 하지 않게). 그래서 받기 전에 한 번, 둔 뒤에 잠그고 한 번 더 본다.
  // 그 사이 동의가 철회됐거나 누가 지웠으면 둔 것을 지우고 거절한다.
  const check = async (trip, client) => {
    const caller = participantOf(req, trip);
    const momentId = text(query.get("moment") ?? undefined, 40, "moment");
    const moment = trip.moments.find((x) => x.id === momentId) ?? fail(404, "없는 장면");
    const current = trip.generation ?? 1;
    // 녹음할 때의 동의 세대. 옛 세대는 철회 전의 소리라 받지 않는다 — 차는 버린다(ADR-0007).
    // 동의 확인보다 먼저 본다: 철회한 본인의 토큰으로 올려도 '나중에 다시'(403)가 아니라 '버림'(409)이 되게.
    if (int(Number(query.get("generation")), 1, current, "generation") < current) fail(409, "동의가 바뀌기 전의 소리라 받지 않음");
    // 클립 첫 표본의 시각. 자막(발화 시각)을 소리에 맞추는 기준이다(T43).
    const startAt = int(Number(query.get("from")), trip.createdAt - 60_000, Date.now() + 60_000, "from");
    if (!caller.consent) fail(403, "녹음에 동의한 참가자만 올릴 수 있음");
    if (!everyoneConsents(trip)) fail(403, "동의하지 않은 탑승자가 있어 올릴 수 없음"); // 발화 올리기와 같은 규칙
    const { rows } = await client.query("SELECT moment_id, start_at, bytes, seconds, deleted_at FROM recordings WHERE trip_code = $1 AND moment_id = $2", [trip.code, momentId]);
    if (rows[0]?.deleted_at) fail(409, "지운 클립은 다시 받지 않음");
    return { caller, momentId, moment, startAt, tripCode: trip.code, current, existing: rows[0] };
  };
  const before = await withTrip(code, false, check);
  if (before.existing) return [200, asRecording(before.existing)]; // 같은 장면을 다시 보냄(멱등)
  const raw = await readRaw(req, CLIP_MAX);
  const { samples, channels } = wavMono(raw); // WAV·16 kHz·16비트가 아니면 400
  if (channels !== 1) fail(400, "모노 WAV만 됨");
  if (!samples.length) fail(400, "소리가 비어 있음");
  const seconds = Math.round(samples.length / 16) / 1000;
  // 사람이 확정한 장면 구간의 소리만 받는다(ADR-0007). 구간이 없는 장면은 at 앞 20초~뒤 10초(scenes.js의 momentSpan).
  // 차의 시계와 자르기 여유로 앞뒤 1초는 봐준다. 밖이면 버킷에 두기 전에 400 — 차는 버린다.
  const span = momentSpan(before.moment);
  if (before.startAt < span.from - 1000 || before.startAt + seconds * 1000 > span.to + 1000) fail(400, "장면 구간 밖의 소리");
  const key = `${before.tripCode}/${before.momentId}-${randomUUID().slice(0, 8)}.wav`;
  try {
    await store.put(key, raw); // 늦게 실패해도(제한 시간 뒤에 저장됨) 아래에서 키를 버린다
    const result = await withTrip(code, true, async (trip, client) => {
      const now = await check(trip, client);
      if (now.existing) return [200, asRecording(now.existing)];
      await client.query(
        "INSERT INTO recordings (trip_code, moment_id, generation, participant_id, object_key, start_at, bytes, seconds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [trip.code, now.momentId, now.current, now.caller.id, key, now.startAt, raw.length, seconds]
      );
      return [201, asRecording({ moment_id: now.momentId, start_at: now.startAt, seconds, bytes: raw.length })];
    });
    if (result[0] === 200) await trashClips([key]); // 같은 장면을 동시에 올린 다른 요청이 먼저 남겼다 — 내 것은 버린다
    else queueRetranscribe(before.tripCode, before.momentId); // 새로 남긴 클립은 기다리지 않고 다시 받아 적는다(T75). 응답은 바로 간다
    return result;
  } catch (e) {
    await trashClips([key]); // 남기지 못한 소리는 버킷에 두지 않는다
    throw e;
  }
}

// 재전사(T75): 클립 구간의 발화마다 그 소리와 Pleos 초안과 여행이 아는 낱말을 Nemotron에 보내(providers/asr.js)
// 고친 글을 asr_text에 남긴다. 원문(text)은 그대로다. ASR_URL·ASR_TOKEN이 없으면 건너뛴다.
// 실패·늦음·믿지 못할 답이면 그 줄은 원문 자막으로 남는다. 사람이 고른 클립만 보낸다(동의 문구, docs/api/voice.md).
// 보내기 직전마다 클립이 살아 있고(지우지 않음, 동의 철회 전 세대) 그 줄의 글이 그대로인지 본다 — 아니면 보내지 않고 붙이지 않는다.
// 자르기: 발화의 at을 말 시작으로 보고 0.5초 앞부터 같은 자리의 다음 말까지(다른 자리의 말은 겹칠 수 있다).
// 다음 말이 바로 붙어도 이 말의 어림 길이(글자당 0.15초, 1.5초 이상)는 남기고, 앞 0.5초를 넣어 15초·클립 끝을 넘지 않는다. 0.8초보다 짧으면 보내지 않는다.
// 한 프로세스에서 한 클립씩 차례로 돈다(요청 간격을 지키려고). 대기열은 클립 id만 쥐고 소리는 돌 때 클립 버킷에서 읽는다.
// 같은 클립이 이미 기다리면 다시 넣지 않고, 차면(10개) 새 클립은 원문 자막으로 남는다 — 그 여행에 발화가 더 오면 다시 예약된다.
// 클립마다 '여기까지 봤다'(asr_done_at)를 남겨, 다음 실행은 그 뒤에 들어온 줄만 보낸다(고치지 못한 줄을 되풀이해 보내지 않게).
// ponytail: 올린 파드의 메모리에서 기다린다. 그 사이 파드가 죽으면 그 여행에 발화가 다시 올 때 이어서 한다.
const ASR_QUEUE_MAX = 10;
const asrQueue = [];
let asrBusy = false;
function queueRetranscribe(code, momentId) {
  if (!asrReady() || !clipStore()) return;
  if (asrQueue.some((j) => j.code === code && j.momentId === momentId)) return;
  if (asrQueue.length >= ASR_QUEUE_MAX) return log("warn", "clip_retranscribe_dropped", { queued: asrQueue.length });
  asrQueue.push({ code, momentId });
  if (asrBusy) return;
  asrBusy = true;
  (async () => {
    while (asrQueue.length) await retranscribeClip(asrQueue.shift()).catch((e) => log("warn", "clip_retranscribe_failed", { err: errFields(e) }));
    asrBusy = false;
  })();
}

// 발화 묶음이 클립보다 늦게 왔으면 그 클립의 재전사는 줄 없이 끝났다. 클립 구간에 아직 보지 않은(표시 뒤에 들어온) 줄이 있으면 다시 예약한다.
async function requeueRetranscribe(code) {
  if (!asrReady() || !clipStore()) return;
  const { rows } = await tripsDb().query(
    `SELECT r.moment_id FROM recordings r WHERE r.trip_code = $1 AND r.deleted_at IS NULL AND EXISTS (
       SELECT 1 FROM utterances u WHERE u.trip_code = r.trip_code AND u.generation = r.generation AND u.text <> '' AND u.asr_text IS NULL
         AND (u.at >= r.start_at OR u.end_at > r.start_at) AND u.at < r.start_at + r.seconds * 1000 AND (r.asr_done_at IS NULL OR u.created_at > r.asr_done_at))`,
    [code]
  );
  for (const r of rows) queueRetranscribe(code, r.moment_id);
}

async function retranscribeClip({ code, momentId }) {
  // 표시를 먼저 옮기고(이번 실행이 볼 줄의 경계), 앞 표시 뒤에 들어온 줄만 보낸다. 자르기의 '같은 자리의 다음 말'은 모든 줄로 본다.
  const { rows: recs } = await tripsDb().query(
    `UPDATE recordings r SET asr_done_at = now() FROM (SELECT asr_done_at FROM recordings WHERE trip_code = $1 AND moment_id = $2) prev
     WHERE r.trip_code = $1 AND r.moment_id = $2 AND r.deleted_at IS NULL
     RETURNING r.object_key, r.start_at, r.generation, prev.asr_done_at AS since`,
    [code, momentId]
  );
  const rec = recs[0];
  const { rows: trips } = rec ? await tripsDb().query("SELECT doc FROM trips WHERE code = $1", [code]) : { rows: [] };
  const raw = trips[0] && (await clipStore()?.get(rec.object_key));
  if (!raw) return; // 그 사이 지웠거나 여행이 닫힘
  const pcm = Int16Array.from(wavMono(raw).samples, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))));
  const context = contextOf(trips[0].doc.participants.map((p) => p.name), trips[0].doc.title);
  const startAt = Number(rec.start_at);
  const generation = rec.generation;
  const clipMs = pcm.length / 16; // 16 kHz: 1 ms = 16 표본
  const live = "SELECT 1 FROM recordings WHERE trip_code = $1 AND moment_id = $2 AND generation = $3 AND deleted_at IS NULL";
  const { rows } = await tripsDb().query(
    `SELECT device, seq, at, end_at, text, seat_area, (asr_text IS NULL AND ($5::timestamptz IS NULL OR created_at > $5)) AS todo
     FROM utterances WHERE trip_code = $1 AND generation = $2 AND text <> '' AND (at >= $3 OR end_at > $3) AND at < $4 ORDER BY at`,
    [code, generation, startAt, startAt + Math.ceil(clipMs), rec.since]
  );
  const todo = rows.filter((r) => r.todo).length;
  const started = Date.now();
  const reasons = {};
  let fixed = 0;
  let changed = 0;
  let seen = 0;
  for (const [i, u] of rows.entries()) {
    if (!u.todo) continue;
    if (!(await tripsDb().query(live, [code, momentId, generation])).rows[0]) {
      reasons.stopped = (reasons.stopped ?? 0) + todo - seen; // 클립을 지웠거나 동의가 철회됨 — 남은 줄은 보내지 않는다
      break;
    }
    seen++;
    const at = Number(u.at) - startAt;
    const next = rows.slice(i + 1).find((r) => r.seat_area === u.seat_area);
    // 실제 끝 시각이 있으면 그 발화와 클립이 겹치는 소리만 보낸다. 구간을 늘리거나 겹친 화자의 다음 말에서 자르지 않는다.
    // 기존 APK처럼 끝 시각이 없는 발화만 앞 0.5초·같은 자리의 다음 말·글자 수로 어림한다.
    const from = Math.max(0, u.end_at != null ? at : at - 500);
    const to = u.end_at != null ? Math.min(clipMs, Number(u.end_at) - startAt)
      : Math.min(clipMs, from + 15_000, Math.max(next ? Number(next.at) - startAt : clipMs, at + Math.max(1500, [...u.text].length * 150)));
    const stillOk = async () =>
      (
        await tripsDb().query(
          `${live} AND EXISTS (SELECT 1 FROM utterances WHERE trip_code = $1 AND device = $4 AND seq = $5 AND text = $6 AND generation = $3)`,
          [code, momentId, generation, u.device, u.seq, u.text]
        )
      ).rows.length > 0;
    const result = to - from < 800 ? { reason: "short" } : await retranscribe(toWav(pcm.subarray(Math.round(from * 16), Math.round(to * 16))), u.text, context, stillOk);
    // 그 사이 지운 글·클립·철회된 동의면 붙이지 않는다
    const stored = result.text
      ? (
          await tripsDb().query(
            `UPDATE utterances SET asr_text = $6 WHERE trip_code = $1 AND device = $2 AND seq = $3 AND text = $4 AND generation = $5
             AND EXISTS (SELECT 1 FROM recordings WHERE trip_code = $1 AND moment_id = $7 AND generation = $5 AND deleted_at IS NULL)`,
            [code, u.device, u.seq, u.text, generation, result.text, momentId]
          )
        ).rowCount > 0
      : false;
    const reason = result.reason ?? (stored ? null : "stopped");
    if (reason) {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      continue;
    }
    fixed++;
    if (result.text.replace(/[\s\p{P}]/gu, "") !== u.text.replace(/[\s\p{P}]/gu, "")) changed++;
  }
  // 관측(T75): 다시 받아 적은 줄, 원문으로 남은 줄과 그 이유(timeout·http_NNN·suspicious·stopped 등), 원문과 글자가 달라진 줄, 걸린 시간.
  // 글과 토큰은 남기지 않는다.
  log("info", "clip_retranscribed", { lines: todo, fixed, fellBack: todo - fixed, reasons, changed, ms: Date.now() - started });
}

// T90: 48시간 자동 정리에 기대지 않고 명시적 삭제를 끝냅니다. 내가 보호자인 아이(managed_by)와,
// 내가 대표인 그룹의 아이(다른 성인이 보호자여도 — 그룹이 없어지면 다룰 사람이 없다, T133)의 프로필도 함께 지웁니다.
async function deleteProfiles(id) {
  const { rows } = await profilesDb().query(
    `WITH RECURSIVE owned AS (
       SELECT id FROM profiles WHERE id=$1
       UNION SELECT p.id FROM profiles p JOIN owned o ON p.managed_by=o.id
         OR (p.managed_by IS NOT NULL AND p.id IN (SELECT m.profile_id FROM group_members m JOIN groups g ON g.id=m.group_id WHERE g.owner_id=o.id))
     ) SELECT id FROM owned`, [id]);
  const all = [...new Set([id, ...rows.map(r => r.id)])];
  await withDeletingProfiles(all, async lockedClient => {
    const affected = await lockedClient.query("SELECT code FROM trips WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(doc->'participants') p WHERE p->>'profileId' = ANY($1::text[])) ORDER BY code", [all]);
    for (const { code } of affected.rows) await withTrip(code, true, async (trip, client) => {
      const removed = trip.participants.filter(p => all.includes(p.profileId));
      if (!removed.length) return;
      trip.recording = false;
      await bumpGeneration(trip, client);
      await client.query("DELETE FROM trip_voice_prints WHERE trip_code=$1 AND participant_id=ANY($2::text[])", [code, removed.map(p => p.id)]);
      trip.participants = trip.participants.filter(p => !all.includes(p.profileId));
      trip.requests = trip.requests.filter(r => !removed.some(p => p.id === r.by));
      trip.version++;
    }, lockedClient);
    await lockedClient.query("DELETE FROM ride_links WHERE profile_id=ANY($1::uuid[])", [all]);
  }, async db => {
    const { rows: owned } = await db.query("SELECT id FROM groups WHERE owner_id=ANY($1::uuid[])", [all]);
    const groups = owned.map(r => r.id);
    await db.query("DELETE FROM group_members WHERE group_id=ANY($1::text[]) OR profile_id=ANY($2::uuid[])", [groups, all]);
    await db.query("DELETE FROM invites WHERE group_id=ANY($1::text[])", [groups]);
    await db.query("DELETE FROM groups WHERE id=ANY($1::text[])", [groups]);
    await db.query("DELETE FROM profile_moments WHERE profile_id=ANY($1::uuid[])", [all]);
    await db.query("DELETE FROM tokens WHERE profile_id=ANY($1::uuid[])", [all]);
    await db.query("DELETE FROM profiles WHERE id=ANY($1::uuid[])", [all]);
  });
  void sweepClips();
}

// 여행 한 줄을 읽어 fn에 넘긴다. 바꾸는 요청이면 그 줄을 잠그고, 끝나면 문서를 다시 쓴다.
async function withTrip(code, write, fn, lockedClient) {
  const client = lockedClient ?? await tripsDb().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT doc, created_at FROM trips WHERE code = $1 ${write ? "FOR UPDATE" : ""}`, [String(code).toUpperCase()]);
    if (!rows[0]) fail(404, "없는 여행 코드");
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
    if (!lockedClient) client.release();
  }
}

async function trips(req, [code, sub, id, leaf, ...rest], b, query, signal) {
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
    if (b.groupId !== undefined) return groupTrip(req, b, trip);
    await sweep(); // 여행을 만들 때마다 묵은 여행을 치운다(10분마다도 돈다)
    for (;;) {
      trip.code = newCode();
      const { rowCount } = await tripsDb().query("INSERT INTO trips (code, doc) VALUES ($1, $2) ON CONFLICT DO NOTHING", [trip.code, trip]);
      if (rowCount) return [201, trip];
    }
  }
  if ((sub === "short-plans" || sub === "short-generations") && !rest.length) return shortService.request(req, code, sub, id, leaf, b);
  if (sub === "short-assets" && !rest.length) return shortAssetService.request(req, code, id, leaf, query);
  if (sub === "audio" && !rest.length) return tripAudioService.request(req, code, id, leaf, b, query); // 전체 음성(ADR-0024)
  if (rest.length || (leaf !== undefined && !(sub === "participants" && leaf === "voice") && sub !== "utterances" && sub !== "captions")) fail(404, "없는 경로");
  if (sub === "boarding-invites") return tripBoardingInvites(req, code, id, { withTrip, participantOf });
  if (sub === "captions") {
    if (!id || !leaf || rest.length) fail(404, "자막 경로에 기기와 순번이 필요함");
    if (m !== "PATCH") fail(405, "PATCH만 됨");
    let device;
    try { device = decodeURIComponent(id); } catch { fail(400, "device: 잘못된 URI 인코딩"); }
    device = text(device, 40, "device");
    if (!/^[1-9][0-9]*$/.test(leaf)) fail(400, "seq: 양의 정수");
    const sequence = int(Number(leaf), 1, 1_000_000_000, "seq");
    return withTrip(code, true, async (trip, client) => {
      const caller = participantOf(req, trip);
      if (!caller.consent) fail(403, "녹음에 동의한 참가자만 고칠 수 있음");
      const generation = int(b.generation, 1, 2_147_483_647, "generation");
      if (generation !== (trip.generation ?? 1)) fail(409, "동의 세대가 바뀜 — 기록본을 다시 읽어 주세요");
      const expected = int(b.expectedVersion, 0, 2_147_483_646, "expectedVersion");
      const edited = b.text === null ? null : text(b.text, 500, "text");
      const args = [trip.code, device, sequence, generation];
      const live = "trip_code = $1 AND device = $2 AND seq = $3 AND generation = $4 AND text <> ''";
      if (!(await client.query(`SELECT 1 FROM utterances WHERE ${live}`, args)).rowCount) fail(404, "없는 발화");
      const { rows } = await client.query(
        `UPDATE utterances SET edited_text = $5, edit_version = edit_version + 1, edited_by = $6, edited_at = now()
         WHERE ${live} AND edit_version = $7 RETURNING *`, [...args, edited, caller.id, expected]
      );
      if (!rows[0]) fail(409, "다른 사람이 먼저 고침 — 기록본을 다시 읽어 주세요");
      return [200, { generation, utterance: asUtterance(rows[0]) }];
    });
  }
  if (sub === "voice-match" && !id) return voiceMatch(code, req, query);
  if (sub === "voice-prints" && !id) return voicePrints(code, req);
  if (sub === "transcriptions" && !id) return transcriptions(code, req, query, signal);
  // 차의 클립이 없는 장면은 전체 음성에서 잘라 클립으로 남긴 뒤 같은 길로 준다(ADR-0024)
  if (sub === "recordings" && id && m === "GET") await tripAudioService.cutScenes(req, code, id);
  if (sub === "recordings") return recordings(code, id, req, query);
  if (sub === "participants" && m === "POST" && !id && b.profileId !== undefined) fail(410, RETIRED_GROUP);
  if (leaf === "voice") return participantVoice(code, id, req);
  if (sub === "shortform" && m === "GET" && !id) await tripAudioService.cutScenes(req, code);
  const profile = sub === "participants" && m === "POST" && !id ? await profileOf(req) : null;
  const act = (activeProfile, lockedClient) => withTrip(code, m !== "GET", (trip, client) => handle(trip, { req, m, sub, id, leaf, b, query, profile: activeProfile }, client), lockedClient);
  const result = profile ? await withActiveProfile(profile.id, db => profileOf(req, db), act) : await act(null);
  if (sub === "scene-suggestions" && result[0] === 200) result[1].items = await tripAudioService.audible(code, result[1].items);
  if (sub === "participants" && m === "PATCH") void sweepClips(); // 동의 철회가 적은 클립을 커밋 뒤에 버킷에서 지운다
  // 커밋 뒤에: 클립보다 늦게 온 발화를 다시 받아 적는다(T75)
  if (sub === "utterances" && m === "POST") requeueRetranscribe(String(code).toUpperCase()).catch((e) => log("warn", "clip_retranscribe_failed", { err: errFields(e) }));
  return result;
}

// 그룹으로 여행 만들기(T133): 자리가 정해진 구성원을 그 자리로 넣는다. 동의는 각자의 계정 동의(아이는 보호자 동의,
// 지금 문구 판일 때만 — T128과 같은 규칙). 모든 참가자에 profileId를 붙인다: 차 안 화자 식별이 /voice-prints에서
// 프로필 목소리 값을 받아 간다(ADR-0023, 토큰 없는 아이 포함). 참가자 토큰은 부른 사람과 그가 보호자인 아이 몫만 준다 —
// 다른 성인은 자기 폰에서 프로필로 다시 참가(POST /participants)해 받는다(있던 참가자를 돌려주고 토큰만 새로).
// 부른 사람의 프로필 잠금 안에서 만든다(참가와 같은 순서). 다른 구성원의 프로필 지우기와 겹치면 지운 사람이 남을 수 있다 —
// 그 여행에서는 프로필 지우기가 다시 돌 때 정리된다.
async function groupTrip(req, b, trip) {
  const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
  if (typeof b.groupId !== "string") fail(400, "groupId: 그룹 id");
  await sweep();
  let profileClient;
  return withActiveProfile(me.id, (db) => ((profileClient = db), profileOf(req, db)), async (caller, client) => {
    const group = await groupForTrip(caller.id, b.groupId, profileClient);
    Object.assign(trip, { groupId: group.id, groupName: group.name });
    const tokens = {};
    for (const member of group.members) {
      const token = randomBytes(32).toString("base64url");
      const p = { id: randomUUID().slice(0, 8), profileId: member.profileId, name: member.name, character: member.character, seat: member.seat, consent: member.consent, tokenHash: tokenHash(token).toString("hex") };
      trip.participants.push(p);
      if (member.profileId === caller.id || member.guardianId === caller.id) tokens[p.id] = token;
    }
    for (;;) {
      trip.code = newCode();
      const { rowCount } = await client.query("INSERT INTO trips (code, doc) VALUES ($1, $2) ON CONFLICT DO NOTHING", [trip.code, trip]);
      if (rowCount) return [201, { ...tripView(trip), groupId: group.id, groupName: group.name, tokens }];
    }
  });
}

// 직접 삭제·동의 철회로 적어 둔 원음만 정리합니다. 여행의 나이로 데이터를 지우지 않습니다.
export async function sweep() {
  await tripAudioService.expire(); // 다 올린 뒤 2일이 지난 여행 전체 음성(ADR-0024)을 지울 목록에 넣는다
  await sweepClips();
  await shortAssetService.sweep();
}

async function handle(trip, { req, m, sub, id, leaf, b, query, profile }, client) {
  if (sub === "me") {
    if (id !== undefined) fail(404, "없는 경로");
    if (m !== "GET") fail(405, "GET만 됨");
    // 동의하기 전에도 저장된 토큰의 주체를 확인한다. 토큰·프로필·다른 참가자는 반환하지 않는다.
    const { id: participantId, name, seat, consent } = participantOf(req, trip);
    return [200, { id: participantId, name, seat, consent }];
  }
  if (sub === "shares" && !id) {
    if (m !== "POST") fail(405, "POST만 됨");
    return createShare(client, trip, participantOf(req, trip), b);
  }
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
      const was = trip.status;
      trip.status = oneOf(b.status, TRIP_STATUS, "status");
      // 출발·끝 시각(T131, 내 여행 목록): 처음 주행을 시작한 때, 마지막으로 끝낸 때. 끝낸 여행을 다시 출발하면 끝 시각을 지운다.
      if (trip.status === "driving") trip.startedAt ??= Date.now();
      if (trip.status !== "ended") delete trip.endedAt;
      else if (was !== "ended") trip.endedAt = Date.now();
      if (!["parked", "ended"].includes(trip.status)) delete trip.arrival; // 다시 출발하면 지난 도착은 끝난다(T119)
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
      // 같은 프로필이 다시 참가하면 이미 있는 참가자를 돌려준다(폰을 바꿨거나 토큰을 잃었을 때).
      // 참가자 토큰은 문서에 해시만 남으니 이 기기에 쓸 토큰을 새로 만들어 준다. 앞서 준 토큰도 최근 4개까지 산다(T68) —
      // 남이 끈 동의를 본인이 다시 켜려면 토큰이 있어야 하니, 잃었으면 다시 참가해 받는다.
      const again = profile && trip.participants.find((p) => p.profileId === profile.id);
      if (again) {
        const token = randomBytes(32).toString("base64url");
        again.olderTokenHashes = [...(again.olderTokenHashes ?? []), again.tokenHash].slice(-4);
        again.tokenHash = tokenHash(token).toString("hex");
        return changed(200, { ...asParticipant(again), token });
      }
      const seat = oneOf(b.seat, SEATS, "seat");
      const p = profile
        // 동의를 보내지 않으면: 본인의 계정 동의(지금 문구 판)가 켜져 있으면 켠 채로, 아니면 지금처럼 프로필의 기본값(T128).
        ? { name: profile.name, consent: b.consent === undefined ? accountConsents(profile) || profile.consentDefault : bool(b.consent, "consent"), profileId: profile.id }
        : { name: text(b.name, 20, "name"), consent: bool(b.consent, "consent") };
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
      const seat = b.seat === undefined ? undefined : oneOf(b.seat, SEATS, "seat");
      const consent = b.consent === undefined ? undefined : bool(b.consent, "consent");
      // 동의 켜기는 그 참가자 본인의 참가자 토큰으로만(T68, ADR-0009 '각자 따로'). 끄기와 자리는 누구나 —
      // 끄기는 기록을 멈추는 쪽이고, 자리는 차 화면이 폰으로 들어온 사람의 것을 고른다(T46).
      if (consent && participantOf(req, trip) !== p) fail(403, "동의는 본인만 켤 수 있음");
      if (seat !== undefined) {
        if (!seatFree(seat, p)) fail(409, "이미 다른 사람이 앉은 자리");
        p.seat = seat;
      }
      if (consent !== undefined) {
        const was = p.consent;
        p.consent = consent;
        if (!consent) trip.recording = false;
        // 동의가 꺼지면 이 여행에 등록한 목소리 값도 바로 지운다(T38, ADR-0019). 꺼져 있다 켜질 때도 지운다 —
        // 배포 중 옛 파드가 끄기를 받아 남긴 값이 다시 켠 뒤에 쓰이지 않게(다시 켰으면 다시 등록한다).
        if (!consent || !was) await client.query("DELETE FROM trip_voice_prints WHERE trip_code = $1 AND participant_id = $2", [trip.code, p.id]);
        // 켜져 있던 동의를 끊을 때만 세대를 올린다. 받아 둔 발화도 못 쓰게 한다(ADR-0007). 이미 꺼진 것을 다시 꺼도 그대로.
        if (was && !consent) await bumpGeneration(trip, client);
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

  if (sub === "places") {
    // 장소 기록(T131): 차가 내비의 출발·경유·곧 도착·도착·목적지를 남긴다(그 여행의 참가자 토큰으로, 녹음 동의와 무관).
    // 읽기는 /todos의 도착 장소(T119)와 같은 규칙으로 녹음에 동의한 참가자만 — 토큰 없는 여행 문서에는 싣지 않는다.
    if (id) fail(404, "없는 경로");
    if (m === "GET") {
      if (!participantOf(req, trip).consent) fail(403, "녹음에 동의한 참가자만 볼 수 있음");
      return [200, { items: trip.places ?? [] }];
    }
    if (m !== "POST") fail(405, "GET, POST만 됨");
    return changed(201, addPlace(trip, participantOf(req, trip), b, { text, num, int, oneOf }));
  }

  if (sub === "contents") {
    // 콘텐츠 기록(F6): 프로필 토큰이 없는 기기(차)가 이 여행 하나를 /profiles/me/trips 항목과 같은 모양으로 읽는다(places.js).
    if (id) fail(404, "없는 경로");
    if (m !== "GET") fail(405, "GET만 됨");
    return tripContents(trip, participantOf(req, trip), freshMedia);
  }

  if (sub === "moments" && m === "POST" && !id) {
    // 대화가 재미있던 순간의 시각과 위치. 클립과 주행 기억 지도가 이 기록을 쓴다.
    // 위치 없는 장면도 저장한다(ADR-0007): 목록에는 있고 지도에는 없다. 좌표는 둘 다 있거나 둘 다 없음만 받는다.
    if (trip.moments.length >= 500) fail(409, "장면이 너무 많음");
    const hasLat = b.lat !== undefined;
    if (hasLat !== (b.lng !== undefined)) fail(400, "lat, lng: 둘 다 있거나 둘 다 없음");
    const hasSpan = b.from !== undefined;
    if (hasSpan !== (b.to !== undefined)) fail(400, "from, to: 둘 다 있거나 둘 다 없음");
    // 고른 사람은 본문이 아니라 요청의 참가자 토큰으로 정한다. 토큰 없이 남긴 장면은 여행에만 남는다.
    const picker = req.headers.authorization ? participantOf(req, trip) : null;
    const now = Date.now();
    const at = b.at === undefined ? now : int(b.at, trip.createdAt, now + 60_000, "at"); // 통신이 끊겼다가 나중에 올리는 경우
    // 장면 구간(T43): 차가 이 구간을 잘라 클립으로 올린다(T63). from ≤ at ≤ to, 1~60초. 없으면 at 앞 20초~뒤 10초(scenes.js).
    const from = hasSpan ? int(b.from, at - 60_000, at, "from") : null;
    const moment = {
      id: randomUUID().slice(0, 8),
      at,
      ...(hasSpan ? { from, to: int(b.to, Math.max(at, from + 1000), from + 60_000, "to") } : {}),
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

  if (sub === "utterances" && id) {
    // 사람이 고친 화자(T37): 차 화면에서 '모름'이나 틀린 이름을 고친다. 그 기기 이름으로 발화를 올린 참가자만 —
    // 올리기의 기기 주인 규칙과 같다. 사람이 고친 것이 대조보다 우선이라 이미 붙은 화자도 바꾸고,
    // 고친 줄(speaker_by_hand)은 뒤늦게 끝난 대조가 다시 채우지 않는다('모름'으로 고친 것도).
    if (m !== "PATCH" || leaf === undefined) fail(405, "PATCH /utterances/:device/:seq만 됨");
    const caller = participantOf(req, trip);
    // 기기 이름은 올리기 본문의 글자 그대로라 공백·한글이 있을 수 있다. 주소의 마디를 한 번 풀어 맞춘다.
    let raw;
    try {
      raw = decodeURIComponent(id);
    } catch {
      fail(400, "device: 잘못된 주소 인코딩");
    }
    const device = text(raw, 40, "device");
    const seq = int(Number(leaf), 1, 1_000_000_000, "seq");
    if (b.participantId !== null && typeof b.participantId !== "string") fail(400, "participantId: 이 여행의 참가자 id 또는 null");
    const who = b.participantId === null ? null : (trip.participants.find((p) => p.id === b.participantId) ?? fail(400, "participantId: 이 여행의 참가자 id 또는 null"));
    if (who && !who.consent) fail(409, "녹음에 동의하지 않은 참가자의 이름은 붙이지 않음");
    const { rows: ack } = await client.query("SELECT participant_id FROM utterance_acks WHERE trip_code = $1 AND device = $2", [trip.code, device]);
    if (ack[0] && ack[0].participant_id !== caller.id) fail(403, "그 기기로 올린 참가자만 고침");
    const { rows } = await client.query(
      `UPDATE utterances SET participant_id = $4, profile_id = $5, speaker_by_hand = true, speaker_confidence = NULL, speaker_method = NULL WHERE trip_code = $1 AND device = $2 AND seq = $3 AND text <> ''
       RETURNING device, seq, at, text, asr_text, seat_area, participant_id, profile_id, confidence, lat, lng, end_at, speaker_label, speaker_scope, speaker_confidence, speaker_method`,
      [trip.code, device, seq, who?.id ?? null, who?.profileId ?? null]
    );
    return rows[0] ? [200, asUtterance(rows[0])] : fail(404, "없는 발화");
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
      // `.`·`..`는 주소 마디로 쓰면 URL 정규화로 사라져(자막·화자 고치기 경로) 그 발화를 다시 가리킬 수 없다 — 받지 않는다(Astra, #202).
      if (device === "." || device === "..") fail(400, "device: . 과 .. 은 쓸 수 없음");
      // 기기 이름은 처음 올린 참가자의 것이다. 다른 참가자가 같은 이름으로 순번을 먼저 차지해 진짜 발화를 밀어내지 못하게.
      const { rows: ack } = await client.query("SELECT last_seq, participant_id FROM utterance_acks WHERE trip_code = $1 AND device = $2", [trip.code, device]);
      if (ack[0] && ack[0].participant_id !== caller.id) fail(403, "다른 참가자가 올리는 기기");
      // 동의하지 않은 탑승자가 있는 동안은 받지 않는다(voice.md). 확인 순번도 오르지 않으니 차량은 모두 동의한 뒤 다시 보낸다.
      if (!everyoneConsents(trip)) fail(403, "동의하지 않은 탑승자가 있어 올릴 수 없음");
      const items = Array.isArray(b.items) ? b.items : fail(400, "items: 배열");
      if (items.length > 500) fail(400, "items: 한 번에 500개까지");
      // 화자는 차가 차 안에서 대조한 참가자 id만 받는다(ADR-0023, 선택 칸). 이 기기의 발화에만(위의 기기 주인 검사),
      // 녹음에 동의한 이 여행의 참가자만 — 모르는 id는 묶음을 거절하지 않고 화자 없이 저장한다(거절하면 확인 순번이 멈춤).
      // profileId는 받지 않고 참가자에서 찾는다.
      const rows = items.map((it, i) => {
        const u = obj(it, `items[${i}]`);
        const seq = int(u.seq, 1, 1_000_000_000, `items[${i}].seq`);
        const generation = int(u.generation ?? b.generation, 1, current, `items[${i}].generation`);
        // 옛 세대는 저장하지 않으니 순번과 세대만 본다. 차량은 동의가 꺼질 때 내용을 버리고 {seq, generation}만 보내 확인받는다(ADR-0007).
        if (generation < current) return [trip.code, device, seq, null, null, null, null, null, null, generation, null, null, null, null, null, null, null];
        const hasLat = u.lat !== undefined;
        if (hasLat !== (u.lng !== undefined)) fail(400, `items[${i}].lat, lng: 둘 다 있거나 둘 다 없음`);
        const at = int(u.at, 0, Date.now() + 600_000, `items[${i}].at`);
        const endAt = u.endAt == null ? null : int(u.endAt, at + 1, at + 10_000, `items[${i}].endAt`);
        const speakerLabel = u.speakerLabel == null ? null : typeof u.speakerLabel === "string" && /^spk:[0-9]{1,4}$/.test(u.speakerLabel) ? u.speakerLabel : fail(400, `items[${i}].speakerLabel: 익명 spk:번호`);
        const speakerScope = u.speakerScope == null ? null : typeof u.speakerScope === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u.speakerScope) ? u.speakerScope.toLowerCase() : fail(400, `items[${i}].speakerScope: 전사 요청 UUID`);
        if ((speakerLabel === null) !== (speakerScope === null)) fail(400, `items[${i}].speakerLabel, speakerScope: 둘 다 있거나 둘 다 없음`);
        if (u.participantId != null && typeof u.participantId !== "string") fail(400, `items[${i}].participantId: 참가자 id`);
        if (u.participantId != null) oneOf(u.speakerMethod, ["device-voice"], `items[${i}].speakerMethod`);
        const speakerConfidence = u.participantId == null || u.speakerConfidence == null ? null : num(u.speakerConfidence, 0, 1, `items[${i}].speakerConfidence`);
        const who = u.participantId == null ? null : trip.participants.find((p) => p.id === u.participantId && p.consent);
        return [
          trip.code,
          device,
          seq,
          at,
          text(u.text, 500, `items[${i}].text`),
          u.seatArea == null ? null : oneOf(u.seatArea, SEATS, `items[${i}].seatArea`), // 모르는 구역은 비워 둔다(T37)
          u.confidence === undefined ? null : num(u.confidence, 0, 1, `items[${i}].confidence`),
          hasLat ? num(u.lat, -90, 90, `items[${i}].lat`) : null,
          hasLat ? num(u.lng, -180, 180, `items[${i}].lng`) : null,
          generation,
          endAt, speakerLabel, speakerScope,
          who?.id ?? null, who?.profileId ?? null, who ? speakerConfidence : null, who ? "device-voice" : null,
        ];
      });
      // 한 묶음에 같은 순번이 두 번이면 앞의 것만(아래 ON CONFLICT DO UPDATE는 한 문장에서 같은 줄을 두 번 건드리지 못한다).
      const seen = new Set();
      const fresh = rows.filter((r) => r[9] === current && !seen.has(r[2]) && seen.add(r[2]));
      // 한도는 새로 생길 줄만 센다. 이미 받은 순번(다시 보냄, 화자만 채우기)은 줄을 늘리지 않는다 — 한도에 닿은 여행에서도 화자는 채워진다.
      const { rows: count } = await client.query(
        "SELECT count(*)::int AS n, (count(*) FILTER (WHERE device = $2 AND seq = ANY($3::bigint[])))::int AS had FROM utterances WHERE trip_code = $1",
        [trip.code, device, fresh.map((r) => r[2])]
      );
      if (count[0].n + fresh.length - count[0].had > MAX_TRIP_UTTERANCES) fail(409, `이 여행의 발화가 한도(${MAX_TRIP_UTTERANCES}줄)에 닿음`);
      // 같은 (기기, 순번)은 다시 보내도 한 번만 남는다(멱등). 순서는 섞여도 좋다.
      for (let i = 0; i < fresh.length; i += 100) {
        const chunk = fresh.slice(i, i + 100);
        const values = chunk.map((_, j) => `(${Array.from({ length: 17 }, (_, k) => `$${j * 17 + k + 1}`).join(", ")})`).join(", ");
        await client.query(
          // 이미 받은 줄은 그대로 두되, 화자가 비어 있고 사람이 고치지 않은 줄에 화자가 붙어 다시 오면 화자만 채운다
          // (차가 대조 값을 늦게 받았을 때). 글을 지운 줄, 이미 화자가 있는 줄, 고친 줄은 건드리지 않는다.
          `INSERT INTO utterances (trip_code, device, seq, at, text, seat_area, confidence, lat, lng, generation, end_at, speaker_label, speaker_scope, participant_id, profile_id, speaker_confidence, speaker_method)
           VALUES ${values} ON CONFLICT (trip_code, device, seq) DO UPDATE
             SET participant_id = EXCLUDED.participant_id, profile_id = EXCLUDED.profile_id, speaker_confidence = EXCLUDED.speaker_confidence, speaker_method = EXCLUDED.speaker_method
             WHERE EXCLUDED.participant_id IS NOT NULL AND utterances.participant_id IS NULL AND utterances.profile_id IS NULL
               AND NOT utterances.speaker_by_hand AND utterances.text <> '' AND utterances.generation = EXCLUDED.generation`,
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
      const device = query.get("device") ? text(query.get("device"), 40, "device") : null; // 비면 모든 기기
      const params = [trip.code];
      let where = "trip_code = $1 AND text <> ''"; // 내용을 비운 줄(지운 글)은 빼고
      if (device) {
        params.push(device, int(Number(query.get("after") ?? 0), 0, 1_000_000_000, "after"));
        where += " AND device = $2 AND seq > $3";
      }
      const { rows } = await client.query(`SELECT device, seq, at, text, asr_text, edited_text, edit_version, edited_by, edited_at, seat_area, participant_id, profile_id, confidence, lat, lng, end_at, speaker_label, speaker_scope, speaker_confidence, speaker_method FROM utterances WHERE ${where} ORDER BY at`, params);
      return [200, { generation: trip.generation ?? 1, recording: trip.recording, items: rows.map(asUtterance) }];
    }
    if (m === "DELETE") {
      // 자기 글 지우기. 프로필로 참가한 사람만, 자기 이름이 붙은 발화만 지운다. 세대는 올리지 않는다 —
      // 세대를 올리면 옛 세대 전부, 곧 그 여행의 모든 사람 글이 지워진다.
      // 줄은 지우지 않고 내용만 비운다: 순번에 빈자리가 있던 기기가 같은 순번을 다시 보내도(멱등 키에 걸려) 되살아나지 않게.
      if (!caller.profileId) fail(403, "프로필로 참가한 사람의 글만 지울 수 있음");
      const { rowCount } = await client.query(
        "UPDATE utterances SET text = '', asr_text = NULL, edited_text = NULL, edit_version = 0, edited_by = NULL, edited_at = NULL, seat_area = NULL, confidence = NULL, lat = NULL, lng = NULL, end_at = NULL, speaker_label = NULL, speaker_scope = NULL WHERE trip_code = $1 AND profile_id = $2 AND text <> ''",
        [trip.code, caller.profileId]
      );
      return [200, { deleted: rowCount }];
    }
  }

  const readLines = async () => {
    if (!participantOf(req, trip).consent) fail(403, "녹음에 동의한 참가자만 볼 수 있음");
    const { rows } = await client.query("SELECT device, seq, at, text, asr_text, edited_text, edit_version, edited_by, edited_at, seat_area, participant_id, profile_id, confidence, lat, lng, end_at, speaker_label, speaker_scope, speaker_confidence, speaker_method FROM utterances WHERE trip_code = $1 AND generation = $2 AND text <> '' ORDER BY at, device, seq", [trip.code, trip.generation ?? 1]);
    return rows.map(asUtterance);
  };
  const todos = async (all) => {
    const { rows } = await client.query("SELECT id, status, version FROM todo_states WHERE trip_code=$1 AND generation=$2", [trip.code, trip.generation ?? 1]);
    return deriveTodos(all, rows);
  };

  if (sub === "todos" || sub === "arrival-briefing") {
    if (!(sub === "todos" && ((m === "GET" && !id) || (m === "PATCH" && id))) && !(sub === "arrival-briefing" && m === "POST" && !id)) fail(405, "GET /todos, PATCH /todos/:id, POST /arrival-briefing만 됨");
    const all = await readLines();
    const generation = trip.generation ?? 1;
    const items = await todos(all);
    if (sub === "todos" && m === "GET" && !id) return [200, { generation, method: TODO_METHOD, items, arrival: trip.arrival ?? null }];
    if (sub === "todos" && m === "PATCH" && id) {
      if (int(b.generation, 1, 2_147_483_647, "generation") !== generation) fail(409, "동의 세대가 바뀜 — 할 일을 다시 읽어 주세요");
      const expected = int(b.expectedVersion, 0, 2_147_483_646, "expectedVersion");
      const status = oneOf(b.status, ["pending", "done", "cancelled"], "status");
      const todo = items.find((item) => item.id === id) ?? fail(404, "없는 할 일 — 원문이 바뀌거나 지워졌을 수 있음");
      if (todo.version !== expected) fail(409, "다른 사람이 먼저 고침 — 할 일을 다시 읽어 주세요");
      await client.query(
        `INSERT INTO todo_states(trip_code,generation,id,status,version) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(trip_code,generation,id) DO UPDATE SET status=EXCLUDED.status, version=EXCLUDED.version, updated_at=now()`,
        [trip.code, generation, id, status, expected + 1]);
      return changed(200, { generation, item: { ...todo, status, version: expected + 1 } });
    }
    if (sub === "arrival-briefing" && m === "POST" && !id) {
      if (int(b.generation, 1, 2_147_483_647, "generation") !== generation) fail(409, "동의 세대가 바뀜 — 할 일을 다시 읽어 주세요");
      const point = (value, name) => {
        const p = obj(value, name);
        return { lat: num(p.lat, -90, 90, `${name}.lat`), lng: num(p.lng, -180, 180, `${name}.lng`) };
      };
      const place = { ...point(b.place, "place"), name: text(b.place.name, 100, "place.name") };
      const input = { place, position: point(b.position, "position"), parked: bool(b.parked, "parked"),
        observedAt: int(b.observedAt, 0, Date.now() + 5_000, "observedAt"), source: oneOf(b.source, ["vehicle", "browser"], "source") };
      input.parked = input.parked && ["parked", "ended"].includes(trip.status);
      const result = { generation, ...arrivalBriefing(input, items) };
      // 폰은 내비의 장소를 모른다. 도착으로 판정한 장소 이름·시각·출처만 남겨 GET /todos가 알려 준다(T119). 좌표는 남기지 않는다.
      if (result.eligible && trip.arrival?.place !== place.name) {
        trip.arrival = { place: place.name, at: input.observedAt, source: input.source };
        return changed(200, result);
      }
      return [200, result];
    }
    fail(405, "GET /todos, PATCH /todos/:id, POST /arrival-briefing만 됨");
  }

  // 기록본에서 읽는 것(기록본, 장면 후보, 숏폼)은 모두 녹음에 동의한 참가자만 — 받아 적은 글이 들어간다.
  const lines = async () => {
    if (m !== "GET") fail(405, "GET만 됨");
    return readLines();
  };

  if (sub === "transcript") {
    const all = await lines();
    return [200, { generation: trip.generation ?? 1, utterances: all, requests: trip.requests, todos: await todos(all), places: trip.places ?? [] }];
  }

  if (sub === "scene-suggestions") {
    // 장면 후보(T43): 규칙으로 고르고(scenes.js), 사람이 골라 POST /moments로 남긴다. 요청할 때만 계산하고 저장하지 않는다.
    // 장면으로 남길 수 있는 시각(여행을 만든 뒤 ~ 지금+1분)의 발화만 본다 — 고른 후보가 POST /moments에서 거절되지 않게.
    const now = Date.now();
    return [200, { items: suggest((await lines()).filter((u) => u.at >= trip.createdAt && u.at <= now + 60_000), trip.moments) }];
  }

  if (sub === "shortform") {
    // 숏폼 구성(T43, ADR-0021·ADR-0022): 클립이 올라온 장면마다 소리 주소와 자막 큐와 말한 사람을 준다.
    // 웹 9:16 화면과 주차 중 차가 이 데이터로 재생하고 기기에서 영상 파일로도 만듭니다. 공용 보관은 short-assets(T107)입니다.
    // 서버 생성(T157, 꺼서 배포)은 short-generations.js와 맥의 생성 일꾼(ADR-0025). 말한 사람은 화자 대조(T38)로 붙은 프로필만 — 자리만으로 이름을 붙이지 않는다.
    const all = await lines();
    return [200, await composition(trip, client, all)];
  }

  fail(404, "없는 경로");
}


async function composition(trip, client, all) {
  if (!all) {
    const { rows } = await client.query("SELECT * FROM utterances WHERE trip_code=$1 AND generation=$2 AND text<>'' ORDER BY at", [trip.code, trip.generation ?? 1]);
    all = rows.map(asUtterance);
  }
    const { rows: clips } = await client.query("SELECT moment_id, start_at, seconds FROM recordings WHERE trip_code = $1 AND generation = $2 AND deleted_at IS NULL ORDER BY start_at", [trip.code, trip.generation ?? 1]);
    const ids = trip.participants.map((p) => p.profileId).filter(Boolean);
    const { rows: chars } = ids.length ? await profilesDb().query("SELECT id, character FROM profiles WHERE id = ANY($1::uuid[])", [ids]) : { rows: [] };
    const character = new Map(chars.map((r) => [r.id, r.character]));
    const byProfile = new Map(trip.participants.filter((p) => p.profileId).map((p) => [p.profileId, p.id]));
    return {
      title: trip.title,
      generation: trip.generation ?? 1,
      cast: trip.participants.map((p) => ({ participantId: p.id, name: p.name, character: character.get(p.profileId) ?? "", seat: p.seat })),
      // 이 조회 중에 새 장면·클립이 들어오면 클립 줄이 여행 문서보다 새로울 수 있다 — 문서에 없는 장면의 클립은 다음 조회에서 보인다.
      scenes: clips.flatMap((r) => {
        const moment = trip.moments.find((x) => x.id === r.moment_id);
        if (!moment) return [];
        return [{
          momentId: r.moment_id,
          label: moment.label ?? "",
          at: moment.at,
          clip: `/api/trips/${trip.code}/recordings/${r.moment_id}`, // 같은 주소, 참가자 토큰 머리말로 받는다(ADR-0021)
          startAt: Number(r.start_at),
          seconds: r.seconds,
          cues: cues(all, Number(r.start_at), r.seconds).map(({ profileId, ...c }) => ({ ...c, participantId: c.participantId ?? byProfile.get(profileId) ?? null })),
          ...(moment.lat !== undefined ? { lat: moment.lat, lng: moment.lng } : {}),
        }];
      }),
    };
}

export const shortServiceContext = { withTrip, participantOf, composition };
const shortService = shortGenerations(shortServiceContext);
const shortAssetService = shortAssets(shortServiceContext);
// 콘텐츠 기록(places.js)에 둘 영상: 지금 원본과 같은 것만(T162). 원본은 여행마다 한 번 읽는다.
// ponytail: 영상마다 해시를 다시 센다. 여행 하나에 영상이 수백 개가 되면 원본 해시를 장면마다 캐시한다.
async function freshMedia(trip, rows) {
  if (!rows.length) return new Set();
  const current = await composition(trip, tripsDb());
  const ok = new Set();
  for (const r of rows) if (await (r.kind === "device" ? shortAssetService : shortService).fresh(trip, r.id, current)) ok.add(r.id);
  return ok;
}
const tripAudioService = tripAudio({ withTrip, participantOf, sweepClips, queueRetranscribe });

// 확장자 없는 주소는 화면이다: 그 폴더의 index.html(/demo), 없으면 웹앱 첫 화면 — Google 로그인 콜백처럼 웹앱이 주소를 읽는다.
// 웹 파일은 쓸 때마다 다시 확인하게 한다(no-cache + ETag). 지시가 없으면 Cloudflare가 4시간 캐시해
// 배포 뒤에도 옛 app.js가 쓰인다. 바뀌지 않았으면 304라 다시 받지 않는다.
// ponytail: 파일 이름에 해시를 붙이는 빌드는 두지 않는다(빌드 없는 웹앱). 파일이 커지면 그때.
async function serveFile(path, req, res) {
  const page = !extname(path);
  const file = normalize(join(WEB, page ? join(path, "index.html") : path));
  if (!file.startsWith(WEB)) fail(404, "없는 파일");
  const data = await readFile(file).catch(() => (page ? readFile(join(WEB, "index.html")) : fail(404, "없는 파일")));
  const headers = { "cache-control": "no-cache", etag: `"${createHash("sha256").update(data).digest("base64url").slice(0, 22)}"` };
  // If-None-Match는 약한 비교(RFC 9110 13.1.2): Cloudflare가 압축하면서 W/를 붙이고, 목록이나 *로도 온다.
  const inm = req.headers["if-none-match"];
  if (inm === "*" || inm?.split(",").some((t) => t.trim().replace(/^W\//, "") === headers.etag)) return void (res.writeHead(304, headers), res.end());
  res.writeHead(200, { "content-type": MIME[page ? ".html" : extname(file).toLowerCase()] ?? "application/octet-stream", ...headers });
  res.end(data);
}

export const server = createServer(async (req, res) => {
  // 요청마다 로그 한 줄(T71): 경로 틀, 상태, 걸린 시간, 요청 id, 오류 종류. 웹 파일과 건강 확인은 실패만 남긴다.
  const started = performance.now();
  const requestId = requestIdOf(req);
  res.setHeader("x-request-id", requestId);
  let failure = null;
  let route = "/(bad-url)"; // 주소를 읽지 못한 요청. 아래 try에서 한 번만 읽는다(로그에서 다시 읽다 던지면 프로세스가 죽는다)
  // 'close'는 응답을 다 보냈을 때도, 클라이언트가 먼저 끊었을 때도 한 번 온다. 끊긴 것은 499(nginx의 관례)와 aborted로.
  const cancelled = new AbortController();
  res.on("close", () => {
    const aborted = !res.writableFinished;
    if (aborted) cancelled.abort();
    const status = aborted ? 499 : res.statusCode;
    if (!route.startsWith("/api/") && status < 400) return;
    log(status >= 500 && !aborted ? "error" : "info", "request", {
      requestId,
      method: req.method,
      route,
      status,
      ms: Math.round(performance.now() - started),
      ...(aborted && { aborted }),
      ...(failure && { err: failure }),
    });
  });
  const send = (status, data, cache = "no-store") => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": cache });
    res.end(data === undefined ? undefined : JSON.stringify(data));
  };
  const sendRaw = (status, buf, type) => {
    // 매직 바이트만 본 파일이라 브라우저가 다른 형식으로 추측해 열지 못하게 한다.
    res.writeHead(status, { "content-type": type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    res.end(buf);
  };
  try {
    const url = new URL(req.url, "http://localhost");
    route = routeOf(url.pathname);
    const seg = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/healthz") {
      if (req.method !== "GET") fail(405, "GET만 됨");
      await Promise.all([tripsDb().query("SELECT 1"), profilesDb().query("SELECT 1")]); // 두 저장소 모두 닿는지 본다
      return send(200, { ok: true });
    }
    if (seg[0] === "api") {
      if (seg[1] === "j") fail(410, RETIRED_GROUP);
      if (seg[1] === "config" && !seg[2]) {
        if (req.method !== "GET") fail(405, "GET만 됨");
        return send(200, googlePublicConfig());
      }
      if (seg[1] === "short-templates" && !seg[2]) {
        if (req.method !== "GET") fail(405, "GET만 됨");
        return send(200, shortTemplateCatalog());
      }
      // 발화 묶음은 본문이 커서 그 경로만 따로 한도를 둔다(docs/api/voice.md).
      const big = seg[1] === "trips" && seg[3] === "utterances";
      // 목소리 등록(…/voice)·발화 대조는 이진 본문(WAV)이다 — JSON으로 먼저 읽지 않는다.
      const binary = req.method === "POST" && (seg.at(-1) === "voice" || (seg[1] === "trips" && (["voice-match", "recordings", "transcriptions"].includes(seg[3]) || (seg[3] === "short-assets" && !seg[4]))));
      const json = req.method === "POST" || req.method === "PATCH" || (req.method === "PUT" && seg[1] === "groups"); // 그룹 자리 바꾸기는 PUT(JSON)
      const body = !binary && json ? await readBody(req, big ? 1_000_000 : MAX_BODY) : {};
      // 생성 일꾼(운영자 맥, ADR-0025)이 작업을 받아 가고 결과 MP4를 PUT으로 올린다. 일꾼 토큰만 받는다.
      if (seg[1] === "short-worker") {
        const r = await shortService.worker(req, seg.slice(2), body);
        if (Buffer.isBuffer(r[1])) return void sendRaw(r[0], r[1], r[2]);
        return send(...r);
      }
      if (seg[1] === "rest-stops" && !seg[2]) {
        if (req.method !== "POST") fail(405, "POST만 됨");
        return send(200, restStopsOf(body));
      }
      if (seg[1] === "ride-links") return send(...(await rideLinks(req, seg.slice(2), { profileOf })));
      if (seg[1] === "boarding-invites") return send(...(await boardingInvites(req, seg.slice(2), body, { profileOf, withTrip, seats: SEATS })));
      if (seg[1] === "trips" && seg[2] && seg[3] === "ride-links" && !seg[4])
        return send(...(await redeemRideLink(req, seg[2], body, { profileById, seats: SEATS })));
      if (seg[1] === "groups")
        return send(...(await groups(req, seg.slice(2), body, { profileOf, text, bool, oneOf, obj, seats: SEATS, enrollment, enrolled, deleteProfiles })));
      if (seg[1] === "group-invites") return send(...(await groupInvites(req, seg.slice(2), { profileOf })));
      if ((seg[1] === "accounts" || seg[1] === "sessions") && !seg[2]) return send(...(await accounts(req, seg[1], body, { profileOf, profileById, issueToken, text, tokenHash })));
      if (seg[1] === "profiles") {
        const r = await profiles(req, seg.slice(2), body);
        if (Buffer.isBuffer(r[1])) return void sendRaw(r[0], r[1], r[2]); // 사진 같은 이진 응답
        return send(...r);
      }
      if (seg[1] === "trips") {
        const r = await trips(req, seg.slice(2), body, url.searchParams, cancelled.signal);
        if (Buffer.isBuffer(r[1])) return void sendRaw(r[0], r[1], r[2]); // 클립 소리 같은 이진 응답
        return send(...r);
      }
      fail(404, "없는 경로");
    }
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      fail(400, "잘못된 주소");
    }
    if (path === "/j" || path.startsWith("/j/")) {
      return sendRaw(410, Buffer.from(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>동승 연결 안내 · 가치타</title><h1>동승 연결 방법이 바뀌었어요</h1><p>${RETIRED_GROUP}</p><a href="/">가치타 열기</a></html>`), "text/html; charset=utf-8");
    }
    if (req.method !== "GET") fail(405, "GET만 됨");
    await serveFile(path, req, res);
  } catch (e) {
    const { status, type, message } = classify(e);
    failure = { type, ...(status >= 500 && errFields(e, status === 500)) }; // 서버 쪽 오류만 원인을, 예상 못 한 것(500)만 스택까지
    send(status, { error: message, type });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  await migrate();
  // 잡지 못한 오류는 남기고 끝낸다(쿠버네티스가 다시 띄운다)
  const crash = (what) => (e) => (log("error", what, { err: errFields(e, true) }), process.exit(1));
  process.on("uncaughtException", crash("uncaught_exception"));
  process.on("unhandledRejection", crash("unhandled_rejection"));
  server.listen(port, () => log("info", "listening", { port }));
  shortService.start();
  shortAssetService.start();
  setInterval(sweep, 10 * 60_000).unref(); // 여행을 아무도 만들지 않아도 묵은 여행과 클립을 치운다
}
