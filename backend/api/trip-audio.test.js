// 여행 전체 음성(ADR-0024). 실행: 저장소 루트에서 make check
// 가짜 클립 버킷은 SDK의 표준 설정(AWS_ENDPOINT_URL_S3)으로 꽂는다 — IP 주소라 SDK가 경로 방식(/clips/<키>)으로 부른다.
// server.test.js의 가짜보다 멀티파트와 바이트 범위(Range)를 더 안다.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, server, sweep } from "./server.js";
import { endStores, tripsDb } from "./db.js";
import { captureLog } from "./log.js";
import { AUDIO_KEEP_MS, AUDIO_MAX_BYTES, PART_MAX } from "./trip-audio.js";

let base, adminUrl, names, fakeS3;
// objects: 키 → 바이트. uploads: 멀티파트 id → {key, parts}. log: 받은 요청 {method, key, range, query}
// onPut: 올리기를 받은 뒤 답하기 전에 끼워 넣을 일(한 번)
const s3 = { objects: new Map(), uploads: new Map(), completed: 0, log: [], onPut: null };
captureLog(() => {});

before(async () => {
  fakeS3 = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://localhost");
    const key = decodeURIComponent(url.pathname).replace(/^\/clips\/?/, "");
    const q = url.searchParams;
    s3.log.push({ method: req.method, key, range: req.headers.range ?? null, query: [...q.keys()].join(",") });
    const xml = (status, text) => (res.writeHead(status, { "content-type": "application/xml" }), res.end(`<?xml version="1.0" encoding="UTF-8"?>${text}`));
    if (req.method === "POST" && q.has("delete")) {
      for (const [, k] of body.toString().matchAll(/<Key>(.*?)<\/Key>/g)) s3.objects.delete(k);
      return xml(200, "<DeleteResult></DeleteResult>");
    }
    if (req.method === "POST" && q.has("uploads")) {
      const id = `up-${s3.uploads.size + 1}-${Date.now()}`;
      s3.uploads.set(id, { key, parts: new Map() });
      return xml(200, `<InitiateMultipartUploadResult><Bucket>clips</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === "PUT") {
      const hook = s3.onPut;
      s3.onPut = null;
      await hook?.(key);
    }
    if (req.method === "PUT" && q.has("uploadId")) {
      s3.uploads.get(q.get("uploadId")).parts.set(Number(q.get("partNumber")), body);
      res.writeHead(200, { etag: `"p${q.get("partNumber")}"` });
      return res.end();
    }
    if (req.method === "POST" && q.has("uploadId")) {
      const up = s3.uploads.get(q.get("uploadId"));
      const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
      // 마지막을 빼고 5 MiB 이상이어야 한다(S3의 규칙)
      if (numbers.slice(0, -1).some((n) => up.parts.get(n).length < 5 * 1024 * 1024)) return xml(400, "<Error><Code>EntityTooSmall</Code></Error>");
      s3.objects.set(up.key, Buffer.concat(numbers.map((n) => up.parts.get(n))));
      s3.uploads.delete(q.get("uploadId"));
      s3.completed++;
      return xml(200, `<CompleteMultipartUploadResult><Location>x</Location><Bucket>clips</Bucket><Key>${up.key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === "DELETE" && q.has("uploadId")) {
      s3.uploads.delete(q.get("uploadId"));
      return void (res.writeHead(204), res.end());
    }
    if (req.method === "PUT") {
      s3.objects.set(key, body);
      return void (res.writeHead(200, { etag: '"o"' }), res.end());
    }
    if (req.method === "GET") {
      const data = s3.objects.get(key);
      if (!data) return xml(404, "<Error><Code>NoSuchKey</Code></Error>");
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      if (!m) return void (res.writeHead(200, { "content-length": data.length }), res.end(data));
      const [from, to] = [Number(m[1]), Math.min(Number(m[2]), data.length - 1)];
      res.writeHead(206, { "content-length": to - from + 1, "content-range": `bytes ${from}-${to}/${data.length}` });
      return res.end(data.subarray(from, to + 1));
    }
    res.writeHead(400);
    res.end();
  });
  await new Promise((ok) => fakeS3.listen(0, "127.0.0.1", ok));
  Object.assign(process.env, { CLIPS_BUCKET: "clips", AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${fakeS3.address().port}`, AWS_REGION: "ap-northeast-2", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" });
  adminUrl = process.env.DATABASE_URL;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  names = [`${admin.database}_audio_trips`, `${admin.database}_audio_profiles`];
  for (const name of names) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  }
  await admin.end();
  process.env.TRIPS_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[0]}`);
  process.env.PROFILES_DATABASE_URL = adminUrl.replace(/\/[^/?]*(\?.*)?$/, `/${names[1]}`);
  await migrate();
  await migrate(); // 여러 번 돌려도 같아야 한다
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((ok) => server.close(ok));
  fakeS3.close();
  await endStores();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

async function call(method, path, body, token, raw) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (raw !== undefined) headers["content-type"] = "application/octet-stream";
  else if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}/api${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const type = res.headers.get("content-type") ?? "";
  const data = res.status === 204 ? null : type.startsWith("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}
const put = (t, n, bytes, token, generation = 1) => call("PUT", `${t}/audio/parts/${n}?generation=${generation}`, undefined, token, bytes);
// 표본 i의 값이 i로 정해지는 16 kHz 모노 s16le — 자른 구간이 어디서 왔는지 바이트로 맞춰 본다.
const pcmOf = (seconds) => {
  const n = Math.round(seconds * 16_000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(((i * 31) % 65_536) - 32_768, i * 2);
  return b;
};
const split = (buf, size) => Array.from({ length: Math.ceil(buf.length / size) }, (_, i) => buf.subarray(i * size, (i + 1) * size));
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const keysOf = (code, part) => [...s3.objects.keys()].filter((k) => k.startsWith(`${code}/${part}`));
const wav = (pcm) => {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(16_000, 24); head.writeUInt32LE(32_000, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
};

// 차(운전석, 발화를 올린 기기의 주인)와 폰(동승자). 둘 다 녹음에 동의했다.
async function setup() {
  const trip = (await call("POST", "/trips", { title: "전체 음성" })).data;
  const t = `/trips/${trip.code}`;
  const car = (await call("POST", `${t}/participants`, { name: "차", seat: "ROW_1_LEFT", consent: true })).data;
  const phone = (await call("POST", `${t}/participants`, { name: "폰", seat: "ROW_1_RIGHT", consent: true })).data;
  const sent = await call("POST", `${t}/utterances`, { device: "car-1", items: [{ seq: 1, at: trip.createdAt + 1000, text: "출발하자", seatArea: "ROW_1_LEFT", generation: 1 }] }, car.token);
  assert.equal(sent.status, 200);
  return { trip, t, car, phone };
}
// 올리기 시작부터 완료까지(조각은 순서대로)
async function upload(f, pcm, { startedAt = f.trip.createdAt - 30_000, generation = 1 } = {}) {
  const seconds = pcm.length / 32_000;
  assert.equal((await call("POST", `${f.t}/audio/start`, { generation, expectedBytes: pcm.length, seconds, startedAt }, f.car.token)).status, 200);
  const parts = split(pcm, PART_MAX);
  for (const [n, p] of parts.entries()) assert.equal((await put(f.t, n, p, f.car.token, generation)).status, 201);
  const done = await call("POST", `${f.t}/audio/complete`, { generation, parts: parts.length, seconds, sha256: sha(pcm) }, f.car.token);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return done.data;
}

test("뒤섞이고 다시 보낸 조각을 순서대로 이어 하나로 두고, 진행률을 보이고, 고른 장면을 전체 음성에서 잘라 준다", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  const pcm = pcmOf(300); // 9.6 MB → 조각 셋(4 MiB, 4 MiB, 나머지). 합칠 때 멀티파트(8 MiB 넘음)
  const parts = split(pcm, PART_MAX);
  assert.equal(parts.length, 3);
  const startedAt = trip.createdAt - 30_000;
  assert.deepEqual((await call("GET", `${t}/audio`, undefined, phone.token)).data, { state: "none", receivedParts: 0, receivedBytes: 0, progress: 0 });

  const started = await call("POST", `${t}/audio/start`, { generation: 1, expectedBytes: pcm.length, seconds: 300, startedAt }, car.token);
  assert.equal(started.status, 200);
  assert.deepEqual(started.data, { state: "uploading", generation: 1, receivedParts: 0, receivedBytes: 0, expectedBytes: pcm.length, seconds: 300, startedAt, progress: 0, partNumbers: [] });

  // 2, 0 순서로 보내고, 1은 틀린 값을 보냈다가 같은 n으로 다시 보낸다(덮음)
  assert.deepEqual((await put(t, 2, parts[2], car.token)).data, { n: 2, bytes: parts[2].length });
  assert.equal((await put(t, 0, parts[0], car.token)).status, 201);
  assert.equal((await put(t, 1, Buffer.alloc(1000), car.token)).status, 201);
  let s = (await call("GET", `${t}/audio`, undefined, phone.token)).data;
  assert.equal(s.state, "uploading");
  assert.equal(s.receivedParts, 3);
  assert.equal(s.receivedBytes, parts[0].length + parts[2].length + 1000);
  assert.equal(s.progress, Math.round(((parts[0].length + parts[2].length + 1000) / pcm.length) * 1000) / 1000, "폰(P22)은 서버의 진행률을 읽는다");
  assert.equal((await put(t, 1, parts[1], car.token)).status, 201);
  s = (await call("GET", `${t}/audio`, undefined, phone.token)).data;
  assert.equal(s.receivedBytes, pcm.length);
  assert.equal(s.progress, 1);
  assert.deepEqual(s.partNumbers, [0, 1, 2]);
  await sweep();
  assert.equal(keysOf(trip.code, "trip-audio/part-").length, 3, "덮인 조각은 버킷에서 지운다");

  // 같은 값으로 start를 다시 불러도(응답을 못 받은 차) 받은 조각은 그대로다
  assert.equal((await call("POST", `${t}/audio/start`, { generation: 1, expectedBytes: pcm.length, seconds: 300, startedAt }, car.token)).data.receivedParts, 3);

  const completedBefore = s3.completed;
  const done = await call("POST", `${t}/audio/complete`, { generation: 1, parts: 3, seconds: 300, sha256: sha(pcm).toUpperCase() }, car.token);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data, { state: "ready", seconds: 300, bytes: pcm.length, startedAt });
  assert.equal(s3.completed, completedBefore + 1, "8 MiB가 넘으면 멀티파트로 잇는다");
  await sweep();
  assert.deepEqual(keysOf(trip.code, "trip-audio/part-"), [], "다 이으면 조각은 지운다");
  const whole = keysOf(trip.code, "trip-audio/");
  assert.equal(whole.length, 1);
  assert.ok(s3.objects.get(whole[0]).equals(pcm), "조각을 순서대로 이은 것이 원음과 같다");
  assert.equal((await call("POST", `${t}/audio/complete`, { generation: 1, parts: 3, seconds: 300, sha256: sha(pcm) }, car.token)).status, 200, "완료를 다시 불러도 같은 답");
  const readyAt = (await tripsDb().query("SELECT ready_at FROM trip_audio WHERE trip_code = $1", [trip.code])).rows[0].ready_at.getTime();
  assert.deepEqual((await call("GET", `${t}/audio`, undefined, phone.token)).data,
    { state: "ready", generation: 1, receivedParts: 3, receivedBytes: pcm.length, expectedBytes: pcm.length, seconds: 300, startedAt, progress: 1, expiresAt: readyAt + AUDIO_KEEP_MS });
  assert.equal((await put(t, 0, parts[0], car.token)).status, 409, "다 올린 뒤 늦게 온 조각은 받지 않는다(새로 올리려면 start부터)");

  // 차가 클립을 따로 올리지 않은 장면: 전체 음성에서 그 구간만 범위로 읽어 WAV로 준다
  const moment = (await call("POST", `${t}/moments`, { at: trip.createdAt + 5000, from: trip.createdAt, to: trip.createdAt + 20_000 }, phone.token)).data;
  s3.log.length = 0;
  const clip = await call("GET", `${t}/recordings/${moment.id}`, undefined, phone.token);
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get("content-type"), "audio/wav");
  assert.equal(clip.headers.get("cache-control"), "private, no-store");
  assert.equal(clip.data.toString("latin1", 0, 4), "RIFF");
  assert.equal(clip.data.readUInt32LE(24), 16_000);
  assert.equal(clip.data.readUInt16LE(22), 1);
  assert.ok(clip.data.subarray(44).equals(pcm.subarray(30_000 * 32, 50_000 * 32)), "장면 구간(여행 시작 0~20초 = 전체 음성의 30~50초)");
  assert.deepEqual(s3.log.filter((x) => x.method === "GET" && x.key === whole[0]).map((x) => x.range), [`bytes=${30_000 * 32}-${50_000 * 32 - 1}`], "전체를 받지 않고 범위만 읽는다");
  const again = await call("GET", `${t}/recordings/${moment.id}`, undefined, phone.token);
  assert.ok(again.data.equals(clip.data), "두 번째부터는 남긴 클립을 그대로");
  const stored = (await tripsDb().query("SELECT start_at, seconds, cut_from_audio, participant_id FROM recordings WHERE trip_code = $1 AND moment_id = $2", [trip.code, moment.id])).rows[0];
  assert.deepEqual({ ...stored, start_at: Number(stored.start_at) }, { start_at: trip.createdAt, seconds: 20, cut_from_audio: true, participant_id: car.id });

  // 숏폼 구성을 읽으면 아직 자르지 않은 장면도 잘라 넣는다(기본 구간 at 앞 20초~뒤 10초)
  const second = (await call("POST", `${t}/moments`, { at: trip.createdAt + 40_000 }, phone.token)).data;
  const form = await call("GET", `${t}/shortform`, undefined, phone.token);
  assert.equal(form.status, 200);
  const scene = form.data.scenes.find((x) => x.momentId === second.id);
  assert.deepEqual([scene.startAt, scene.seconds, scene.clip], [trip.createdAt + 20_000, 30, `/api/trips/${trip.code}/recordings/${second.id}`]);
  assert.equal(form.data.scenes.length, 2);

  // 차가 장면 클립을 올리는 기존 경로도 그대로: 올린 클립이 있으면 자르지 않고 그것을 준다
  const third = (await call("POST", `${t}/moments`, { at: trip.createdAt + 50_000, from: trip.createdAt + 45_000, to: trip.createdAt + 55_000 }, phone.token)).data;
  const own = wav(Buffer.alloc(10 * 32_000, 7));
  const res = await fetch(`${base}/api${t}/recordings?moment=${third.id}&generation=1&from=${trip.createdAt + 45_000}`, { method: "POST", headers: { authorization: `Bearer ${car.token}`, "content-type": "audio/wav" }, body: own });
  assert.equal(res.status, 201);
  assert.ok((await call("GET", `${t}/recordings/${third.id}`, undefined, phone.token)).data.equals(own));
});

test("sha256이 틀리면 409로 받은 조각을 버리고, 빠진 조각·크기·한도를 확인한다", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  const pcm = pcmOf(4); // 128,000 B — 조각 둘, 합칠 때 한 번에 올림
  const halves = split(pcm, 64_000);
  const startedAt = trip.createdAt;
  const start = (b = {}) => call("POST", `${t}/audio/start`, { generation: 1, expectedBytes: pcm.length, seconds: 4, startedAt, ...b }, car.token);
  const complete = (b = {}) => call("POST", `${t}/audio/complete`, { generation: 1, parts: 2, seconds: 4, sha256: sha(pcm), ...b }, car.token);
  assert.equal((await start()).status, 200);

  // 조각 한도와 모양
  assert.equal((await put(t, 0, Buffer.alloc(PART_MAX + 2), car.token)).status, 413);
  for (const odd of [Buffer.alloc(0), Buffer.alloc(3)]) assert.equal((await put(t, 0, odd, car.token)).status, 400);
  for (const n of ["-1", "01", "10000", "x", "1.5"]) assert.equal((await put(t, n, halves[0], car.token)).status, 400, n);
  assert.equal((await put(t, 0, halves[0], car.token, 2)).status, 400, "아직 없는 세대");
  assert.equal((await put(t, 0, halves[0], car.token, 0)).status, 400);
  assert.equal((await call("GET", `${t}/audio/parts/0`, undefined, car.token)).status, 405);
  assert.equal((await call("POST", `${t}/audio/parts/0`, {}, car.token)).status, 405);
  assert.equal((await call("GET", `${t}/audio/start`, undefined, car.token)).status, 405);
  assert.equal((await call("POST", `${t}/audio/other`, {}, car.token)).status, 404);
  assert.equal((await call("POST", `${t}/audio/start/x`, {}, car.token)).status, 404);
  // start의 값
  assert.equal((await start({ expectedBytes: AUDIO_MAX_BYTES + 2, seconds: AUDIO_MAX_BYTES / 32_000 })).status, 413);
  for (const bad of [{ expectedBytes: 127_999 }, { expectedBytes: "128000" }, { seconds: 9 }, { seconds: 0 }, { startedAt: trip.createdAt - 120_000 }, { startedAt: Date.now() + 120_000 }, { generation: 2 }])
    assert.equal((await start(bad)).status, 400, JSON.stringify(bad));

  // 빠진 조각은 409(남은 조각은 그대로 둠)
  assert.equal((await put(t, 1, halves[1], car.token)).status, 201);
  const missing = await complete();
  assert.equal(missing.status, 409);
  assert.match(missing.data.error, /받지 못한 조각: 0/);
  assert.equal((await call("GET", `${t}/audio`, undefined, phone.token)).data.receivedParts, 1);
  for (const bad of [{ parts: 0 }, { sha256: "abc" }, { seconds: "4" }, { startedAt: 1 }]) assert.equal((await complete(bad)).status, 400, JSON.stringify(bad));

  // 틀린 조각이 섞이면 sha256이 맞지 않아 409 — 받은 조각을 모두 버린다. 같은 올리기에 다시 보내면 된다
  const wrong = Buffer.from(halves[0]);
  wrong[10] ^= 0xff;
  assert.equal((await put(t, 0, wrong, car.token)).status, 201);
  const mismatch = await complete();
  assert.equal(mismatch.status, 409);
  assert.match(mismatch.data.error, /sha256/);
  const after = (await call("GET", `${t}/audio`, undefined, phone.token)).data;
  assert.deepEqual([after.state, after.receivedParts, after.receivedBytes, after.expectedBytes], ["uploading", 0, 0, pcm.length]);
  await sweep();
  assert.deepEqual(keysOf(trip.code, "trip-audio/"), [], "틀린 조각과 이은 것을 버킷에 두지 않는다");
  for (const [n, p] of halves.entries()) assert.equal((await put(t, n, p, car.token)).status, 201);
  // 알린 크기와 받은 크기가 다르면 409
  assert.equal((await call("POST", `${t}/audio/start`, { generation: 1, expectedBytes: pcm.length, seconds: 4, startedAt }, car.token)).status, 200);
  assert.equal((await complete({ parts: 1, seconds: 2 })).status, 409);
  assert.equal((await complete({ seconds: 9 })).status, 400, "길이가 받은 크기와 맞지 않음");
  assert.equal((await complete()).status, 200);
  await sweep();
  assert.deepEqual(keysOf(trip.code, "trip-audio/").map((k) => s3.objects.get(k).equals(pcm)), [true]);

  // 다시 출발해 더 긴 음성을 새로 올리는 동안에는 앞의 전체 음성이 남아 있다가, 다 올리면 바뀐다
  const longer = pcmOf(6);
  assert.equal((await call("POST", `${t}/audio/start`, { generation: 1, expectedBytes: longer.length, seconds: 6, startedAt }, car.token)).status, 200);
  const mid = (await call("GET", `${t}/audio`, undefined, phone.token)).data;
  assert.deepEqual([mid.state, { ...mid.previous, expiresAt: undefined }], ["uploading", { bytes: pcm.length, seconds: 4, startedAt, expiresAt: undefined }]);
  assert.ok(mid.previous.expiresAt > Date.now() + AUDIO_KEEP_MS - 60_000, "앞의 전체 음성도 2일 뒤 만료");
  assert.equal((await put(t, 0, longer, car.token)).status, 201);
  assert.equal((await call("POST", `${t}/audio/complete`, { generation: 1, parts: 1, seconds: 6, sha256: sha(longer) }, car.token)).status, 200);
  await sweep();
  const keys = keysOf(trip.code, "trip-audio/");
  assert.equal(keys.length, 1, "앞의 전체 음성은 지운다");
  assert.ok(s3.objects.get(keys[0]).equals(longer));
});

test("start 전에 온 조각도 받고, 완료 때 첫 표본의 시각을 받는다", async () => {
  const f = await setup();
  const pcm = pcmOf(2);
  assert.equal((await put(f.t, 0, pcm, f.car.token)).status, 201);
  const s = (await call("GET", `${f.t}/audio`, undefined, f.phone.token)).data;
  assert.deepEqual([s.state, s.receivedParts, s.progress, s.expectedBytes], ["uploading", 1, 0, undefined]);
  assert.equal((await call("POST", `${f.t}/audio/complete`, { generation: 1, parts: 1, seconds: 2, sha256: sha(pcm) }, f.car.token)).status, 400, "첫 표본의 시각을 모르면 장면을 자를 수 없다");
  const done = await call("POST", `${f.t}/audio/complete`, { generation: 1, parts: 1, seconds: 2, sha256: sha(pcm), startedAt: f.trip.createdAt }, f.car.token);
  assert.deepEqual(done.data, { state: "ready", seconds: 2, bytes: pcm.length, startedAt: f.trip.createdAt });
});

test("녹음한 기기의 참가자 토큰만, 모두 동의했을 때만, 지금 세대만 받는다", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  const pcm = pcmOf(1);
  const body = { generation: 1, expectedBytes: pcm.length, seconds: 1, startedAt: trip.createdAt };
  const other = await setup();
  for (const token of [undefined, "A".repeat(43), other.car.token]) {
    assert.equal((await call("POST", `${t}/audio/start`, body, token)).status, 401);
    assert.equal((await put(t, 0, pcm, token)).status, 401);
    assert.equal((await call("POST", `${t}/audio/complete`, { generation: 1, parts: 1, seconds: 1, sha256: sha(pcm) }, token)).status, 401);
    assert.equal((await call("GET", `${t}/audio`, undefined, token)).status, 401);
    assert.equal((await call("DELETE", `${t}/audio`, undefined, token)).status, 401);
  }
  assert.equal((await call("GET", "/trips/NOPE99/audio", undefined, car.token)).status, 404);
  // 발화를 올리지 않은 폰 참가자는 '여행 음성'을 올리지 못한다
  assert.equal((await call("POST", `${t}/audio/start`, body, phone.token)).status, 403);
  assert.equal((await put(t, 0, pcm, phone.token)).status, 403);
  // 차가 올리는 중이면 다른 기기(자기 발화가 있는 참가자)도 끼어들지 못한다
  const tablet = (await call("POST", `${t}/participants`, { name: "태블릿", seat: "ROW_2_LEFT", consent: true })).data;
  assert.equal((await call("POST", `${t}/utterances`, { device: "tablet", items: [{ seq: 1, at: trip.createdAt + 2000, text: "안녕", seatArea: "ROW_2_LEFT", generation: 1 }] }, tablet.token)).status, 200);
  assert.equal((await call("POST", `${t}/audio/start`, body, car.token)).status, 200);
  assert.equal((await put(t, 0, pcm, tablet.token)).status, 409);
  // 동의하지 않은 탑승자가 타면 받지 않는다(나중에 다시)
  const late = (await call("POST", `${t}/participants`, { name: "늦게 탐", seat: "ROW_2_RIGHT", consent: false })).data;
  assert.equal((await put(t, 0, pcm, car.token)).status, 403);
  assert.equal((await call("POST", `${t}/audio/start`, body, car.token)).status, 403);
  assert.equal((await call("GET", `${t}/audio`, undefined, late.token)).status, 200, "진행률은 동의와 관계없이 참가자 누구나");
  assert.equal((await call("PATCH", `${t}/participants/${late.id}`, { consent: true }, late.token)).status, 200);
  assert.equal((await put(t, 0, pcm, car.token)).status, 201);
  // 동의 세대가 바뀌기 전의 소리는 409(차는 버린다)
  assert.equal((await call("PATCH", `${t}/participants/${late.id}`, { consent: false })).status, 200);
  assert.equal((await call("PATCH", `${t}/participants/${late.id}`, { consent: true }, late.token)).status, 200);
  assert.equal((await put(t, 0, pcm, car.token, 1)).status, 409);
  assert.equal((await call("POST", `${t}/audio/start`, body, car.token)).status, 409);
  assert.equal((await call("POST", `${t}/audio/complete`, { generation: 1, parts: 1, seconds: 1, sha256: sha(pcm) }, car.token)).status, 409);
});

test("받아 적은 말이 없는 여행은 내비 장소를 올린 기기나 운전석이 올린다(T162, C22가 0%에서 멈추지 않게)", async () => {
  const trip = (await call("POST", "/trips", { title: "말 없는 여행" })).data;
  const t = `/trips/${trip.code}`;
  const join = async (name, seat) => (await call("POST", `${t}/participants`, { name, seat, consent: true })).data;
  const [driver, phone, car] = [await join("운전", "ROW_1_LEFT"), await join("폰", "ROW_1_RIGHT"), await join("차", "ROW_2_LEFT")];
  const pcm = pcmOf(1);
  const body = { generation: 1, expectedBytes: pcm.length, seconds: 1, startedAt: trip.createdAt };
  assert.equal((await call("POST", `${t}/audio/start`, body, phone.token)).status, 403, "발화도 장소도 없는 동승자 폰은 여전히 못 올림");
  assert.equal((await call("POST", `${t}/audio/start`, body, driver.token)).status, 200, "운전석");
  assert.equal((await call("POST", `${t}/places`, { kind: "start", name: "신논현역" }, car.token)).status, 201);
  assert.equal((await put(t, 0, pcm, car.token)).status, 409, "운전석이 올리는 중이면 다른 기기는 끼어들지 못함");
  assert.equal((await call("POST", `${t}/audio/start`, body, phone.token)).status, 403);
  // 차 기기에서 발화가 들어오면 그때부터는 발화를 올린 기기만(이전 규칙 그대로)
  assert.equal((await call("POST", `${t}/utterances`, { device: "car-1", items: [{ seq: 1, at: trip.createdAt + 1000, text: "출발", seatArea: "ROW_2_LEFT", generation: 1 }] }, car.token)).status, 200);
  assert.equal((await call("POST", `${t}/audio/start`, body, driver.token)).status, 403, "발화가 생기면 운전석이라도 그 기기가 아니면 못 올림");
});

test("동의 철회(세대 오름)는 전체 음성·조각·잘라 둔 장면 클립을 지운다", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  const pcm = pcmOf(40);
  await upload(f, pcm, { startedAt: trip.createdAt });
  const moment = (await call("POST", `${t}/moments`, { at: trip.createdAt + 10_000, from: trip.createdAt + 5000, to: trip.createdAt + 15_000 }, phone.token)).data;
  assert.equal((await call("GET", `${t}/recordings/${moment.id}`, undefined, phone.token)).status, 200);
  await sweep();
  assert.equal(keysOf(trip.code, "trip-audio/").length, 1);
  assert.equal(keysOf(trip.code, moment.id).length, 1);

  assert.equal((await call("PATCH", `${t}/participants/${phone.id}`, { consent: false })).status, 200);
  await sweep();
  assert.deepEqual(keysOf(trip.code, ""), [], "전체 음성과 자른 클립이 버킷에서 사라진다");
  assert.deepEqual((await call("GET", `${t}/audio`, undefined, car.token)).data, { state: "none", receivedParts: 0, receivedBytes: 0, progress: 0 });
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM trip_audio WHERE trip_code = $1", [trip.code])).rows[0].n, 0);

  // 올리는 중에 철회해도 받은 조각이 지워지고, 늦게 온 옛 세대 조각은 409
  assert.equal((await call("PATCH", `${t}/participants/${phone.id}`, { consent: true }, phone.token)).status, 200);
  assert.equal((await call("POST", `${t}/audio/start`, { generation: 2, expectedBytes: pcm.length, seconds: 40, startedAt: trip.createdAt }, car.token)).status, 200);
  assert.equal((await put(t, 0, pcm.subarray(0, 64_000), car.token, 2)).status, 201);
  await sweep();
  assert.equal(keysOf(trip.code, "trip-audio/part-").length, 1);
  assert.equal((await call("PATCH", `${t}/participants/${car.id}`, { consent: false })).status, 200);
  await sweep();
  assert.deepEqual(keysOf(trip.code, ""), []);
  assert.equal((await put(t, 1, pcm.subarray(64_000, 128_000), car.token, 2)).status, 409);
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM trip_audio_parts WHERE trip_code = $1", [trip.code])).rows[0].n, 0);
});

