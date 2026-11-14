import assert from "node:assert/strict";
import { test } from "node:test";
import { restStops, roadOf } from "./rest-stops.js";

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
  assert.ok(!tight.some((s) => s.route === "서울양양선") && loose.some((s) => s.route === "서울양양선"));
  assert.equal(tight[0].name, loose[0].name);
  assert.ok(tight[0].meters > 0 && Number.isInteger(tight[0].meters));
});
