// 여행 전체 음성(ADR-0024, docs/api/voice.md). 주차한 뒤 차가 여행의 원음 전체(16 kHz 모노 s16le PCM)를
// 조각으로 올리고, 서버는 조각을 클립 버킷에 두었다가 완료 때 순서대로 이어 객체 하나로 둔다.
// 사람이 고른 장면의 클립은 그 객체에서 바이트 범위만 읽어 잘라 일반 클립 줄(recordings)로 남긴다 —
// 숏폼 구성·재전사(T75)·내보내기(T107)·클립 지우기가 차가 올린 클립과 같은 길을 쓰게.
//
// 잠금: 본문을 받거나 S3를 기다리는 동안 여행 줄을 잠그지 않는다(recordings와 같은 까닭: 느린 업로드가 동의 철회를
// 질의 제한 시간에 걸리게 하지 않게). 받기 전에 한 번 보고, 버킷에 둔 뒤 여행 줄을 잠그고 다시 본다.
// 그 사이 동의 철회·삭제가 있었으면 둔 것을 clip_trash로 보내고 거절한다.
// 지우기: 세대가 오르거나 여행 줄이 지워지면 DB 트리거(trips-15-trip-audio.sql)가 키를 clip_trash에 적는다.
import { createHash, randomUUID } from "node:crypto";
import { tripsDb } from "./db.js";
import { errFields, log } from "./log.js";
import { audioStore } from "./providers/clips.js";
import { momentSpan } from "./scenes.js";

const fail = (status, error) => {
  throw { status, error };
};

export const BYTES_PER_SECOND = 32_000; // 16 kHz × 16비트 × 모노
const BYTES_PER_MS = 32;
export const PART_MAX = 4 * 1024 * 1024; // 조각 하나 4 MiB(약 131초)
export const AUDIO_MAX_SECONDS = 8 * 3600; // 여행 하나 8시간(921.6 MB)
export const AUDIO_MAX_BYTES = AUDIO_MAX_SECONDS * BYTES_PER_SECOND;
const PART_NUMBER = /^(0|[1-9][0-9]{0,3})$/; // n: 0~9999
const CHUNK = 8 * 1024 * 1024; // 합칠 때 멀티파트 한 조각(S3는 마지막 빼고 5 MiB 이상)
const LEASE_MINUTES = 10; // 합치는 동안 다른 완료를 받지 않는 시간. 8시간 음성도 넉넉히 끝나는 값
const SCENES_PER_CALL = 20;
// 보관(11/15 오너 결정 '2일 뒤 만료'): 다 올린 뒤 2일. 지우는 것은 클립 버킷의 수명 규칙(올린 뒤 2일)이고, API는 그때부터 만료로 본다.
export const AUDIO_KEEP_MS = 2 * 86_400_000;
const KEEP = "interval '2 days'";
// ponytail: 파드마다 동시에 받는 조각과 합치기 수. 메모리는 조각 4 MiB, 합치기 약 16 MiB씩이다.
const RECEIVING_MAX = 8;
const ASSEMBLING_MAX = 2;

const everyoneConsents = (trip) => trip.participants.length > 0 && trip.participants.every((p) => p.consent);
const intOf = (v, min, max, name) => (Number.isInteger(v) && v >= min && v <= max ? v : fail(400, `${name}: ${min}~${max} 사이 정수`));

// 16 kHz 모노 16비트 PCM에 붙이는 WAV 머리(44바이트).
function wavHead(bytes) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + bytes, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 모노
  head.writeUInt32LE(16_000, 24);
  head.writeUInt32LE(BYTES_PER_SECOND, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(bytes, 40);
  return head;
}

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, `조각은 ${limit}바이트까지`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 장면 구간과 전체 음성이 겹치는 곳. 장면 구간의 절반 넘게 소리가 있을 때만 쓴다(추천과 자르기가 같은 기준).
function overlap(span, audio) {
  const startedAt = Number(audio.started_at);
  const from = Math.max(span.from, startedAt);
  const to = Math.min(span.to, startedAt + Math.floor(Number(audio.bytes) / BYTES_PER_MS));
  return to - from >= Math.max(500, (span.to - span.from) / 2) ? { from, to } : null;
}

