import { createHash, randomUUID } from "node:crypto";
import { tripsDb } from "./db.js";
import { fingerprint } from "./short-templates.js";
import { generationView } from "./short-generations.js";
import { mediaReady, shortMedia } from "./providers/short-media.js";
import { ASSET_MAX_BYTES, inspectVideo } from "./providers/short-asset-probe.js";
import { log } from "./log.js";

const fail = (status, error) => { throw { status, error }; };
const uuid = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const hash = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const ensure = (trip, caller) => {
  if (!caller.consent || !trip.participants.length || !trip.participants.every(p => p.consent)) fail(403, "모든 동승자의 녹음 동의가 필요해요");
};
const parked = (trip) => { if (!["parked", "ended"].includes(trip.status)) fail(409, "주차한 뒤 영상을 보관할 수 있어요"); };
const view = (row, state = row.state) => ({
  id: row.id, origin: "local-render", state, momentId: row.moment_id, generation: row.generation,
  sourceHash: row.source_hash, createdAt: row.created_at, createdBy: row.participant_id,
  ...(state === "completed" ? { result: { ...row.media, sha256: row.sha256, url: `/api/trips/${row.trip_code}/short-assets/${row.id}/file` } } : {}),
});
const trash = (client, key, readyAt = new Date()) => client.query(
  `INSERT INTO short_asset_trash(object_key,ready_at) VALUES($1,$2) ON CONFLICT(object_key)
   DO UPDATE SET version=short_asset_trash.version+1,ready_at=GREATEST(short_asset_trash.ready_at,EXCLUDED.ready_at),since=now()`, [key,readyAt]);

// 동의 철회와 같은 트랜잭션에서 접근을 막고 지울 키를 보존합니다. S3를 기다리지 않습니다.
export async function revokeShortAssets(client, code, generation) {
  await client.query(`WITH removed AS (
    UPDATE short_assets SET state='deleted',updated_at=now() WHERE trip_code=$1 AND generation<$2 AND state<>'deleted' RETURNING object_key,lease_until
  ) INSERT INTO short_asset_trash(object_key,ready_at) SELECT object_key,GREATEST(now(),lease_until) FROM removed
    ON CONFLICT(object_key) DO UPDATE SET version=short_asset_trash.version+1,ready_at=GREATEST(short_asset_trash.ready_at,EXCLUDED.ready_at),since=now()`, [code, generation]);
}

