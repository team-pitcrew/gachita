// 경로 위 휴게소 추천(T97). 순정 내비(NaviHelper)는 경로 좌표도 장소 검색도 주지 않고, 지금 위치·진행 방향과
// 목적지·남은 거리만 준다(SDK 3.0.5). 그 셋과 한국도로공사 휴게소 위치정보(rest-stops.json, 203곳)로 앞으로 들를 수 있는 곳을 고른다.
// 키·비용·바깥 호출이 없다. DB도 네트워크도 모른다.
//
// 규칙(모두 직선 거리):
// 1. 길 위의 점은 '여기→그곳→목적지'가 남은 길보다 길 수 없다. 그래서 그 합이 남은 거리(+2 km, 휴게소는 길 옆)를 넘으면 뺀다.
//    남은 거리를 모르면 직선의 1.25배로 본다.
// 2. 목적지까지가 지금보다 가까워야 앞쪽이다(지나친 곳은 뺀다).
// 3. 방향: 이름의 괄호(예 '용인(강릉)휴게소')가 가는 쪽이다. 우리나라는 오른쪽으로 다니므로, 짝이 있는 휴게소(같은 노선·같은 이름)는
//    목적지 쪽으로 볼 때 오른쪽에 있는 것이 내 쪽이다. 노선마다 짝들의 표를 모아 내 쪽 괄호를 정하고 반대쪽은 뺀다.
// 4. 지금 달리는 고속도로(여기서 3 km 안을 지나는 노선의 선)의 휴게소를 먼저, 그다음 '여기까지 거리 + 3 × 직선에서 벗어난
//    정도'가 작은 순. 노선의 선은 같은 노선 휴게소(짝은 한 점)를 가장 먼 두 곳을 잇는 축 위 순서로 이은 꺾은선이다.
// ponytail: 직선 근사라 길이 크게 도는 곳(나란한 고속도로)에서는 다른 노선을 고를 수 있다. 경로 좌표를 주는 길찾기
//           API(키 필요)를 붙이면 1·4를 경로까지의 거리로 바꾼다. 휴게소 목록은 손으로 다시 받는다(rest-stops.json의 fetched).
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("rest-stops.json", import.meta.url), "utf8"));
export const SOURCE = `${data.source}, ${data.fetched} 받음`;

// '용인(강릉)휴게소' → 이름 '용인휴게소 강릉방향', 짝 열쇠 '용인휴게소', 방향 '강릉'. 괄호가 없으면 양방향(방향 없음).
const parse = ([raw, route, lat, lng]) => {
  const m = raw.match(/^(.*?)\((.+?)\)(.*)$/);
  const base = m ? m[1] + m[3] : raw;
  const dir = m?.[2] ?? null;
  return { name: dir ? `${base} ${dir}${dir.length === 1 ? "행" : "방향"}` : base, base, dir, route, lat, lng };
};
const STOPS = data.stops.map(parse);

const KM_LAT = 110_574;
// 평면 근사(m). 수백 km에서 1% 안쪽이라 앞뒤·옆을 가리기에 충분하다.
const xy = (p, lat0) => ({ x: p.lng * 111_320 * Math.cos((lat0 * Math.PI) / 180), y: p.lat * KM_LAT });
const dist = (a, b) => {
  const lat0 = (a.lat + b.lat) / 2;
  const [p, q] = [xy(a, lat0), xy(b, lat0)];
  return Math.hypot(q.x - p.x, q.y - p.y);
};

