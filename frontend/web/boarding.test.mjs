import test from "node:test";
import assert from "node:assert/strict";
import { createBoarding, remainingTime } from "./boarding.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; }
  append(...children) { for (const child of children) { child?.remove?.(); if (child instanceof Element) child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children.forEach((child) => { if (child instanceof Element) child.parent = null; }); this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
}
const elements = (el) => [el, ...el.children.filter((child) => child instanceof Element).flatMap(elements)];
const content = (el) => el instanceof Element ? el.children.map(content).join(" ") : String(el);
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const body = new Element("body"), storage = new Map(), timers = [], calls = [], joined = [], decisions = [], left = [];
  const descriptors = new Map(["document", "sessionStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.document = { body, hidden: false, createElement: (tag) => new Element(tag), createElementNS: (ns, tag) => Object.assign(new Element(tag), { namespaceURI: ns }) };
  globalThis.sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  t.mock.method(globalThis, "setInterval", (fn) => { timers.push(fn); return timers.length; });
  t.mock.method(globalThis, "setTimeout", () => 0);
  t.mock.method(globalThis, "clearTimeout", () => {});
  t.mock.method(globalThis, "clearInterval", () => {});
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const profile = { id: "profile", name: "동승자", character: "basic" };
  const participant = { id: "person", profileId: profile.id, consent: false, seat: "ROW_2_LEFT" };
  const trip = { code: "TRIP12", title: "바다 여행", generation: 1, participants: [participant] };
  const ride = { id: "link", qr: JSON.stringify({ type: "gachita-ride", version: 1, code: "one-use-code" }), expiresAt: now + 300_000, participantToken: "phone-only-token" };
  const data = { linked: false, scannedDuringDelete: false, respond: null };
  t.mock.method(globalThis, "fetch", async (path, options) => {
    calls.push({ path, ...options });
    if (data.respond) return data.respond(path, options);
    if (options.method === "POST") return Response.json(ride, { status: 201 });
    if (options.method === "DELETE") return data.scannedDuringDelete ? Response.json({ error: "이미 차에 연결됨" }, { status: 409 }) : new Response(null, { status: 204 });
    if (options.method === "PATCH") { participant.consent = JSON.parse(options.body).consent; return Response.json(participant); }
    if (path.includes("/ride-links/")) return Response.json(data.linked ? { status: "linked", tripCode: trip.code, participant } : { status: "pending", expiresAt: ride.expiresAt });
    return Response.json(trip);
  });
  const boarding = createBoarding({ getProfile: () => profile, getToken: () => "profile-token", consentText: ["서버와 같은 동의 안내"], consentOffMessage: "동의를 끌까요?", onLinked: (value) => joined.push(value), onDecision: (value) => decisions.push(value), onLeave: (value) => left.push(value) });
  t.after(() => { boarding.close(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { boarding, body, profile, participant, trip, ride, data, calls, storage, joined, decisions, left,
    now: (value) => { now = value; }, tick: async () => { timers.at(-1)?.(); await new Promise(setImmediate); },
    button: (label) => elements(body).find((el) => el.tag === "button" && content(el) === label),
    qr: () => elements(body).find((el) => el.attrs["data-payload"]),
  };
}

test("QR은 5분을 초로 표시하고 만료 시 스캔할 SVG를 화면에서 없앤다", async (t) => {
  const f = fixture(t);
  await f.boarding.open();
  assert.equal(remainingTime(f.ride.expiresAt), "05:00");
  assert.equal(f.qr().attrs["data-payload"], f.ride.qr);
  assert.ok(!f.qr().attrs["data-payload"].includes(f.ride.participantToken));
  f.now(f.ride.expiresAt); await f.tick();
  assert.equal(f.qr(), undefined);
  assert.ok(content(f.body).includes("QR이 만료됐어요"));
});

test("스캔은 동의를 켜지 않고 본인 동의 버튼만 폰의 참가자 토큰으로 보낸다", async (t) => {
  const f = fixture(t); await f.boarding.open();
  f.data.linked = true; await f.tick();
  assert.equal(f.qr(), undefined);
  assert.ok(content(f.body).includes("뒤 왼쪽"));
  assert.equal(f.calls.filter((call) => call.method === "PATCH").length, 0);
  assert.equal(f.joined[0].token, "phone-only-token");
  assert.equal(f.storage.has("gachita:ride"), false);
  await f.button("동의하고 함께 타기").onclick();
  const patch = f.calls.find((call) => call.method === "PATCH");
  assert.equal(patch.path, "/api/trips/TRIP12/participants/person");
  assert.equal(patch.headers.authorization, "Bearer phone-only-token");
  assert.deepEqual(JSON.parse(patch.body), { consent: true });
  assert.ok(content(f.body).includes("내 기록 동의 켜짐"));
  assert.ok(content(f.body).includes("실제 녹음은 모두 동의한 뒤 차에서 시작해요"));
  f.button("여행으로 돌아가기").onclick();
  assert.equal(f.left[0].code, "TRIP12");
  assert.equal(f.body.children.length, 0);
});

test("기록 없이 함께 타기는 동의를 끈 상태로 합석을 마친다", async (t) => {
  const f = fixture(t); await f.boarding.open(); f.data.linked = true; await f.tick();
  await f.button("기록 없이 함께 타기").onclick();
  assert.deepEqual(JSON.parse(f.calls.find((call) => call.method === "PATCH").body), { consent: false });
  assert.ok(content(f.body).includes("내 기록 동의 꺼짐"));
  assert.equal(f.decisions.length, 1);
});

test("새 QR 요청 중 차가 먼저 읽으면 새 토큰을 발급하지 않고 기존 합석으로 이어진다", async (t) => {
  const f = fixture(t); await f.boarding.open();
  f.data.scannedDuringDelete = true; f.data.linked = true;
  await f.button("QR 새로 만들기").onclick();
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(f.joined[0].token, "phone-only-token");
  assert.ok(content(f.body).includes("이 자리에 앉았나요?"));
});

for (const change of ["close", "profile"]) {
  test(`QR 발급 중 ${change} 변경 뒤에는 늦은 토큰과 화면을 되살리지 않는다`, async (t) => {
    const f = fixture(t), pending = defer(); f.data.respond = () => pending.promise;
    const wait = f.boarding.open();
    if (change === "close") f.boarding.close();
    else { f.profile.id = "another-profile"; f.boarding.sync(); }
    pending.resolve(Response.json(f.ride)); await wait;
    assert.equal(f.body.children.length, 0);
    assert.equal(f.storage.has("gachita:ride"), false);
  });
}

test("저장한 QR은 서버 확인 전 표시하지 않고 네트워크 오류 뒤 같은 연결을 다시 확인한다", async (t) => {
  const f = fixture(t);
  f.storage.set("gachita:ride", JSON.stringify({ id: f.ride.id, qr: f.ride.qr, expiresAt: f.ride.expiresAt, token: f.ride.participantToken, profileId: f.profile.id }));
  f.data.respond = () => { throw new Error("offline"); };
  await f.boarding.open();
  assert.equal(f.qr(), undefined);
  assert.ok(content(f.body).includes("연결 상태를 확인하지 못했어요"));
  f.data.respond = null; await f.button("다시 확인").onclick();
  assert.ok(f.qr());
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
});
