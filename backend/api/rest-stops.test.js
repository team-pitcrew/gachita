import assert from "node:assert/strict";
import { test } from "node:test";
import { restStops, roadOf, STOPS } from "./rest-stops.js";

const GANGNEUNG = { lat: 37.7645236, lng: 128.8996276 }; // 강릉역
const SEOUL = { lat: 37.5547, lng: 126.9707 }; // 서울역
const names = (o) => restStops(o).map((s) => s.name);

test("서울→강릉: 영동선 위 어디서든 다음 강릉방향 휴게소부터 차례로(T97)", () => {
  assert.equal(roadOf({ lat: 37.2459, lng: 127.26 }), "영동선");
  assert.deepEqual(names({ from: { lat: 37.2459, lng: 127.26 }, to: GANGNEUNG }), ["덕평휴게소", "여주휴게소 강릉방향", "문막휴게소 강릉방향"]);
  assert.deepEqual(names({ from: { lat: 37.33, lng: 127.83 }, to: GANGNEUNG }), ["문막휴게소 강릉방향", "횡성휴게소 강릉방향", "평창휴게소 강릉방향"]);
  assert.equal(names({ from: { lat: 37.48, lng: 128.18 }, to: GANGNEUNG })[0], "평창휴게소 강릉방향");
});

test("반대로 가면 건너편(인천방향)을, 지나친 곳은 내지 않는다(T97)", () => {
  const back = names({ from: { lat: 37.465, lng: 128.13 }, to: SEOUL });
  assert.deepEqual(back, ["문막휴게소 인천방향", "여주휴게소 인천방향", "덕평휴게소"]);
  assert.ok(!back.some((n) => n.startsWith("횡성") || n.includes("강릉방향")));
});

test("나란한 다른 고속도로보다 지금 달리는 노선을 먼저(T97)", () => {
  // 용인을 지나 덕평 앞: 중부선 이천휴게소가 더 가까울 수 있어도 영동선 덕평이 먼저
  assert.equal(names({ from: { lat: 37.2459, lng: 127.26 }, to: GANGNEUNG })[0], "덕평휴게소");
  // 경부선 서울→부산: 부산방향
  const busan = restStops({ from: { lat: 37.45, lng: 127.05 }, to: { lat: 35.1151, lng: 129.0414 } });
  assert.ok(busan.every((s) => s.route === "경부선" && !s.name.includes("서울방향")));
});

test("목적지가 없으면 진행 방향, 둘 다 없으면 빈 목록. 남은 거리는 경로 밖을 거른다(T97)", () => {
  assert.equal(names({ from: { lat: 37.2459, lng: 127.26 }, heading: 80 })[0], "덕평휴게소");
  assert.deepEqual(restStops({ from: { lat: 37.2459, lng: 127.26 } }), []);
  // 직선 약 156 km. 남은 길이 170 km면 영동선 곁만, 400 km면 멀리 도는 노선까지 들어온다
  const tight = restStops({ from: { lat: 37.2459, lng: 127.26 }, to: GANGNEUNG, remain: 170_000, limit: 50 });
  const loose = restStops({ from: { lat: 37.2459, lng: 127.26 }, to: GANGNEUNG, remain: 400_000, limit: 50 });
  assert.ok(tight.length > 0 && tight.length < loose.length);
  assert.ok(tight.every((s) => loose.some((x) => x.name === s.name)), "방향은 후보 묶음과 상관없이 휴게소마다 정한다");
  assert.equal(tight[0].name, loose[0].name);
  assert.ok(tight[0].meters > 0 && Number.isInteger(tight[0].meters));
});

// Astra 리뷰(#303)에서 나온 세 경우
test("짝이 없는 휴게소도 방향을 본다: 서울 쪽으로 가면 서울만남휴게소 부산방향은 내지 않는다(T97)", () => {
  const r = names({ from: { lat: 37.4, lng: 127.1 }, to: { lat: 37.55, lng: 127.04 }, remain: 22_000 });
  assert.ok(!r.some((n) => n.includes("부산방향")), r.join(", "));
});

test("한 노선에 행선지 표기가 여럿이어도 같은 쪽이면 낸다: 순천완주선 남쪽으로 관촌(광양)이 먼저(T97)", () => {
  assert.deepEqual(names({ from: { lat: 35.73, lng: 127.25 }, to: { lat: 34.95, lng: 127.49 }, remain: 110_000 }).slice(0, 2), ["관촌휴게소 광양방향", "오수휴게소 순천방향"]);
});

test("휴게소 자료 검사: 좌표가 노선에서 크게 벗어난 줄(홍천(양양) 부산 좌표)은 없고, 행선지는 모두 좌표가 있다(T97)", () => {
  const d = (a, b) => Math.hypot((a.lat - b.lat) * 110_574, (a.lng - b.lng) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180));
  for (const s of STOPS) {
    assert.ok(s.lat > 33 && s.lat < 39 && s.lng > 124 && s.lng < 132, s.name);
    if (s.dir) assert.ok(s.toward, `${s.name}: 행선지 ${s.dir} 좌표 없음`);
    const same = STOPS.filter((x) => x !== s && x.route === s.route);
    if (same.length) assert.ok(Math.min(...same.map((x) => d(s, x))) < 60_000, `${s.name}: 같은 노선 휴게소에서 60 km 넘게 떨어짐`);
    for (const x of same.filter((x) => x.base === s.base)) assert.ok(d(s, x) < 10_000, `${s.name}: 짝과 10 km 넘게 떨어짐`);
  }
  assert.ok(!STOPS.some((s) => s.name === "홍천휴게소 양양방향"));
  assert.ok(!restStops({ from: { lat: 35.3, lng: 129.02 }, to: { lat: 35.18, lng: 129.07 }, remain: 20_000 }).some((s) => s.name.startsWith("홍천")));
});
