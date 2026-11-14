// 경로 위 휴게소 추천(T97). 순정 내비(NaviHelper)는 경로 좌표도 장소 검색도 주지 않고, 지금 위치·진행 방향과
// 목적지·남은 거리만 준다(SDK 3.0.5). 그 셋과 한국도로공사 휴게소 위치정보(rest-stops.json, 200곳)로 앞으로 들를 수 있는 곳을 고른다.
// 키·비용·바깥 호출이 없다. DB도 네트워크도 모른다.
//
// 규칙(모두 직선 거리):
// 1. 길 위의 점은 '여기→그곳→목적지'가 남은 길보다 길 수 없다. 그래서 그 합이 남은 거리(+2 km, 휴게소는 길 옆)를 넘으면 뺀다.
//    남은 거리를 모르면 직선의 1.25배로 본다.
// 2. 목적지까지가 지금보다 가까워야 앞쪽이다(지나친 곳은 뺀다).
// 3. 방향: 휴게소마다 가는 쪽 행선지(이름의 괄호, 예 '용인(강릉)휴게소'의 강릉)가 있다. 노선의 선(4)에서 행선지 도시에 가까운 끝이
//    그 휴게소 차로가 가는 쪽이고, 그 휴게소 자리에서 그 끝 쪽으로 가는 도로 구간과 목적지 쪽이 같은 편(사잇각 90도 미만)이어야
//    내 쪽이다. 도로가 행선지와 다른 쪽으로 굽는 곳(경부선 건천: 부산방향 차로가 경주 쪽 동쪽으로 감)도 맞게 본다.
//    짝이 있든 없든, 한 노선에 행선지 표기가 여럿이든(순천완주선의 광양·순천) 휴게소마다 본다. 행선지가 없는 곳(덕평·행담도처럼
//    양방향)은 거르지 않는다. 선이 없는 노선(휴게소 한 곳)과 고리 노선(순환선)은 행선지 도시로 곧게 본다.
// 4. 지금 달리는 고속도로(여기서 3 km 안을 지나는 노선의 선)의 휴게소를 먼저, 그다음 '여기까지 거리 + 3 × 직선에서 벗어난
//    정도'가 작은 순. 노선의 선은 같은 노선 휴게소(짝은 한 점)를 가장 먼 두 곳을 잇는 축 위 순서로 이은 꺾은선이다.
// ponytail: 직선 근사라 길이 크게 도는 곳(나란한 고속도로)에서는 다른 노선을 고를 수 있다. 경로 좌표를 주는 길찾기
//           API(키 필요)를 붙이면 1·4를 경로까지의 거리로 바꾼다. 휴게소 목록은 손으로 다시 받는다(rest-stops.json의 fetched).
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("rest-stops.json", import.meta.url), "utf8"));
export const SOURCE = `${data.source}, ${data.fetched} 받음`;

// 행선지 도시의 어림 좌표(시청 근처, 방향만 보므로 수 km 틀려도 된다). 남이·청원은 분기점 근처.
const TOWARD = {
  강릉: [37.75, 128.88], 공주: [36.45, 127.12], 광양: [34.94, 127.7], 광주: [35.16, 126.85], 남이: [36.56, 127.42], 논산: [36.19, 127.1],
  당진: [36.89, 126.63], 대구: [35.87, 128.6], 대전: [36.35, 127.38], 동해: [37.52, 129.11], 목포: [34.81, 126.39], 무안: [34.99, 126.48],
  부산: [35.18, 129.08], 삼척: [37.45, 129.17], 상주: [36.41, 128.16], 서부산: [35.15, 128.98], 서울: [37.57, 126.98], 서천: [36.08, 126.69],
  속초: [38.21, 128.59], 순천: [34.95, 127.49], 양양: [38.08, 128.62], 양평: [37.49, 127.49], 영덕: [36.42, 129.37], 영암: [34.8, 126.7],
  완주: [35.9, 127.16], 인천: [37.46, 126.71], 일산: [37.66, 126.77], 전주: [35.82, 127.15], 제천: [37.13, 128.19], 창원: [35.23, 128.68],
  천안: [36.82, 127.11], 청원: [36.6, 127.48], 청주: [36.64, 127.49], 춘천: [37.88, 127.73], 통영: [34.85, 128.43], 평택: [36.99, 127.11],
  포항: [36.02, 129.34], 하남: [37.54, 127.21],
};

// ['용인(강릉)휴게소', 노선, 위도, 경도, '강릉'] → 이름 '용인휴게소 강릉방향', 짝 열쇠 '용인휴게소', 행선지 좌표. 행선지가 없으면 양방향.
const parse = ([raw, route, lat, lng, dir]) => {
  const base = raw.replace(/\(.+?\)/, "");
  const [tlat, tlng] = dir ? TOWARD[dir] : [];
  return { name: dir ? `${base} ${dir}방향` : base, base, dir, toward: dir ? { lat: tlat, lng: tlng } : null, route, lat, lng };
};
export const STOPS = data.stops.map(parse);

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

// 휴게소 자리에서 행선지 쪽으로 가는 도로 구간(평면 벡터). 노선의 선에서 휴게소에 가장 가까운 꼭짓점과, 행선지 도시에 가까운 끝
// 쪽 이웃 꼭짓점을 잇는다(그 끝에 있으면 앞 꼭짓점에서 온다). 선이 없거나 고리 노선이면 행선지 도시로 곧게.
// ponytail: 꼭짓점이 휴게소(짝은 한 점)라 구간이 수십 km다. 그 사이에서 길이 크게 꺾이면 어림이 틀릴 수 있다.
for (const s of STOPS) {
  if (!s.toward) continue;
  const pts = LINES.get(s.route);
  const p = xy(s, s.lat);
  if (pts.length < 2 || s.route.includes("순환")) {
    const c = xy(s.toward, s.lat);
    s.way = { x: c.x - p.x, y: c.y - p.y };
    continue;
  }
  const i = pts.reduce((b, q, k) => (dist(q, s) < dist(pts[b], s) ? k : b), 0);
  const step = dist(pts.at(-1), s.toward) < dist(pts[0], s.toward) ? 1 : -1; // 행선지 쪽 끝으로 가는 방향
  const [a, b] = pts[i + step] ? [pts[i], pts[i + step]] : [pts[i - step], pts[i]];
  const [u, v] = [xy(a, s.lat), xy(b, s.lat)];
  s.way = { x: v.x - u.x, y: v.y - u.y };
}

// 그 휴게소 차로가 내가 가는 쪽(v: 그 휴게소에서 목적지 쪽, 목적지가 없으면 진행 방향)으로 가는가. 행선지가 없으면(양방향) 그렇다.
const myWay = (s, v) => !s.way || s.way.x * v.x + s.way.y * v.y > 0;

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
  const road = roadOf(from);
  const r = ((heading ?? 0) * Math.PI) / 180;
  const goes = (s) => {
    if (!to) return { x: Math.sin(r), y: Math.cos(r) }; // 목적지가 없으면 30 km 앞 점보다 진행 방향이 차로 방향에 가깝다
    const [p, t] = [xy(s, s.lat), xy(end, s.lat)];
    return { x: t.x - p.x, y: t.y - p.y };
  };
  return onWay
    .filter((s) => dist(s, end) < straight && myWay(s, goes(s)))
    .map((s) => {
      const meters = dist(from, s);
      return { s, meters, score: (s.route === road ? 0 : 1e9) + meters + 3 * (meters + dist(s, end) - straight) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ s, meters }) => ({ name: s.name, route: s.route, lat: s.lat, lng: s.lng, meters: Math.round(meters) }));
}