test("버킷에 두는 사이 동의가 철회되면 둔 조각과 이은 객체를 버리고 409", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  const pcm = pcmOf(2);
  const withdraw = async () => assert.equal((await call("PATCH", `${t}/participants/${phone.id}`, { consent: false })).status, 200);
  assert.equal((await call("POST", `${t}/audio/start`, { generation: 1, expectedBytes: pcm.length, seconds: 2, startedAt: trip.createdAt }, car.token)).status, 200);
  s3.onPut = withdraw;
  assert.equal((await put(t, 0, pcm, car.token)).status, 409, "조각을 버킷에 두는 사이 세대가 올랐다");
  await sweep();
  assert.deepEqual(keysOf(trip.code, ""), []);

  assert.equal((await call("PATCH", `${t}/participants/${phone.id}`, { consent: true }, phone.token)).status, 200);
  assert.equal((await call("POST", `${t}/audio/start`, { generation: 2, expectedBytes: pcm.length, seconds: 2, startedAt: trip.createdAt }, car.token)).status, 200);
  assert.equal((await put(t, 0, pcm, car.token, 2)).status, 201);
  s3.onPut = withdraw; // 이은 객체를 버킷에 두는 사이
  assert.equal((await call("POST", `${t}/audio/complete`, { generation: 2, parts: 1, seconds: 2, sha256: sha(pcm) }, car.token)).status, 409);
  await sweep();
  assert.deepEqual(keysOf(trip.code, ""), [], "합친 객체도, 조각도 남지 않는다");
  assert.deepEqual((await call("GET", `${t}/audio`, undefined, car.token)).data.state, "none");

  // 조각을 받는 사이 차가 다른 값으로 start를 불렀다 — 앞 올리기의 조각은 새 올리기에 섞지 않는다
  assert.equal((await call("PATCH", `${t}/participants/${phone.id}`, { consent: true }, phone.token)).status, 200);
  const begin = (bytes) => call("POST", `${t}/audio/start`, { generation: 3, expectedBytes: bytes, seconds: bytes / 32_000, startedAt: trip.createdAt }, car.token);
  assert.equal((await begin(pcm.length)).status, 200);
  s3.onPut = async () => assert.equal((await begin(pcm.length * 2)).status, 200);
  assert.equal((await put(t, 0, pcm, car.token, 3)).status, 409);
  assert.equal((await call("GET", `${t}/audio`, undefined, car.token)).data.receivedParts, 0);

  // 합치는 동안 다시 부른 완료는 429, 끝난 뒤에는 같은 답
  const twice = pcmOf(4);
  assert.equal((await begin(twice.length)).status, 200);
  assert.equal((await put(t, 0, twice, car.token, 3)).status, 201);
  const finish = () => call("POST", `${t}/audio/complete`, { generation: 3, parts: 1, seconds: 4, sha256: sha(twice) }, car.token);
  let during;
  s3.onPut = async () => { during = await finish(); };
  assert.equal((await finish()).status, 200);
  assert.equal(during.status, 429);
  assert.equal((await finish()).status, 200);
});

