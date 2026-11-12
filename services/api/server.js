// 같이타 여행 세션 서버. 의존성 없이 Node 22 표준 라이브러리만 쓴다.
// 한 프로세스가 API(/api)와 웹앱(apps/web)을 같이 내보낸다.
//
// ponytail: 메모리에만 저장한다. 서버를 다시 켜면 여행이 사라지고, 인스턴스는 1개여야 한다.
//           여행을 오래 보관하거나 인스턴스를 늘려야 하면 node:sqlite나 Postgres로 옮긴다.
// ponytail: 로그인이 없다. 여행 코드를 아는 사람이 그 여행을 읽고 고친다.
//           계정이 생기면 참가자 토큰을 붙인다.
import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const TTL_MS = 48 * 60 * 60 * 1000; // 기획서 v4가 초기 제안으로 적은 보관 기간
const MAX_TRIPS = 1000;
const MAX_BODY = 10_000;
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const trips = new Map();

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
const prefs = (p) => ({
  tempC: num(p.tempC ?? 22, 16, 30, "prefs.tempC"),
  heat: int(p.heat ?? 0, 0, 3, "prefs.heat"),
  vent: int(p.vent ?? 0, 0, 3, "prefs.vent"),
});

const everyoneConsents = (trip) => trip.participants.length > 0 && trip.participants.every((p) => p.consent);

function newCode() {
  for (;;) {
    const code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
    if (!trips.has(code)) return code;
  }
}

function find(code) {
  const trip = trips.get(String(code).toUpperCase());
  if (!trip) fail(404, "없는 여행 코드");
  if (Date.now() - trip.createdAt > TTL_MS) {
    trips.delete(trip.code);
    fail(404, "보관 기간이 지난 여행");
  }
  return trip;
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

async function api(req, seg, query) {
  const m = req.method;
  const [code, sub, id] = seg;

  if (!code) {
    if (m !== "POST") fail(405, "POST만 됨");
    if (trips.size >= MAX_TRIPS) {
      for (const t of trips.values()) if (Date.now() - t.createdAt > TTL_MS) trips.delete(t.code);
      if (trips.size >= MAX_TRIPS) fail(503, "여행이 너무 많음");
    }
    const b = await readBody(req);
    const trip = {
      code: newCode(),
      title: b.title === undefined ? "" : text(b.title, 40, "title"),
      status: "boarding",
      recording: false,
      participants: [],
      requests: [],
      moments: [],
      version: 1,
      createdAt: Date.now(),
    };
    trips.set(trip.code, trip);
    return [201, trip];
  }

  const trip = find(code);
  const changed = (status, data) => {
    trip.version++;
    return [status, data];
  };

  if (!sub) {
    if (m === "GET") return query.get("v") === String(trip.version) ? [304] : [200, trip];
    if (m !== "PATCH") fail(405, "GET, PATCH만 됨");
    const b = await readBody(req);
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
    const b = await readBody(req);
    const seatFree = (seat, self) => trip.participants.every((p) => p === self || p.seat !== seat);
    if (m === "POST" && !id) {
      const p = {
        id: randomUUID().slice(0, 8),
        name: text(b.name, 20, "name"),
        seat: oneOf(b.seat, SEATS, "seat"),
        prefs: prefs(obj(b.prefs ?? {}, "prefs")),
        consent: bool(b.consent, "consent"),
      };
      if (!seatFree(p.seat)) fail(409, "이미 다른 사람이 앉은 자리");
      trip.participants.push(p);
      if (!p.consent) trip.recording = false; // 새 탑승자의 동의를 확인할 때까지 멈춘다
      return changed(201, p);
    }
    if (m === "PATCH" && id) {
      const p = trip.participants.find((x) => x.id === id) ?? fail(404, "없는 참가자");
      if (b.seat !== undefined) {
        if (!seatFree(oneOf(b.seat, SEATS, "seat"), p)) fail(409, "이미 다른 사람이 앉은 자리");
        p.seat = b.seat;
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
    const b = await readBody(req);
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
    const b = await readBody(req);
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
    if (seg[0] === "api" && seg[1] === "trips") return send(...(await api(req, seg.slice(2), url.searchParams)));
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
  server.listen(port, () => console.log(`같이타 서버: http://localhost:${port}`));
}
