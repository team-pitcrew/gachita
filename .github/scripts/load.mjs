#!/usr/bin/env node
// 떠 있는 같이타 서버에 동시 접속 N의 부하를 걸고 SLI를 잰다(ADR-0016의 부하 가정, T62). 의존성 없음(Node 22 기본 fetch).
//
//   node .github/scripts/load.mjs <서버 주소> [동시 접속=100] [초=60]
//
// 가정(ADR-0016 '부하' 표): 차량 30% · 폰 70%. 차 한 대가 여행 하나를 만들고 폰은 여행에 나눠 붙는다.
//   조회   모두가 2초마다 GET /api/trips/:code?v=<본 판>(바뀐 것이 없으면 304)
//   쓰기   차마다 1분에 한 번 부탁을 남김(POST /api/trips/:code/requests). 판이 올라 폰들의 다음 조회가 200이 된다
//   발화 올리기(5초 묶음)는 develop에 아직 API가 없어 걸지 않는다(T39). 그래서 초당 요청이 표의 약 57이 아니라 약 50.5다
// SLI(ADR-0016 1절): 가용성 = 5xx·시간 초과·연결 실패가 아닌 요청 ÷ 4xx를 뺀 요청, 조회 200 ms 안, 쓰기 1초 안.
// 시험 데이터: 여행의 제목은 'E2E 부하'다. ops 워크플로의 clean-e2e가 지우고, 지우지 않아도 API가 48시간 뒤 지운다.
// 가용성이 99.5% 아래면 1로 끝난다.
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const users = Number(process.argv[3] ?? 100);
const seconds = Number(process.argv[4] ?? 60);
if (!/^https?:\/\/./.test(base) || !(users >= 1) || !(seconds >= 1)) {
  console.error("사용법: node .github/scripts/load.mjs <서버 주소> [동시 접속=100] [초=60]");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const samples = { 조회: [], 쓰기: [] }; // [ms, 상태(0 = 연결 실패·시간 초과)]

async function call(kind, method, path, body) {
  const t = performance.now();
  let status = 0;
  let json;
  try {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    json = res.status === 200 || res.status === 201 ? await res.json() : await res.arrayBuffer();
  } catch {
    // status 0으로 센다
  }
  if (kind) samples[kind].push([performance.now() - t, status]);
  return { status, json };
}

// 준비(재지 않음): 차마다 여행 하나와 운전자 참가자
const cars = Math.max(1, Math.round(users * 0.3));
const trips = [];
for (let i = 0; i < cars; i++) {
  const trip = await call(null, "POST", "/api/trips", { title: "E2E 부하" });
  if (trip.status !== 201) throw new Error(`여행 만들기 실패: ${trip.status}`);
  const me = await call(null, "POST", `/api/trips/${trip.json.code}/participants`, { name: `차${i}`, seat: "ROW_1_LEFT", consent: true });
  if (me.status !== 201) throw new Error(`참가 실패: ${me.status}`);
  trips.push({ code: trip.json.code, driver: me.json.id });
}
console.log(`준비: 여행 ${cars}개, 동시 접속 ${users}(차 ${cars} · 폰 ${users - cars}), ${seconds}초`);

const end = Date.now() + seconds * 1000;
async function rider(trip, isCar) {
  let v = 0;
  let nextWrite = Date.now() + Math.random() * 60_000;
  await sleep(Math.random() * 2000); // 한꺼번에 몰리지 않게
  while (Date.now() < end) {
    const tick = Date.now();
    const r = await call("조회", "GET", `/api/trips/${trip.code}?v=${v}`);
    if (r.status === 200) v = r.json.version;
    if (isCar && Date.now() >= nextWrite) {
      await call("쓰기", "POST", `/api/trips/${trip.code}/requests`, { by: trip.driver, text: "부하 시험", when: "now" });
      nextWrite += 60_000;
    }
    await sleep(Math.max(0, 2000 - (Date.now() - tick)));
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: users }, (_, i) => rider(trips[i % cars], i < cars)));
const took = (Date.now() - started) / 1000;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
const ms = (x) => (Number.isNaN(x) ? "-" : `${x.toFixed(0)} ms`);
let good = 0;
let valid = 0;
console.log("| 종류 | 요청 | 초당 | p50 / p95 / p99 | 상태 | 시간 안(조회 200 ms, 쓰기 1초) |\n|---|---|---|---|---|---|");
for (const [kind, s] of Object.entries(samples)) {
  const lat = s.map(([t]) => t).sort((a, b) => a - b);
  const codes = {};
  for (const [, c] of s) codes[c] = (codes[c] ?? 0) + 1;
  const ok = s.filter(([, c]) => c > 0 && c < 500);
  const counted = s.filter(([, c]) => !(c >= 400 && c < 500));
  good += ok.filter(([, c]) => c < 400).length;
  valid += counted.length;
  const inTime = s.filter(([t, c]) => c > 0 && c < 400 && t <= (kind === "조회" ? 200 : 1000)).length;
  console.log(
    `| ${kind} | ${s.length} | ${(s.length / took).toFixed(1)} | ${[50, 95, 99].map((p) => ms(pct(lat, p))).join(" / ")} | ${JSON.stringify(codes)} | ${((100 * inTime) / (s.length || 1)).toFixed(2)}% |`,
  );
}
const availability = (100 * good) / (valid || 1);
console.log(`가용성 SLI: ${availability.toFixed(3)}% (${good}/${valid}, 목표 99.5%)`);
process.exit(availability >= 99.5 ? 0 : 1);