// 상태 응답. 계약(최종 개편 계획 A4)의 칸에 generation·startedAt·partNumbers·previous·deleted를 더했다.
function view(r, parts = []) {
  if (!r || r.deleted_at) return { state: "none", receivedParts: 0, receivedBytes: 0, progress: 0, ...(r?.deleted_at ? { deleted: true } : {}) };
  // 만료(r.expired): 다 올린 뒤 2일이 지났거나 버킷에서 사라짐. 장면을 자르지 않는다(차가 올린 장면 클립은 그대로)
  const ready = r.object_key && !r.expired ? { bytes: Number(r.bytes), seconds: r.seconds, startedAt: Number(r.started_at), expiresAt: new Date(r.ready_at).getTime() + AUDIO_KEEP_MS } : null;
  if (!r.upload_id && r.object_key && r.expired)
    return { state: "expired", generation: r.generation, receivedParts: r.part_count, receivedBytes: Number(r.bytes), expectedBytes: Number(r.bytes), seconds: r.seconds, startedAt: Number(r.started_at), progress: 1, expiresAt: new Date(r.ready_at).getTime() + AUDIO_KEEP_MS };
  if (!r.upload_id)
    return { state: "ready", generation: r.generation, receivedParts: r.part_count, receivedBytes: ready.bytes, expectedBytes: ready.bytes, seconds: ready.seconds, startedAt: ready.startedAt, progress: 1, expiresAt: ready.expiresAt };
  const receivedBytes = parts.reduce((sum, p) => sum + p.bytes, 0);
  const expected = r.expected_bytes == null ? null : Number(r.expected_bytes);
  return {
    state: "uploading",
    generation: r.generation,
    receivedParts: parts.length,
    receivedBytes,
    ...(expected != null ? { expectedBytes: expected } : {}),
    ...(r.upload_seconds != null ? { seconds: r.upload_seconds } : {}),
    ...(r.upload_started_at != null ? { startedAt: Number(r.upload_started_at) } : {}),
    progress: expected ? Math.min(1, Math.round((receivedBytes / expected) * 1000) / 1000) : 0,
    partNumbers: parts.map((p) => p.n),
    ...(ready ? { previous: ready } : {}), // 다시 출발해 새로 올리는 동안 장면 자르기에 쓰는 앞의 전체 음성
  };
}