test("DELETE /audio는 전체 음성과 거기서 자른 클립을 지우고 다시 받지 않으며, 여행을 지우면 함께 지운다", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  const pcm = pcmOf(40);
  await upload(f, pcm, { startedAt: trip.createdAt });
  const cut = (await call("POST", `${t}/moments`, { at: trip.createdAt + 10_000, from: trip.createdAt + 5000, to: trip.createdAt + 15_000 }, phone.token)).data;
  const own = (await call("POST", `${t}/moments`, { at: trip.createdAt + 30_000, from: trip.createdAt + 25_000, to: trip.createdAt + 35_000 }, phone.token)).data;
  assert.equal((await call("GET", `${t}/recordings/${cut.id}`, undefined, phone.token)).status, 200);
  const res = await fetch(`${base}/api${t}/recordings?moment=${own.id}&generation=1&from=${trip.createdAt + 25_000}`, { method: "POST", headers: { authorization: `Bearer ${car.token}`, "content-type": "audio/wav" }, body: wav(Buffer.alloc(320_000, 3)) });
  assert.equal(res.status, 201);

  // 지우기는 참가자 누구나(동의 여부와 관계없이)
  const late = (await call("POST", `${t}/participants`, { name: "늦게 탐", seat: "ROW_2_RIGHT", consent: false })).data;
  assert.equal((await call("DELETE", `${t}/audio`, undefined, late.token)).status, 204);
  await sweep();
  assert.deepEqual(keysOf(trip.code, "trip-audio/"), []);
  assert.deepEqual(keysOf(trip.code, cut.id), [], "전체 음성에서 자른 클립도 지운다");
  assert.equal(keysOf(trip.code, own.id).length, 1, "차가 올린 클립은 클립 지우기로 따로");
  assert.deepEqual((await call("GET", `${t}/audio`, undefined, phone.token)).data, { state: "none", receivedParts: 0, receivedBytes: 0, progress: 0, deleted: true });
  assert.equal((await call("PATCH", `${t}/participants/${late.id}`, { consent: true }, late.token)).status, 200);
  assert.equal((await call("GET", `${t}/recordings/${cut.id}`, undefined, phone.token)).status, 404, "지운 장면을 다시 자르지 않는다");
  assert.equal((await call("POST", `${t}/audio/start`, { generation: 1, expectedBytes: pcm.length, seconds: 40, startedAt: trip.createdAt }, car.token)).status, 409, "그 세대의 전체 음성은 다시 받지 않는다");
  assert.equal((await put(t, 0, pcm.subarray(0, 64_000), car.token)).status, 409);
  assert.equal((await call("DELETE", `${t}/audio`, undefined, phone.token)).status, 204, "다시 지워도 204");

  // 여행 줄이 지워지면(지우는 API는 없다) 트리거가 전체 음성과 클립의 키를 지울 목록에 적는다
  const g = await setup();
  await upload(g, pcmOf(20), { startedAt: g.trip.createdAt });
  const m = (await call("POST", `${g.t}/moments`, { at: g.trip.createdAt + 10_000 }, g.phone.token)).data;
  assert.equal((await call("GET", `${g.t}/recordings/${m.id}`, undefined, g.phone.token)).status, 200);
  await sweep();
  assert.equal(keysOf(g.trip.code, "").length, 2);
  await tripsDb().query("DELETE FROM trips WHERE code = $1", [g.trip.code]);
  await sweep();
  assert.deepEqual(keysOf(g.trip.code, ""), []);
  assert.equal((await tripsDb().query("SELECT count(*)::int AS n FROM recordings WHERE trip_code = $1", [g.trip.code])).rows[0].n, 0);
});