// 점 p에서 선분 ab까지(m).
const toSegment = (p, a, b) => {
  const [q, u, v] = [p, a, b].map((x) => xy(x, p.lat));
  const [dx, dy] = [v.x - u.x, v.y - u.y];
  const t = Math.max(0, Math.min(1, ((q.x - u.x) * dx + (q.y - u.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(q.x - u.x - t * dx, q.y - u.y - t * dy);
};

// 노선 → 꺾은선의 점들. ponytail: 고리 모양 노선(수도권제1순환선)은 축 순서가 맞지 않아 선이 거칠다.
const LINES = new Map();
for (const route of new Set(STOPS.map((s) => s.route))) {
  const bases = new Map();
  for (const s of STOPS.filter((x) => x.route === route)) bases.set(s.base, [...(bases.get(s.base) ?? []), s]);
  const pts = [...bases.values()].map((g) => ({ lat: g.reduce((n, s) => n + s.lat, 0) / g.length, lng: g.reduce((n, s) => n + s.lng, 0) / g.length }));
  let [a, b] = [pts[0], pts[0]];
  for (const p of pts) for (const q of pts) if (dist(p, q) > dist(a, b)) [a, b] = [p, q];
  const [u, v] = [xy(a, a.lat), xy(b, a.lat)];
  const along = (p) => { const w = xy(p, a.lat); return (w.x - u.x) * (v.x - u.x) + (w.y - u.y) * (v.y - u.y); };
  LINES.set(route, pts.sort((p, q) => along(p) - along(q)));
}

// 여기서 3 km 안을 지나는 가장 가까운 노선. 없으면 null(고속도로 밖이거나 휴게소가 하나뿐인 노선).
export function roadOf(p) {
  let best = { route: null, m: 3_000 };
  for (const [route, pts] of LINES)
    for (let i = 1; i < pts.length; i++) {
      const m = toSegment(p, pts[i - 1], pts[i]);
      if (m < best.m) best = { route, m };
    }
  return best.route;
}

// 목적지가 없으면 진행 방향으로 30 km 앞을 목적지로 본다.
const ahead = (from, heading, m = 30_000) => {
  const r = (heading * Math.PI) / 180;
  return { lat: from.lat + (m * Math.cos(r)) / KM_LAT, lng: from.lng + (m * Math.sin(r)) / (111_320 * Math.cos((from.lat * Math.PI) / 180)) };
};

// 노선마다 내 쪽 방향 괄호. 짝마다 '목적지 쪽으로 볼 때 A가 B의 오른쪽인가'를 사인값(엇갈려 선 짝은 작음)으로 더한다.
function myDirections(stops, to) {
  const score = new Map(); // "노선\t방향" → 점수
  const add = (k, v) => score.set(k, (score.get(k) ?? 0) + v);
  for (const a of stops) {
    for (const b of stops) {
      if (a === b || a.route !== b.route || a.base !== b.base || !a.dir || !b.dir || a.dir === b.dir) continue;
      const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
      const [m, pa, pb, t] = [mid, a, b, to].map((p) => xy(p, mid.lat));
      const d = { x: t.x - m.x, y: t.y - m.y };
      const v = { x: pa.x - pb.x, y: pa.y - pb.y };
      const sin = (d.x * v.y - d.y * v.x) / (Math.hypot(d.x, d.y) * Math.hypot(v.x, v.y) || 1);
      add(`${a.route}\t${a.dir}`, -sin); // 오른쪽이면 사인이 음수
    }
  }
  const mine = new Map();
  for (const [k, v] of score) {
    const [route, dir] = k.split("\t");
    if (v > 0 && v > (mine.get(route)?.v ?? 0)) mine.set(route, { dir, v });
  }
  return mine;
}

/**
 * 앞으로 들를 수 있는 휴게소, 좋은 순으로 limit곳.
 * from {lat, lng}, heading(도, 북=0, 없으면 null), to {lat, lng}(목적지, 없으면 null), remain(목적지까지 남은 길 m, 모르면 null).
 * 돌려주는 것: {name, route, lat, lng, meters(여기서 직선 m)}.
 */
export function restStops({ from, heading = null, to = null, remain = null, limit = 3 }) {
  const end = to ?? (heading == null ? null : ahead(from, heading));
  if (!end) return [];
  const straight = dist(from, end);
  const left = remain && remain > straight ? remain : straight * 1.25;
  const onWay = STOPS.filter((s) => dist(from, s) + dist(s, end) <= left + 2_000);
  const mine = myDirections(onWay, end);
  const road = roadOf(from);
  return onWay
    .filter((s) => dist(s, end) < straight && (!s.dir || !mine.has(s.route) || mine.get(s.route).dir === s.dir))
    .map((s) => {
      const meters = dist(from, s);
      return { s, meters, score: (s.route === road ? 0 : 1e9) + meters + 3 * (meters + dist(s, end) - straight) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ s, meters }) => ({ name: s.name, route: s.route, lat: s.lat, lng: s.lng, meters: Math.round(meters) }));
}
