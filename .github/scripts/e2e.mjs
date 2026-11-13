#!/usr/bin/env node
// 떠 있는 같이타 서버에 대고 여행 하나의 흐름을 실제 HTTP로 확인한다. 의존성 없음(Node 22 기본 fetch).
//
//   node .github/scripts/e2e.mjs http://localhost:8787
//
// 서버 단위 테스트(backend/api/server.test.js)와 달리 만든 이미지에 대고 돈다(로컬 make e2e, CI package 잡).
// 경로와 상태 코드는 docs/api/openapi.yaml을 따른다. 실패하면 어느 단계에서 무엇을 기대했고 무엇이 왔는지
// 한 줄로 알리고 1로 끝난다. E2E_WAIT_SECONDS(기본 60)는 서버가 뜰 때까지 기다리는 시간이다.
// ponytail: 재시도는 서버가 뜰 때까지의 기다림에만 둔다. 흐름 중의 요청을 다시 보내면
//           같은 부탁이 두 번 생기는 식으로 진짜 결함을 가린다.
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\/./.test(base)) {
  console.error("사용법: node .github/scripts/e2e.mjs <서버 주소>   예: http://localhost:8787");
  process.exit(2);
}
const WAIT_SECONDS = Number(process.env.E2E_WAIT_SECONDS ?? 60);

class Failure extends Error {}
let stage = "시작";
const fail = (what, want, got) => {
  throw new Failure(`E2E 실패 · ${stage} · ${what}: 기대 ${want}, 받음 ${got}`);
};
const show = (v) => (v === undefined ? "없음" : JSON.stringify(v));
const same = (what, got, want) => isDeepStrictEqual(got, want) || fail(what, show(want), show(got));
const matches = (what, got, pattern) => (typeof got === "string" && pattern.test(got)) || fail(what, pattern, show(got));

// 요청 하나. 응답의 상태·형식·본문을 돌려준다. 10초 안에 답이 없으면 실패다.
async function call(method, path, { body, raw, token } = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    fail(`${method} ${path}`, "응답", `연결 오류(${e.cause?.code ?? e.name})`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { what: `${method} ${path}`, status: res.status, type: (res.headers.get("content-type") ?? "").split(";")[0], text, json };
}

// 상태 코드가 맞는지 보고 JSON 본문을 돌려준다.
function status(r, want) {
  if (r.status !== want) fail(r.what, want, `${r.status} ${r.text.slice(0, 160)}`.trim());
  return r.json;
}

const steps = [];
const step = (name, fn) => steps.push([name, fn]);

step("서버가 뜰 때까지 기다림", async () => {
  const until = Date.now() + WAIT_SECONDS * 1000;
  let last = "응답 없음";
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) return;
      last = `${res.status} ${(await res.text()).slice(0, 160)}`;
    } catch (e) {
      last = `연결 오류(${e.cause?.code ?? e.name})`;
    }
    if (Date.now() > until) fail("GET /healthz", `${WAIT_SECONDS}초 안에 200`, last);
    await sleep(1000);
  }
});

let me, trip, t, rider, driver, ask;

step("프로필 발급과 조회", async () => {
  me = status(await call("POST", "/api/profiles", { body: { name: "지우", prefs: { passenger: { tempC: 23, heat: 1 } }, consentDefault: true } }), 201);
  matches("발급한 토큰", me.token, /^[A-Za-z0-9_-]{43}$/);
  same("안 적은 자리의 선호(기본값)", me.prefs.driver, { tempC: 22, heat: 0, vent: 0 });
  const seen = status(await call("GET", "/api/profiles/me", { token: me.token }), 200);
  same("조회한 이름과 토큰", [seen.id, seen.name, seen.token], [me.id, "지우", undefined]);
  status(await call("GET", "/api/profiles/me"), 401);
  status(await call("GET", "/api/profiles/me", { token: "x".repeat(43) }), 401);
});

step("여행 만들기", async () => {
  trip = status(await call("POST", "/api/trips", { body: { title: "E2E 양양" } }), 201);
  matches("여행 코드", trip.code, /^[A-HJKMNP-Z2-9]{6}$/);
  same("처음 상태", [trip.status, trip.recording, trip.version, trip.participants], ["boarding", false, 1, []]);
  t = `/api/trips/${trip.code}`;
});

step("프로필로 참가", async () => {
  rider = status(await call("POST", `${t}/participants`, { body: { seat: "ROW_1_RIGHT" }, token: me.token }), 201);
  same("프로필에서 가져온 이름·조수석 선호·동의", [rider.name, rider.prefs, rider.consent], ["지우", { tempC: 23, heat: 1, vent: 0 }, true]);
  const again = status(await call("POST", `${t}/participants`, { body: { seat: "ROW_2_LEFT" }, token: me.token }), 200);
  same("다시 참가하면 있던 참가자", [again.id, again.seat], [rider.id, "ROW_1_RIGHT"]);
});