export function shortAssets(ctx, overrides = {}) {
  const db = overrides.db ?? tripsDb, media = () => overrides.media ?? shortMedia();
  const probe = overrides.probe ?? inspectVideo, ready = overrides.ready ?? mediaReady;
  let activeUploads = 0, sweeping = false;

  async function source(trip, client, momentId, composition) {
    if (typeof momentId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(momentId)) fail(400, "남길 장면을 골라 주세요");
    const data = composition ?? await ctx.composition(trip, client);
    const scene = data.scenes.find(s => s.momentId === momentId) ?? fail(409, "선택한 장면의 원음이 준비되지 않았어요");
    const recording = (await client.query("SELECT object_key,bytes FROM recordings WHERE trip_code=$1 AND moment_id=$2 AND generation=$3 AND deleted_at IS NULL", [trip.code, momentId, trip.generation ?? 1])).rows[0];
    if (!recording || scene.seconds < .5 || scene.seconds > 60) fail(409, "선택한 장면의 원음을 다시 확인해 주세요");
    const snapshot = { title: data.title, generation: data.generation, cast: data.cast, scenes: [scene] };
    return { momentId, generation: trip.generation ?? 1, sourceHash: fingerprint({ source: snapshot, key: recording.object_key, bytes: recording.bytes }), seconds: scene.seconds, source: snapshot };
  }

  async function valid(row, req, write = false) {
    return ctx.withTrip(row.trip_code, write, async (trip, client) => {
      const caller = req ? ctx.participantOf(req, trip) : trip.participants.find(p => p.id === row.participant_id);
      if (!caller) fail(403, "참가자가 여행에서 나갔어요");
      ensure(trip, caller);
      if ((trip.generation ?? 1) !== row.generation) fail(410, "녹음 동의가 바뀌었어요");
      const current = await source(trip, client, row.moment_id);
      if (current.sourceHash !== row.source_hash) fail(409, "보관한 뒤 원음·자막·화자가 바뀌었어요. 다시 만들어 주세요");
      return true;
    });
  }

  async function retire(row, state = "deleted") {
    await db().query(`WITH removed AS (
      UPDATE short_assets SET state=$3,updated_at=now() WHERE id=$1 AND attempt=$2 AND state<>'deleted' RETURNING object_key,lease_until
    ) INSERT INTO short_asset_trash(object_key,ready_at) SELECT object_key,GREATEST(now(),lease_until) FROM removed
      ON CONFLICT(object_key) DO UPDATE SET version=short_asset_trash.version+1,ready_at=GREATEST(short_asset_trash.ready_at,EXCLUDED.ready_at),since=now()`, [row.id, row.attempt, state]);
  }

  async function cleanup() {
    if (!ready()) return;
    const keys = (await db().query("SELECT object_key,version FROM short_asset_trash WHERE ready_at<=now() ORDER BY since LIMIT 20")).rows;
    for (const { object_key, version } of keys) {
      await media().remove(object_key);
      await db().query("DELETE FROM short_asset_trash WHERE object_key=$1 AND version=$2", [object_key,version]);
    }
  }

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const rows = (await db().query("SELECT * FROM short_assets WHERE state<>'deleted' AND next_check_at<=now() AND lease_until<now() ORDER BY next_check_at LIMIT 10")).rows;
      for (const row of rows) {
        try {
          if (row.state === "uploading") await retire(row, "failed");
          else if (row.state === "completed") await valid(row);
        } catch (e) {
          if ([403,404,409,410].includes(e.status)) await retire(row);
          else throw e;
        }
        await db().query("UPDATE short_assets SET next_check_at=now()+interval '1 minute' WHERE id=$1", [row.id]);
      }
      await cleanup();
    } catch { log("warn", "short_asset_cleanup_failed", {}); }
    finally { sweeping = false; }
  }

  async function upload(req, code, query) {
    const momentId = query.get("moment"), generation = Number(query.get("generation")), sourceHash = query.get("sourceHash"), key = query.get("key");
    const mimeType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!Number.isInteger(generation) || generation < 1 || !hash(sourceHash) || !/^[A-Za-z0-9_-]{8,100}$/.test(key ?? "")) fail(400, "장면·동의 세대·원본 해시·요청 키를 확인해 주세요");
    if (!["video/mp4", "video/webm"].includes(mimeType)) fail(400, "MP4·WebM 파일을 보내 주세요");
    const first = await ctx.withTrip(code, false, async (trip, client) => {
      ensure(trip, ctx.participantOf(req, trip)); parked(trip);
      if ((trip.generation ?? 1) !== generation) fail(409, "동의 세대가 바뀌었어요");
      const current = await source(trip, client, momentId);
      if (current.sourceHash !== sourceHash) fail(409, "원음·자막·화자를 다시 확인하고 내보내 주세요");
      return current;
    });
    if (!ready()) fail(503, "쇼츠 저장소가 준비되지 않았어요");
    if (activeUploads >= 2) fail(429, "다른 영상을 보관하고 있어요. 잠시 뒤 다시 시도해 주세요");
    if (Number(req.headers["content-length"] ?? 0) > ASSET_MAX_BYTES) fail(413, "영상은 64MB까지 보관할 수 있어요");
    activeUploads++;
    const controller = new AbortController();
    const closed = () => controller.abort();
    req.socket?.once("close", closed);
    const timeout = setTimeout(closed, 150_000);
    let row;
    try {
      const chunks = []; let bytes = 0;
      const read = (async () => {
        for await (const chunk of req) {
          if (controller.signal.aborted) fail(504, "영상 전송이 중단됐어요");
          bytes += chunk.length;
          if (bytes > ASSET_MAX_BYTES) fail(413, "영상은 64MB까지 보관할 수 있어요");
          chunks.push(chunk);
        }
      })();
      const abort = new Promise((_, reject) => controller.signal.addEventListener("abort", () => { reject({ status: 504, error: "영상 전송 시간이 지났어요" }); req.destroy?.(); }, { once: true }));
      await Promise.race([read, abort]);
      const data = Buffer.concat(chunks), sha256 = createHash("sha256").update(data).digest("hex");
      const metadata = { ...await probe(data, mimeType, first.seconds, { signal: controller.signal }), bytes };
      const requestHash = fingerprint({ momentId, generation, sourceHash, mimeType, sha256 });
      const reserved = await ctx.withTrip(code, true, async (trip, client) => {
        const caller = ctx.participantOf(req, trip); ensure(trip, caller); parked(trip);
        if ((trip.generation ?? 1) !== generation || (await source(trip, client, momentId)).sourceHash !== sourceHash) fail(409, "전송 중 원음·자막·동의 상태가 바뀌었어요");
        const old = (await client.query("SELECT * FROM short_assets WHERE trip_code=$1 AND participant_id=$2 AND idempotency_key=$3", [trip.code, caller.id, key])).rows[0];
        if (old) {
          if (old.request_hash !== requestHash) fail(409, "같은 요청 키로 다른 영상을 보낼 수 없어요");
          if (old.state === "deleted") fail(410, "이미 삭제한 영상이에요");
          if (old.state === "completed") return { row: old, existed: true };
          if (old.state === "uploading" && new Date(old.lease_until).getTime() > Date.now()) fail(409, "같은 영상을 이미 보관하고 있어요. 목록을 다시 확인해 주세요");
          await trash(client, old.object_key, old.lease_until);
        } else {
          const count = (await client.query("SELECT count(*)::int AS n FROM short_assets WHERE trip_code=$1 AND state<>'deleted'", [trip.code])).rows[0].n;
          if (count >= 100) fail(409, "한 여행에는 기본 영상을 100개까지 보관할 수 있어요");
        }
        const id = old?.id ?? randomUUID(), attempt = randomUUID(), objectKey = `short-assets/${trip.code}/${id}/${attempt}.${mimeType === "video/mp4" ? "mp4" : "webm"}`;
        const saved = await client.query(`INSERT INTO short_assets(id,trip_code,participant_id,generation,moment_id,source_hash,idempotency_key,request_hash,sha256,media,object_key,state,attempt,lease_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'uploading',$12,now()+interval '3 minutes')
          ON CONFLICT(trip_code,participant_id,idempotency_key) DO UPDATE SET object_key=EXCLUDED.object_key,state='uploading',attempt=EXCLUDED.attempt,lease_until=EXCLUDED.lease_until,next_check_at=now(),updated_at=now()
          RETURNING *`, [id,trip.code,caller.id,generation,momentId,sourceHash,key,requestHash,sha256,metadata,objectKey,attempt]);
        return { row: saved.rows[0], existed: false };
      });
      if (reserved.existed) return [200, view(reserved.row)];
      row = reserved.row;
      if (controller.signal.aborted) fail(504, "영상 전송이 중단됐어요");
      await media().put(row.object_key, data, mimeType);
      const result = await ctx.withTrip(code, true, async (trip, client) => {
        ensure(trip, ctx.participantOf(req, trip)); parked(trip);
        if (controller.signal.aborted) fail(504, "영상 전송이 중단됐어요");
        if ((trip.generation ?? 1) !== generation || (await source(trip, client, momentId)).sourceHash !== sourceHash) fail(409, "저장 중 원음·자막·동의 상태가 바뀌었어요");
        const updated = await client.query("UPDATE short_assets SET state='completed',lease_until=now(),updated_at=now() WHERE id=$1 AND attempt=$2 AND state='uploading' RETURNING *", [row.id,row.attempt]);
        if (!updated.rows[0]) fail(409, "이 영상의 저장이 취소됐어요");
        return updated.rows[0];
      });
      return [201, view(result)];
    } catch (e) {
      if (row) {
        // 매 시도마다 다른 키라 재시도의 파일을 지우지 않습니다. 철회 뒤 늦게 PUT된 키도 다시 정리합니다.
        await trash(db(), row.object_key, row.lease_until).catch(() => {});
        await retire(row, "failed").catch(() => {});
        void sweep();
      }
      if (e?.status) throw e;
      fail(503, "영상을 서버에 보관하지 못했어요. 같은 요청으로 다시 시도해 주세요");
    } finally {
      clearTimeout(timeout); req.socket?.removeListener("close", closed); activeUploads--;
    }
  }

  async function request(req, code, id, leaf, query) {
    if (leaf && leaf !== "file") fail(404, "없는 영상 경로");
    if (id === "source" && !leaf) {
      if (req.method !== "GET") fail(405, "GET만 가능해요");
      return ctx.withTrip(code, false, async (trip, client) => {
        ensure(trip, ctx.participantOf(req, trip));
        return [200, await source(trip, client, query.get("moment"))];
      });
    }
    if (id && !uuid(id)) fail(404, "없는 영상");
    const methods = !id ? ["GET","POST"] : leaf ? ["GET"] : ["GET","DELETE"];
    if (!methods.includes(req.method)) fail(405, "지원하지 않는 요청 방식이에요");
    if (req.method === "POST") return upload(req, code, query);
    const response = await ctx.withTrip(code, req.method === "DELETE", async (trip, client) => {
      const caller = ctx.participantOf(req, trip);
      if (req.method !== "DELETE") ensure(trip, caller);
      if (!id) {
        const generation = trip.generation ?? 1;
        const rows = (await client.query("SELECT * FROM short_assets WHERE trip_code=$1 AND generation=$2 AND state<>'deleted' ORDER BY created_at DESC", [trip.code,generation])).rows;
        const current = await ctx.composition(trip, client), cache = new Map();
        for (const row of rows) if (!cache.has(row.moment_id)) {
          try { cache.set(row.moment_id, (await source(trip, client, row.moment_id, current)).sourceHash); }
          catch (e) { if (![404,409].includes(e.status)) throw e; cache.set(row.moment_id, null); }
        }
        const local = rows.map(row => view(row, cache.get(row.moment_id) === row.source_hash ? row.state : "source_changed"));
        const provider = (await client.query("SELECT * FROM short_generations WHERE trip_code=$1 AND generation=$2 ORDER BY created_at DESC", [trip.code,generation])).rows.map(row => ({ ...generationView(row), origin: "provider" }));
        return [200, { generation, items: [...local,...provider].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt) || a.id.localeCompare(b.id)) }];
      }
      const row = (await client.query("SELECT * FROM short_assets WHERE trip_code=$1 AND id=$2", [trip.code,id])).rows[0] ?? fail(404, "없는 영상");
      if (req.method === "DELETE") {
        if (row.participant_id !== caller.id) fail(403, "보관한 사람만 삭제할 수 있어요");
        await client.query("UPDATE short_assets SET state='deleted',updated_at=now() WHERE id=$1", [row.id]);
        await trash(client, row.object_key, row.lease_until);
        return [204];
      }
      if (row.state === "deleted" || row.generation !== (trip.generation ?? 1)) fail(410, "삭제됐거나 녹음 동의가 바뀐 영상이에요");
      if ((await source(trip, client, row.moment_id)).sourceHash !== row.source_hash) fail(409, "원음·자막·화자가 바뀌었어요. 다시 만들어 주세요");
      if (!leaf) return [200, view(row)];
      if (row.state !== "completed") fail(409, "아직 서버 보관을 마치지 못했어요");
      return { row };
    });
    if (req.method === "DELETE") { void sweep(); return response; }
    if (!response.row) return response;
    const row = response.row;
    let data;
    try { data = await media().get(row.object_key); }
    catch { fail(503, "영상 저장소에 닿지 못했어요"); }
    await valid(row, req);
    const current = (await db().query("SELECT state,object_key FROM short_assets WHERE id=$1", [row.id])).rows[0];
    if (current?.state !== "completed" || current.object_key !== row.object_key) fail(410, "영상이 삭제됐어요");
    if (!data || createHash("sha256").update(data).digest("hex") !== row.sha256) fail(503, "보관한 영상 파일을 확인하지 못했어요");
    return [200,data,row.media.mimeType];
  }

  return { request, sweep, valid, start: () => { setInterval(sweep, 30_000).unref(); void sweep(); } };
}
