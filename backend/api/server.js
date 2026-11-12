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

const WEB = fileURLToPath(new URL("../../frontend/web/", import.meta.url));
const TRIPS_SQL = fileURLToPath(new URL("trips.sql", import.meta.url));
const PROFILES_SQL = fileURLToPath(new URL("profiles.sql", import.meta.url));
const TTL_MS = 48 * 60 * 60 * 1000; // 기획서 v4가 초기 제안으로 적은 보관 기간
const MAX_BODY = 10_000;
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
  await tripsDb().query(await readFile(TRIPS_SQL, "utf8"));
  await profilesDb().query(await readFile(PROFILES_SQL, "utf8"));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) fail(413, "본문이 너무 큼");
  }
  let v;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    fail(400, "JSON이 아님");
  }
  return obj(v, "본문");
}

// Authorization: Bearer <토큰>. 머리말이 없으면 null(손님), 틀린 토큰이면 401.
async function profileOf(req) {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header);
  const { rows } = m ? await profilesDb().query("SELECT id, name, prefs, consent_default FROM profiles WHERE token_hash = $1", [tokenHash(m[1])]) : { rows: [] };
  if (!rows[0]) fail(401, "알 수 없는 프로필 토큰");
  return { id: rows[0].id, name: rows[0].name, prefs: rows[0].prefs, consentDefault: rows[0].consent_default };
}

async function profiles(req, [who], b) {
  const m = req.method;
  if (!who) {
    if (m !== "POST") fail(405, "POST만 됨");
    const token = randomBytes(32).toString("base64url");
    const p = {
      id: randomUUID(),
      name: text(b.name, 20, "name"),
      prefs: rolePrefs(obj(b.prefs ?? {}, "prefs")),
      consentDefault: b.consentDefault === undefined ? false : bool(b.consentDefault, "consentDefault"),
    };
    await profilesDb().query("INSERT INTO profiles (id, token_hash, name, prefs, consent_default) VALUES ($1, $2, $3, $4, $5)", [p.id, tokenHash(token), p.name, p.prefs, p.consentDefault]);
    return [201, { ...p, token }]; // 토큰은 이때 한 번만 준다. 서버에는 해시만 남는다.
  }
  if (who !== "me") fail(404, "없는 경로");
  if (m !== "GET" && m !== "PATCH" && m !== "DELETE") fail(405, "GET, PATCH, DELETE만 됨");
  const me = (await profileOf(req)) ?? fail(401, "프로필 토큰이 필요함");
  if (m === "GET") return [200, me];
  if (m === "DELETE") {
    await profilesDb().query("DELETE FROM profiles WHERE id = $1", [me.id]);
    return [204];
  }
  const next = {
    id: me.id,
    name: b.name === undefined ? me.name : text(b.name, 20, "name"),
    prefs: b.prefs === undefined ? me.prefs : rolePrefs(obj(b.prefs, "prefs"), me.prefs),
    consentDefault: b.consentDefault === undefined ? me.consentDefault : bool(b.consentDefault, "consentDefault"),
  };
  await profilesDb().query("UPDATE profiles SET name = $2, prefs = $3, consent_default = $4, updated_at = now() WHERE id = $1", [me.id, next.name, next.prefs, next.consentDefault]);
  return [200, next];
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
      participants: [],
      requests: [],
      moments: [],
      version: 1,
      createdAt: Date.now(),
    };
    await tripsDb().query("DELETE FROM trips WHERE created_at < now() - interval '48 hours'");
    for (;;) {
      trip.code = newCode();
      const { rowCount } = await tripsDb().query("INSERT INTO trips (code, doc) VALUES ($1, $2) ON CONFLICT DO NOTHING", [trip.code, trip]);
      if (rowCount) return [201, trip];
    }
  }
  const profile = sub === "participants" && m === "POST" && !id ? await profileOf(req) : null;
  return withTrip(code, m !== "GET", (trip) => handle(trip, { m, sub, id, b, query, profile }));
}

async function handle(trip, { m, sub, id, b, query, profile }) {
  const changed = (status, data) => {
    trip.version++;
    return [status, data];
  };

  if (!sub) {
    if (m === "GET") return query.get("v") === String(trip.version) ? [304] : [200, trip];
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
    return changed(200, trip);
  }

  if (sub === "participants") {
    const seatFree = (seat, self) => trip.participants.every((p) => p === self || p.seat !== seat);
    if (m === "POST" && !id) {
      // 같은 프로필이 다시 참가하면 이미 있는 참가자를 돌려준다(폰에서 다시 열었을 때).
      const again = profile && trip.participants.find((p) => p.profileId === profile.id);
      if (again) return [200, again];
      const seat = oneOf(b.seat, SEATS, "seat");
      const p = profile
        ? { name: profile.name, prefs: profile.prefs[ROLE[seat]], consent: b.consent === undefined ? profile.consentDefault : bool(b.consent, "consent"), profileId: profile.id }
        : { name: text(b.name, 20, "name"), prefs: prefs(obj(b.prefs ?? {}, "prefs")), consent: bool(b.consent, "consent") };
      if (!seatFree(seat)) fail(409, "이미 다른 사람이 앉은 자리");
      Object.assign(p, { id: randomUUID().slice(0, 8), seat });
      trip.participants.push(p);
      if (!p.consent) trip.recording = false; // 새 탑승자의 동의를 확인할 때까지 멈춘다
      return changed(201, p);
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
        p.consent = bool(b.consent, "consent");
        if (!p.consent) trip.recording = false;
      }
      return changed(200, p);
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
    if (trip.moments.length >= 500) fail(409, "장면이 너무 많음");
    const now = Date.now();
    const moment = {
      id: randomUUID().slice(0, 8),
      at: b.at === undefined ? now : num(b.at, trip.createdAt, now + 60_000, "at"), // 통신이 끊겼다가 나중에 올리는 경우
      lat: num(b.lat, -90, 90, "lat"),
      lng: num(b.lng, -180, 180, "lng"),
      label: b.label === undefined ? "" : text(b.label, 60, "label"),
    };
    trip.moments.push(moment);
    return changed(201, moment);
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
      const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : {};
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