step("이름으로 참가", async () => {
  driver = status(await call("POST", `${t}/participants`, { body: { name: "민준", seat: "ROW_1_LEFT", consent: false, prefs: { tempC: 21 } } }), 201);
  same("이름·자리·선호·동의", [driver.name, driver.seat, driver.prefs, driver.consent], ["민준", "ROW_1_LEFT", { tempC: 21, heat: 0, vent: 0 }, false]);
  status(await call("POST", `${t}/participants`, { body: { name: "하늘", seat: "ROW_1_LEFT", consent: true } }), 409);
});

step("동의와 기록 상태", async () => {
  const driving = status(await call("PATCH", t, { body: { status: "driving" } }), 200);
  same("동의하지 않은 사람이 있을 때 주행 중 기록", driving.recording, false);
  status(await call("PATCH", t, { body: { recording: true } }), 409);
  status(await call("PATCH", `${t}/participants/${driver.id}`, { body: { consent: true } }), 200);
  same("모두 동의한 뒤 기록", status(await call("PATCH", t, { body: { recording: true } }), 200).recording, true);
  // 명세: 동의를 끄면 기록이 멈춘다
  status(await call("PATCH", `${t}/participants/${rider.id}`, { body: { consent: false } }), 200);
  same("한 명이 동의를 끈 뒤 기록", status(await call("GET", t), 200).recording, false);
  status(await call("PATCH", `${t}/participants/${rider.id}`, { body: { consent: true } }), 200);
  same("다시 동의하고 켠 기록", status(await call("PATCH", t, { body: { recording: true } }), 200).recording, true);
});

step("부탁을 남기고 상태를 끝까지 바꾸기", async () => {
  ask = status(await call("POST", `${t}/requests`, { body: { by: rider.id, text: "화장실 가고 싶어", when: "now" } }), 201);
  same("남긴 부탁", [ask.by, ask.status], [rider.id, "held"]);
  status(await call("PATCH", `${t}/requests/${ask.id}`, { body: { status: "reflected" } }), 409);
  for (const next of ["proposed", "accepted", "reflected", "done"]) {
    same(`${next}로 바꾼 상태`, status(await call("PATCH", `${t}/requests/${ask.id}`, { body: { status: next } }), 200).status, next);
  }
  status(await call("PATCH", `${t}/requests/${ask.id}`, { body: { status: "held" } }), 409);
  status(await call("POST", `${t}/requests`, { body: { by: "nobody", text: "x" } }), 400);
});

step("주차하면 기록 마감", async () => {
  const parked = status(await call("PATCH", t, { body: { status: "parked" } }), 200);
  same("주차 뒤 상태와 기록", [parked.status, parked.recording], ["parked", false]);
  status(await call("PATCH", t, { body: { recording: true } }), 409);
});

step("버전으로 다시 읽기", async () => {
  const now = status(await call("GET", t), 200);
  same("참가자·부탁 수", [now.participants.length, now.requests.length, now.requests[0]?.status], [2, 1, "done"]);
  status(await call("GET", `${t}?v=${now.version}`), 304);
  status(await call("GET", `${t}?v=${now.version - 1}`), 200);
  status(await call("GET", `/api/trips/${trip.code.toLowerCase()}`), 200);
});

step("잘못된 요청의 거절", async () => {
  status(await call("POST", "/api/trips", { raw: "{" }), 400);
  status(await call("POST", "/api/trips", { raw: "x".repeat(20_000) }), 413);
  status(await call("GET", "/api/trips/000000"), 404); // 코드에 0은 쓰지 않는다
  status(await call("POST", `${t}/participants`, { body: { name: "하늘", seat: "TRUNK", consent: true } }), 400);
  status(await call("PATCH", `${t}/requests/nothing`, { body: { status: "done" } }), 404);
  status(await call("GET", "/..%2F..%2Fbackend%2Fapi%2Fserver.js"), 404);
});

step("웹앱 첫 화면과 정적 파일", async () => {
  const page = await call("GET", "/");
  status(page, 200);
  same("첫 화면 형식", page.type, "text/html");
  same("첫 화면에 '같이타'", page.text.includes("같이타"), true);
  for (const [file, type] of [["/app.js", "text/javascript"], ["/style.css", "text/css"]]) {
    const r = await call("GET", file);
    status(r, 200);
    same(`${file} 형식`, r.type, type);
  }
});

step("프로필 지우기", async () => {
  status(await call("DELETE", "/api/profiles/me", { token: me.token }), 204);
  status(await call("GET", "/api/profiles/me", { token: me.token }), 401);
});

const started = Date.now();
for (const [name, fn] of steps) {
  stage = name;
  try {
    await fn();
  } catch (e) {
    console.error(e instanceof Failure ? e.message : `E2E 실패 · ${stage} · 예상하지 못한 오류: ${e.stack ?? e}`);
    process.exit(1);
  }
  console.log(`ok  ${name}`);
}
console.log(`E2E 통과: ${steps.length}단계, ${((Date.now() - started) / 1000).toFixed(1)}초, ${base}`);