test("장면 자르기와 장면 후보는 전체 음성이 덮는 구간만, 녹음에 동의한 참가자에게만", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  // 전체 음성: 여행 시작 1분 전부터 10초 — 여행이 시작된 뒤의 장면은 소리가 없다
  await upload(f, pcmOf(10), { startedAt: trip.createdAt - 60_000 });
  const outside = (await call("POST", `${t}/moments`, { at: trip.createdAt + 5000 }, phone.token)).data;
  assert.equal((await call("GET", `${t}/recordings/${outside.id}`, undefined, phone.token)).status, 404);
  assert.equal((await call("GET", `${t}/shortform`, undefined, phone.token)).data.scenes.length, 0);

  // 동의하지 않은 참가자는 듣지 못하고(403) 자르지도 않는다. 동의하지 않은 탑승자가 있으면 자르지 않는다
  const g = await setup();
  await upload(g, pcmOf(40), { startedAt: g.trip.createdAt });
  const m = (await call("POST", `${g.t}/moments`, { at: g.trip.createdAt + 20_000 }, g.phone.token)).data;
  const late = (await call("POST", `${g.t}/participants`, { name: "늦게 탐", seat: "ROW_2_RIGHT", consent: false })).data;
  assert.equal((await call("GET", `${g.t}/recordings/${m.id}`, undefined, late.token)).status, 403);
  assert.equal((await call("GET", `${g.t}/recordings/${m.id}`, undefined, g.phone.token)).status, 403, "모두 동의하기 전에는 자르지 않는다");
  assert.equal((await call("GET", `${g.t}/shortform`, undefined, g.phone.token)).data.scenes.length, 0, "숏폼 구성은 있는 클립으로만 답한다");
  assert.equal((await call("GET", `${g.t}/recordings/${m.id}`)).status, 401);
  await sweep();
  assert.deepEqual(keysOf(g.trip.code, m.id), []);

  // 장면 후보: 전체 음성이 있으면 그 구간의 소리가 있는 후보만
  const h = await setup();
  const at = h.trip.createdAt;
  const items = [2, 3, 4, 5, 41, 42, 43, 44].map((s, i) => ({ seq: i + 2, at: at + s * 1000, text: `말 ${i}`, seatArea: i % 2 ? "ROW_1_LEFT" : "ROW_1_RIGHT", generation: 1 }));
  assert.equal((await call("POST", `${h.t}/utterances`, { device: "car-1", items }, h.car.token)).status, 200);
  const before = (await call("GET", `${h.t}/scene-suggestions`, undefined, h.phone.token)).data.items;
  assert.equal(before.length, 2);
  await upload(h, pcmOf(25), { startedAt: at - 5000 }); // 여행 -5초 ~ 20초
  const afterItems = (await call("GET", `${h.t}/scene-suggestions`, undefined, h.phone.token)).data.items;
  assert.deepEqual(afterItems.map((x) => x.at), [before[0].at]);
  void car;
});