// ctx: server.js가 넘기는 여행 잠금·참가자 토큰·버킷 비우기·재전사 예약.
export function tripAudio({ withTrip, participantOf, sweepClips, queueRetranscribe }) {
  let receiving = 0;
  let assembling = 0;
  const store = () => audioStore() ?? fail(503, "클립 저장소가 없음"); // CLIPS_BUCKET이 없는 환경(로컬·E2E)
  // leased: 합치는 중(시각은 DB의 시계로 잰다 — 파드마다 시계가 조금씩 달라도 같게)
  const rowOf = async (client, code) =>
    (await client.query(`SELECT *, COALESCE(assembling_until > now(), false) AS leased,
       (object_key IS NOT NULL AND (expired_at IS NOT NULL OR ready_at < now() - ${KEEP})) AS expired FROM trip_audio WHERE trip_code = $1`, [code])).rows[0] ?? null;
  const partsOf = async (client, code, uploadId) =>
    (await client.query("SELECT n, bytes, object_key FROM trip_audio_parts WHERE trip_code = $1 AND upload_id = $2 ORDER BY n", [code, uploadId])).rows;
  const trashIn = (client, keys) => client.query("INSERT INTO clip_trash (object_key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [keys]);
  // 남기지 못한 소리의 키를 적고 바로 한 번 비운다. 던지지 않는다.
  const trash = (keys) =>
    tripsDb()
      .query("INSERT INTO clip_trash (object_key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [keys])
      .then(() => void sweepClips())
      .catch((e) => log("warn", "clip_trash_failed", { err: errFields(e) }));

  // 올릴 수 있는가: 이 여행의 참가자 토큰, 지금 동의 세대, 녹음에 모두 동의, 그 여행의 발화를 올린 기기의 주인.
  // 세대를 동의보다 먼저 본다: 철회한 본인의 토큰으로 올려도 '나중에 다시'(403)가 아니라 '버림'(409)이 되게(recordings와 같음).
  async function uploaderOf(req, trip, client, generation) {
    const caller = participantOf(req, trip);
    const current = trip.generation ?? 1;
    if (intOf(generation, 1, current, "generation") < current) fail(409, "동의가 바뀌기 전의 소리라 받지 않음");
    if (!caller.consent) fail(403, "녹음에 동의한 참가자만 올릴 수 있음");
    if (!everyoneConsents(trip)) fail(403, "동의하지 않은 탑승자가 있어 올릴 수 없음");
    // 녹음한 그 기기: 발화 올리기의 기기 주인(utterance_acks.participant_id)만. 폰 참가자가 아무 소리나 '여행 음성'으로 올리지 못하게.
    const { rows } = await client.query("SELECT 1 FROM utterance_acks WHERE trip_code = $1 AND participant_id = $2 LIMIT 1", [trip.code, caller.id]);
    if (!rows[0]) fail(403, "이 여행의 발화를 올린 기기만 전체 음성을 올릴 수 있음");
    const r = await rowOf(client, trip.code);
    if (r?.deleted_at) fail(409, "지운 전체 음성은 다시 받지 않음");
    if (r?.upload_id && r.participant_id !== caller.id) fail(409, "다른 기기가 올리는 중");
    return { caller, r };
  }
  const leased = (r) => Boolean(r?.leased);

  async function status(req, code) {
    return withTrip(code, false, async (trip, client) => {
      participantOf(req, trip); // 진행률은 소리가 아니라 동의와 관계없이 참가자 누구나(폰의 P22)
      const r = await rowOf(client, trip.code);
      return [200, view(r, r?.upload_id ? await partsOf(client, trip.code, r.upload_id) : [])];
    });
  }

  // 올리기 시작: 전체 크기·길이·첫 표본의 시각을 알린다. 같은 값으로 다시 부르면 받은 조각을 그대로 둔다(재시도 안전).
  async function start(req, code, b) {
    store();
    return withTrip(code, true, async (trip, client) => {
      const { caller, r } = await uploaderOf(req, trip, client, b.generation);
      if (Number.isInteger(b.expectedBytes) && b.expectedBytes > AUDIO_MAX_BYTES) fail(413, `전체 음성은 ${AUDIO_MAX_SECONDS / 3600}시간까지`);
      const expected = intOf(b.expectedBytes, 2, AUDIO_MAX_BYTES, "expectedBytes");
      if (expected % 2) fail(400, "expectedBytes: 16비트 PCM이라 짝수");
      const seconds = typeof b.seconds === "number" && b.seconds > 0 && b.seconds <= AUDIO_MAX_SECONDS ? b.seconds : fail(400, "seconds: 0 초과 숫자");
      if (Math.abs(expected / BYTES_PER_SECOND - seconds) > 1) fail(400, "seconds가 expectedBytes와 맞지 않음(16 kHz 모노 16비트)");
      const startedAt = intOf(b.startedAt, trip.createdAt - 60_000, Date.now() + 60_000, "startedAt");
      if (leased(r)) fail(429, "합치는 중 — 잠시 뒤 상태를 확인해 주세요");
      const same = (bytes, at) => bytes != null && Number(bytes) === expected && Number(at) === startedAt;
      if (!r?.upload_id && r?.object_key && same(r.bytes, r.started_at)) return [200, view(r)]; // 이미 다 올림
      if (r?.upload_id && (r.expected_bytes == null || same(r.expected_bytes, r.upload_started_at))) {
        // 같은 올리기(또는 start 전에 받은 조각): 받은 조각을 두고 값만 적는다
        await client.query("UPDATE trip_audio SET expected_bytes = $2, upload_seconds = $3, upload_started_at = $4, updated_at = now() WHERE trip_code = $1", [trip.code, expected, seconds, startedAt]);
        return [200, view(await rowOf(client, trip.code), await partsOf(client, trip.code, r.upload_id))];
      }
      // 새 올리기. 앞의 올리던 조각은 버린다. 다 올린 전체 음성은 새것을 다 올릴 때까지 둔다(다시 출발한 여행).
      if (r?.upload_id) {
        await trashIn(client, (await partsOf(client, trip.code, r.upload_id)).map((p) => p.object_key));
        await client.query("DELETE FROM trip_audio_parts WHERE trip_code = $1", [trip.code]);
      }
      const uploadId = randomUUID();
      await client.query(
        `INSERT INTO trip_audio (trip_code, generation, participant_id, upload_id, expected_bytes, upload_seconds, upload_started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (trip_code) DO UPDATE SET participant_id = $3, upload_id = $4, expected_bytes = $5, upload_seconds = $6, upload_started_at = $7, updated_at = now()`,
        [trip.code, trip.generation ?? 1, caller.id, uploadId, expected, seconds, startedAt]
      );
      return [200, view(await rowOf(client, trip.code), [])];
    }).finally(() => void sweepClips());
  }

  // 조각 하나. 같은 n을 다시 보내면 덮는다 — 키는 받을 때마다 새로 만들고 앞의 키는 clip_trash로 보낸다.
  async function putPart(req, code, leaf, query) {
    const s3 = store();
    if (!PART_NUMBER.test(leaf)) fail(400, "n: 0~9999 정수");
    const n = Number(leaf);
    const generation = Number(query.get("generation"));
    const check = async (trip, client) => {
      const { caller, r } = await uploaderOf(req, trip, client, generation);
      if (!r?.upload_id && r?.object_key) fail(409, "이미 다 올림 — 새로 올리려면 start부터");
      if (leased(r)) fail(429, "합치는 중 — 잠시 뒤 상태를 확인해 주세요");
      return { caller, r, tripCode: trip.code };
    };
    const before = await withTrip(code, false, check);
    if (Number(req.headers["content-length"] ?? 0) > PART_MAX) fail(413, `조각은 ${PART_MAX}바이트까지`);
    if (receiving >= RECEIVING_MAX) fail(429, "다른 조각을 받는 중 — 잠시 뒤 다시 보내 주세요");
    receiving++;
    try {
      const body = await readRaw(req, PART_MAX);
      if (!body.length || body.length % 2) fail(400, "조각은 비어 있지 않은 16비트 PCM(짝수 바이트)");
      const key = `${before.tripCode}/audio/part-${n}-${randomUUID()}.pcm`;
      try {
        await s3.put(key, body); // 늦게 실패해도(제한 시간 뒤에 저장됨) 아래에서 키를 버린다
        const result = await withTrip(code, true, async (trip, client) => {
          let { caller, r } = await check(trip, client);
          // 받는 사이 차가 다른 값으로 start를 불러 새 올리기가 열렸다 — 앞 올리기의 조각이라 버린다
          if (before.r?.upload_id && r?.upload_id !== before.r.upload_id) fail(409, "그 사이 새로 올리기를 시작함");
          if (!r?.upload_id) {
            // start 전에 온 조각: 크기를 모르는 올리기를 연다(진행률 0, 완료 때 startedAt이 필요)
            await client.query(
              `INSERT INTO trip_audio (trip_code, generation, participant_id, upload_id) VALUES ($1, $2, $3, $4)
               ON CONFLICT (trip_code) DO UPDATE SET participant_id = $3, upload_id = $4, updated_at = now()`,
              [trip.code, trip.generation ?? 1, caller.id, randomUUID()]
            );
            r = await rowOf(client, trip.code);
          }
          const { rows } = await client.query(
            `SELECT COALESCE(SUM(bytes) FILTER (WHERE n <> $3), 0)::bigint AS others, MAX(object_key) FILTER (WHERE n = $3) AS old
             FROM trip_audio_parts WHERE trip_code = $1 AND upload_id = $2`,
            [trip.code, r.upload_id, n]
          );
          if (Number(rows[0].others) + body.length > AUDIO_MAX_BYTES) fail(413, `전체 음성은 ${AUDIO_MAX_SECONDS / 3600}시간까지`);
          if (rows[0].old) await trashIn(client, [rows[0].old]);
          await client.query(
            `INSERT INTO trip_audio_parts (trip_code, upload_id, n, bytes, object_key) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (trip_code, upload_id, n) DO UPDATE SET bytes = $4, object_key = $5, received_at = now()`,
            [trip.code, r.upload_id, n, body.length, key]
          );
          await client.query("UPDATE trip_audio SET updated_at = now() WHERE trip_code = $1", [trip.code]);
          return [201, { n, bytes: body.length }];
        });
        void sweepClips(); // 덮은 조각을 버킷에서 지운다
        return result;
      } catch (e) {
        await trash([key]); // 남기지 못한 조각은 버킷에 두지 않는다
        throw e;
      }
    } finally {
      receiving--;
    }
  }

  // 조각을 순서대로 읽어 sha256을 세며 객체 하나로 잇는다. 메모리에는 멀티파트 한 조각(8 MiB 남짓)과 미리 읽은 조각 하나만.
  async function assemble(s3, key, parts) {
    const hash = createHash("sha256");
    const read = (p) => {
      const pending = s3.get(p.object_key).then((buf) =>
        buf && buf.length === p.bytes ? buf : fail(409, `조각 ${p.n}이 그 사이 지워졌거나 바뀜 — 다시 올려 주세요`)
      );
      pending.catch(() => {}); // 미리 읽은 것이 실패해도 기다릴 때 던진다(처리되지 않은 거절로 프로세스가 죽지 않게)
      return pending;
    };
    const total = parts.reduce((sum, p) => sum + p.bytes, 0);
    if (total <= CHUNK) {
      const bufs = [];
      for (const p of parts) bufs.push(await read(p));
      for (const b of bufs) hash.update(b);
      await s3.put(key, Buffer.concat(bufs));
      return hash.digest("hex");
    }
    const upload = await s3.multipart(key);
    try {
      let pending = [];
      let size = 0;
      let next = read(parts[0]);
      for (let i = 0; i < parts.length; i++) {
        const buf = await next;
        if (i + 1 < parts.length) next = read(parts[i + 1]);
        hash.update(buf);
        pending.push(buf);
        size += buf.length;
        if (size >= CHUNK) {
          await upload.part(Buffer.concat(pending));
          pending = [];
          size = 0;
        }
      }
      if (pending.length) await upload.part(Buffer.concat(pending));
      await upload.complete();
    } catch (e) {
      if (!(await upload.abort())) log("warn", "trip_audio_abort_failed", { key });
      throw e;
    }
    return hash.digest("hex");
  }

  async function complete(req, code, b) {
    const s3 = store();
    const done = (r) => [200, { state: "ready", seconds: r.seconds, bytes: Number(r.bytes), startedAt: Number(r.started_at) }];
    const plan = await withTrip(code, true, async (trip, client) => {
      const { caller, r } = await uploaderOf(req, trip, client, b.generation);
      const count = intOf(b.parts, 1, 10_000, "parts");
      const seconds = typeof b.seconds === "number" && b.seconds > 0 ? b.seconds : fail(400, "seconds: 0 초과 숫자");
      const sha = typeof b.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(b.sha256) ? b.sha256.toLowerCase() : fail(400, "sha256: 16진수 64자");
      const startedAtBody = b.startedAt === undefined ? null : intOf(b.startedAt, trip.createdAt - 60_000, Date.now() + 60_000, "startedAt");
      if (!r?.upload_id) {
        if (r?.object_key && r.sha256 === sha) {
          if (r.expired) fail(409, "이미 다 올렸고 보관 기간(2일)이 지나 지워졌음"); // 차는 버린다
          return { done: r }; // 완료 응답을 못 받고 다시 부름(멱등)
        }
        fail(409, "올리는 중인 전체 음성이 없음 — start부터 다시 올려 주세요");
      }
      if (leased(r)) fail(429, "합치는 중 — 잠시 뒤 상태를 확인해 주세요");
      const parts = (await partsOf(client, trip.code, r.upload_id)).filter((p) => p.n < count);
      const have = new Set(parts.map((p) => p.n));
      const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !have.has(i));
      if (missing.length) fail(409, `받지 못한 조각: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}`);
      const total = parts.reduce((sum, p) => sum + p.bytes, 0);
      if (r.expected_bytes != null && total !== Number(r.expected_bytes)) fail(409, `받은 크기(${total})가 start에서 알린 크기(${r.expected_bytes})와 다름`);
      if (Math.abs(total / BYTES_PER_SECOND - seconds) > 1) fail(400, "seconds가 받은 크기와 맞지 않음(16 kHz 모노 16비트)");
      const startedAt = r.upload_started_at != null ? Number(r.upload_started_at) : (startedAtBody ?? fail(400, "startedAt: start나 complete에 첫 표본의 시각이 필요함"));
      await client.query(`UPDATE trip_audio SET assembling_until = now() + interval '${LEASE_MINUTES} minutes', upload_started_at = $2 WHERE trip_code = $1`, [trip.code, startedAt]);
      return { caller, uploadId: r.upload_id, parts, total, count, sha, startedAt, tripCode: trip.code };
    });
    if (plan.done) return done(plan.done);
    const release = () =>
      tripsDb()
        .query("UPDATE trip_audio SET assembling_until = NULL WHERE trip_code = $1 AND upload_id = $2", [plan.tripCode, plan.uploadId])
        .catch((e) => log("warn", "trip_audio_release_failed", { err: errFields(e) }));
    if (assembling >= ASSEMBLING_MAX) {
      await release();
      fail(429, "다른 여행의 음성을 합치는 중 — 잠시 뒤 다시 완료해 주세요");
    }
    assembling++;
    const key = `${plan.tripCode}/audio/${plan.uploadId}-${randomUUID().slice(0, 8)}.pcm`;
    let kept = false;
    const started = Date.now();
    try {
      const sha = await assemble(s3, key, plan.parts);
      if (sha !== plan.sha) {
        // 틀린 조각이 섞였다: 받은 조각을 모두 버린다. 차는 같은 올리기에 조각을 처음부터 다시 보낸다.
        await withTrip(code, true, async (trip, client) => {
          const r = await rowOf(client, trip.code);
          if (r?.upload_id !== plan.uploadId) return;
          await trashIn(client, (await partsOf(client, trip.code, plan.uploadId)).map((p) => p.object_key));
          await client.query("DELETE FROM trip_audio_parts WHERE trip_code = $1 AND upload_id = $2", [trip.code, plan.uploadId]);
          await client.query("UPDATE trip_audio SET assembling_until = NULL, updated_at = now() WHERE trip_code = $1", [trip.code]);
        });
        log("info", "trip_audio_sha_mismatch", { parts: plan.count, bytes: plan.total });
        fail(409, "sha256이 맞지 않음 — 조각을 처음부터 다시 올려 주세요");
      }
      const result = await withTrip(code, true, async (trip, client) => {
        // 합치는 사이 동의 철회(세대 오름, 트리거가 줄을 지움)·지우기·새 올리기가 있었으면 남기지 않는다
        participantOf(req, trip);
        if ((trip.generation ?? 1) !== Number(b.generation)) fail(409, "동의가 바뀌기 전의 소리라 받지 않음");
        if (!everyoneConsents(trip)) fail(403, "동의하지 않은 탑승자가 있어 올릴 수 없음");
        const r = await rowOf(client, trip.code);
        if (!r || r.deleted_at || r.upload_id !== plan.uploadId) fail(409, "그 사이 지워졌거나 새로 올리기 시작함");
        await trashIn(client, [...(await partsOf(client, trip.code, plan.uploadId)).map((p) => p.object_key), ...(r.object_key ? [r.object_key] : [])]);
        await client.query("DELETE FROM trip_audio_parts WHERE trip_code = $1", [trip.code]);
        const seconds = Math.round(plan.total / BYTES_PER_MS) / 1000;
        await client.query(
          `UPDATE trip_audio SET upload_id = NULL, expected_bytes = NULL, upload_seconds = NULL, upload_started_at = NULL, assembling_until = NULL,
             object_key = $2, bytes = $3, seconds = $4, started_at = $5, sha256 = $6, part_count = $7, participant_id = $8, ready_at = now(), expired_at = NULL, updated_at = now()
           WHERE trip_code = $1`,
          [trip.code, key, plan.total, seconds, plan.startedAt, plan.sha, plan.count, plan.caller.id]
        );
        return done({ seconds, bytes: plan.total, started_at: plan.startedAt });
      });
      kept = true;
      log("info", "trip_audio_ready", { parts: plan.count, bytes: plan.total, ms: Date.now() - started });
      return result;
    } catch (e) {
      await release();
      throw e;
    } finally {
      assembling--;
      if (!kept) await trash([key]); // 남기지 못한 객체는 버킷에 두지 않는다(만들지 못했으면 지우기는 그냥 성공)
      void sweepClips(); // 조각과 앞의 전체 음성을 버킷에서 지운다
    }
  }

  // 사람의 지우기: 이 여행의 참가자 누구나(동의 여부 무관, 클립 지우기와 같음). 다 올린 것·올리던 조각·전체 음성에서 자른 장면 클립을
  // 지우고 표시를 남긴다 — 그 세대의 전체 음성은 다시 받지 않는다(차는 버림). 차가 올린 클립은 클립 지우기로 따로 지운다.
  async function remove(req, code) {
    store();
    const result = await withTrip(code, true, async (trip, client) => {
      const caller = participantOf(req, trip);
      await client.query("SELECT trip_audio_wipe($1)", [trip.code]);
      await client.query(
        `WITH r AS (UPDATE recordings SET deleted_at = now() WHERE trip_code = $1 AND cut_from_audio AND deleted_at IS NULL RETURNING object_key)
         INSERT INTO clip_trash (object_key) SELECT object_key FROM r ON CONFLICT DO NOTHING`,
        [trip.code]
      );
      await client.query("INSERT INTO trip_audio (trip_code, generation, participant_id, deleted_at) VALUES ($1, $2, $3, now())", [trip.code, trip.generation ?? 1, caller.id]);
      return [204];
    });
    void sweepClips();
    return result;
  }

  // 다 올린 전체 음성(지금 세대). 세대가 오르면 트리거가 줄을 지우므로 남아 있으면 지금 세대다.
  const readyOf = async (client, code) =>
    (await client.query(`SELECT * FROM trip_audio WHERE trip_code = $1 AND object_key IS NOT NULL AND deleted_at IS NULL
       AND expired_at IS NULL AND ready_at >= now() - ${KEEP}`, [code])).rows[0] ?? null;

  // 차의 클립이 없는 장면을 전체 음성에서 잘라 클립 줄로 남긴다. 녹음에 동의한 참가자가 들으려 할 때(GET /recordings/:id)와
  // 숏폼 구성을 읽을 때(GET /shortform)만 돈다. 클립 줄이 이미 있으면(차가 올림, 사람이 지운 표시) 건드리지 않는다.
  async function cutScenes(req, code, momentId) {
    const s3 = audioStore();
    if (!s3) return;
    let plan;
    try {
      plan = await withTrip(code, false, async (trip, client) => {
        if (!participantOf(req, trip).consent) return null; // 거절은 클립 경로가 제 상태로 답한다
        const audio = await readyOf(client, trip.code);
        if (!audio) return null;
        const ids = momentId ? [momentId] : trip.moments.map((x) => x.id);
        const { rows } = await client.query("SELECT moment_id FROM recordings WHERE trip_code = $1 AND moment_id = ANY($2::text[])", [trip.code, ids]);
        const have = new Set(rows.map((x) => x.moment_id));
        const todo = trip.moments
          .filter((x) => ids.includes(x.id) && !have.has(x.id))
          .flatMap((x) => {
            const span = overlap(momentSpan(x), audio);
            return span ? [{ momentId: x.id, span }] : [];
          })
          .slice(0, SCENES_PER_CALL);
        // 클립 올리기와 같은 규칙. 장면 하나를 들으려 할 때는 까닭을 알리고, 숏폼 구성은 있는 클립만으로 그대로 답한다
        if (todo.length && !everyoneConsents(trip)) return momentId ? fail(403, "동의하지 않은 탑승자가 있어 장면을 자를 수 없음") : null;
        return todo.length ? { audio, todo, tripCode: trip.code } : null;
      });
    } catch (e) {
      if (e?.status === 401 || e?.status === 404) return;
      throw e;
    }
    if (!plan) return;
    const startedAt = Number(plan.audio.started_at);
    for (const { momentId: id, span } of plan.todo) {
      // 시각은 정수 밀리초라 표본(1 ms = 16)과 바이트(32)에 딱 맞는다
      const start = (span.from - startedAt) * BYTES_PER_MS;
      const pcm = await s3.range(plan.audio.object_key, start, Math.min(Number(plan.audio.bytes), (span.to - startedAt) * BYTES_PER_MS));
      if (!pcm?.length) {
        // 버킷에서 사라짐(수명 규칙 2일): 만료로 적고 자르기를 멈춘다. 클립 경로는 차가 올린 클립이 있으면 그것을, 없으면 404
        await tripsDb().query("UPDATE trip_audio SET expired_at = now() WHERE trip_code = $1 AND object_key = $2 AND expired_at IS NULL", [plan.tripCode, plan.audio.object_key]);
        log("info", "trip_audio_expired", {});
        return;
      }
      const key = `${plan.tripCode}/${id}-${randomUUID().slice(0, 8)}.wav`;
      const wav = Buffer.concat([wavHead(pcm.length), pcm]);
      const seconds = Math.round(pcm.length / BYTES_PER_MS) / 1000;
      let kept = false;
      try {
        await s3.put(key, wav, "audio/wav");
        kept = await withTrip(code, true, async (trip, client) => {
          const now = await readyOf(client, trip.code);
          if (!now || now.object_key !== plan.audio.object_key || !everyoneConsents(trip)) return false;
          const { rowCount } = await client.query(
            `INSERT INTO recordings (trip_code, moment_id, generation, participant_id, object_key, start_at, bytes, seconds, cut_from_audio)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) ON CONFLICT DO NOTHING`,
            [trip.code, id, now.generation, now.participant_id, key, span.from, wav.length, seconds]
          );
          return rowCount > 0;
        });
      } finally {
        if (!kept) await trash([key]); // 그 사이 지웠거나 다른 요청이 먼저 잘랐다
      }
      if (kept) queueRetranscribe(plan.tripCode, id); // 차가 올린 클립처럼 자막을 다시 받아 적는다(T75)
    }
  }

  // 장면 후보(GET /scene-suggestions)에서 전체 음성이 있으면 장면 구간의 소리가 있는 것만 남긴다(자르기와 같은 기준).
  async function audible(code, items) {
    const audio = await readyOf(tripsDb(), String(code).toUpperCase());
    return audio ? items.filter((x) => overlap({ from: x.from, to: x.to }, audio)) : items;
  }

  async function request(req, code, id, leaf, b, query) {
    const m = req.method;
    if (id === undefined) {
      if (m === "GET") return status(req, code);
      if (m === "DELETE") return remove(req, code);
      fail(405, "GET, DELETE만 됨");
    }
    if (id === "parts" && leaf !== undefined) {
      if (m !== "PUT") fail(405, "PUT만 됨");
      return putPart(req, code, leaf, query);
    }
    if ((id === "start" || id === "complete") && leaf === undefined) {
      if (m !== "POST") fail(405, "POST만 됨");
      return id === "start" ? start(req, code, b) : complete(req, code, b);
    }
    fail(404, "없는 경로");
  }

  return { request, cutScenes, audible };
}