test("치우기가 다 올린 뒤 2일이 지난 전체 음성만 지우고(장면 클립은 남음), 만료로 보이고, 장면은 클립 경로로 답한다(11/15 보관 결정)", async () => {
  const f = await setup();
  const { trip, t, car, phone } = f;
  const pcm = pcmOf(40);
  await upload(f, pcm, { startedAt: trip.createdAt });
  const cut = (await call("POST", `${t}/moments`, { at: trip.createdAt + 5000, from: trip.createdAt + 1000, to: trip.createdAt + 9000 }, phone.token)).data;
  assert.equal((await call("GET", `${t}/recordings/${cut.id}`, undefined, phone.token)).status, 200, "만료 전에 잘라 둔 장면 클립");
  const cutOne = (await call("POST", `${t}/moments`, { at: trip.createdAt + 15_000, from: trip.createdAt + 11_000, to: trip.createdAt + 19_000 }, phone.token)).data;
  const own = (await call("POST", `${t}/moments`, { at: trip.createdAt + 30_000, from: trip.createdAt + 25_000, to: trip.createdAt + 35_000 }, phone.token)).data;
  const res = await fetch(`${base}/api${t}/recordings?moment=${own.id}&generation=1&from=${trip.createdAt + 25_000}`, { method: "POST", headers: { authorization: `Bearer ${car.token}`, "content-type": "audio/wav" }, body: wav(Buffer.alloc(320_000, 5)) });
  assert.equal(res.status, 201);
  // 다른 여행: 아직 2일이 안 된 전체 음성은 치우기가 건드리지 않는다
  const young = await setup();
  await upload(young, pcmOf(4), { startedAt: young.trip.createdAt });
  await sweep();
  assert.equal(keysOf(trip.code, "trip-audio/").length, 1);

  // 2일이 지남: 치우기(10분마다)가 전체 음성만 버킷에서 지운다. 장면 클립(자른 것·차가 올린 것)은 그대로
  await tripsDb().query("UPDATE trip_audio SET ready_at = now() - interval '2 days 1 minute' WHERE trip_code = $1", [trip.code]);
  await sweep();
  assert.deepEqual(keysOf(trip.code, "trip-audio/"), [], "전체 음성은 지움");
  assert.equal(keysOf(trip.code, cut.id).length, 1, "잘라 둔 장면 클립은 사람이 지울 때까지 남는다");
  assert.equal(keysOf(trip.code, own.id).length, 1, "차가 올린 장면 클립도 남는다");
  assert.equal(keysOf(young.trip.code, "trip-audio/").length, 1, "2일이 안 된 전체 음성은 남는다");
  const s = (await call("GET", `${t}/audio`, undefined, phone.token)).data;
  assert.equal(s.state, "expired");
  assert.ok(s.expiresAt < Date.now());
  const before = s3.log.length;
  assert.equal((await call("GET", `${t}/recordings/${cutOne.id}`, undefined, phone.token)).status, 404, "만료 뒤에는 새로 자르지 않는다(500 없음)");
  assert.equal(s3.log.slice(before).filter((x) => x.range).length, 0, "만료된 전체 음성은 읽지 않는다");
  assert.equal((await call("GET", `${t}/recordings/${cut.id}`, undefined, phone.token)).status, 200);
  assert.equal((await call("GET", `${t}/recordings/${own.id}`, undefined, phone.token)).status, 200, "차가 올린 장면 클립 경로는 그대로");
  assert.equal((await call("GET", `${t}/shortform`, undefined, phone.token)).data.scenes.length, 2);
  assert.equal((await call("POST", `${t}/audio/complete`, { generation: 1, parts: 1, seconds: 40, sha256: sha(pcm) }, car.token)).status, 409, "완료를 다시 불러도 만료됐다고 알린다");
  await sweep();
  assert.equal(keysOf(trip.code, cut.id).length, 1, "치우기를 다시 돌려도 장면 클립은 남는다");

  // 2일 전이라도 버킷에서 이미 사라졌으면(404) 만료로 적고 500 없이 404
  const g = await setup();
  await upload(g, pcmOf(20), { startedAt: g.trip.createdAt });
  const m = (await call("POST", `${g.t}/moments`, { at: g.trip.createdAt + 10_000 }, g.phone.token)).data;
  for (const k of keysOf(g.trip.code, "trip-audio/")) s3.objects.delete(k);
  assert.equal((await call("GET", `${g.t}/recordings/${m.id}`, undefined, g.phone.token)).status, 404);
  assert.equal((await call("GET", `${g.t}/audio`, undefined, g.phone.token)).data.state, "expired");
  assert.equal((await call("GET", `${g.t}/shortform`, undefined, g.phone.token)).status, 200);

  // 새로 다 올리면 만료가 풀린다(다시 출발한 여행)
  const again = pcmOf(10);
  assert.equal((await call("POST", `${g.t}/audio/start`, { generation: 1, expectedBytes: again.length, seconds: 10, startedAt: g.trip.createdAt }, g.car.token)).status, 200);
  assert.equal((await put(g.t, 0, again, g.car.token)).status, 201);
  assert.equal((await call("POST", `${g.t}/audio/complete`, { generation: 1, parts: 1, seconds: 10, sha256: sha(again) }, g.car.token)).status, 200);
  assert.equal((await call("GET", `${g.t}/audio`, undefined, g.phone.token)).data.state, "ready");
});
