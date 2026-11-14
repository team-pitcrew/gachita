import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tripsDb } from "./db.js";
import {
  planShort,
  templates,
  fingerprint,
  shotPrompt,
} from "./short-templates.js";
import { higgsfield, higgsfieldReady } from "./providers/higgsfield.js";
import {
  shortMedia,
  mediaReady,
  downloadVideo,
} from "./providers/short-media.js";
import { clipStore } from "./providers/clips.js";
import { renderShort, audioSlice } from "./short-render.js";
import { log } from "./log.js";
const fail = (status, error) => {
  throw { status, error };
};
const enabled = () =>
  process.env.SHORTS_ENABLED === "true" && higgsfieldReady() && mediaReady();
const terminal = new Set([
  "completed",
  "failed",
  "canceled",
  "submission_unknown",
]);
const view = (r) => ({
  id: r.id,
  state: r.state,
  templateId: r.plan.templateId,
  templateVersion: r.plan.templateVersion,
  momentId: r.moment_id,
  generation: r.generation,
  progress: {
    completedShots: r.shots.filter((s) => s.state === "completed").length,
    totalShots: r.plan.shots?.length ?? 0,
  },
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  ...(r.error_code ? { errorCode: r.error_code } : {}),
  ...(r.state === "completed"
    ? {
        result: {
          url: `/api/trips/${r.trip_code}/short-generations/${r.id}/file`,
          mimeType: "video/mp4",
          bytes: r.bytes,
          seconds: r.plan.seconds,
          width: 720,
          height: 1280,
        },
      }
    : {}),
});
export const shortTemplateCatalog = () => ({
  enabled: enabled(),
  provider: "higgsfield",
  templates: templates.map(({ direction, ...t }) => t),
});

export function shortGenerations(ctx, overrides = {}) {
  const db = overrides.db ?? tripsDb;
  const media = () => overrides.media ?? shortMedia();
  const provider = () => overrides.provider ?? higgsfield();
  const ready = overrides.ready ?? enabled;
  const compose = overrides.render ?? renderShort;
  const download = overrides.download ?? downloadVideo;
  const sourceAudio = async (key) =>
    overrides.audio ? overrides.audio(key) : clipStore()?.get(key);
  const ensureTrip = (trip, caller) => {
    if (
      !caller.consent ||
      !trip.participants.length ||
      !trip.participants.every((p) => p.consent)
    )
      fail(403, "모든 동승자의 녹음 동의가 필요해요");
  };
  async function plan(trip, client, body) {
    const source = await ctx.composition(trip, client);
    const p = planShort(source, body);
    const { rows } = await client.query(
      "SELECT object_key FROM recordings WHERE trip_code=$1 AND moment_id=$2 AND generation=$3 AND deleted_at IS NULL",
      [trip.code, p.momentId, trip.generation ?? 1],
    );
    if (!rows[0]) fail(409, "장면 원음이 준비되지 않았어요");
    p.planHash = fingerprint({ plan: p, sourceKey: rows[0].object_key });
    return { plan: p, sourceKey: rows[0].object_key };
  }
  async function valid(row) {
    if (new Date(row.expires_at).getTime() <= Date.now())
      fail(410, "보관 기간이 지났어요");
    return ctx.withTrip(row.trip_code, false, async (trip, client) => {
      const caller =
        trip.participants.find((p) => p.id === row.participant_id) ??
        fail(403, "참가자가 나갔어요");
      ensureTrip(trip, caller);
      if ((trip.generation ?? 1) !== row.generation)
        fail(410, "동의 세대가 바뀌었어요");
      const current = await plan(trip, client, row.plan);
      if (
        current.plan.planHash !== row.plan.planHash ||
        current.sourceKey !== row.source_key
      )
        fail(409, "원음·자막·캐릭터가 바뀌었어요");
      return true;
    });
  }
  async function request(req, code, sub, id, leaf, body) {
    if (leaf && !id) fail(404, "없는 생성 경로");
    if (sub === "short-plans") {
      if (req.method !== "POST" || id) fail(405, "POST만 가능해요");
      return ctx.withTrip(code, false, async (trip, client) => {
        ensureTrip(trip, ctx.participantOf(req, trip));
        return [200, (await plan(trip, client, body)).plan];
      });
    }
    if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) fail(404, "없는 생성 작업");
    if (leaf && leaf !== "file") fail(404, "없는 생성 경로");
    let response = await ctx.withTrip(
      code,
      req.method !== "GET",
      async (trip, client) => {
        const caller = ctx.participantOf(req, trip);
        ensureTrip(trip, caller);
        if (req.method === "POST" && !id) {
          if (!ready()) fail(503, "영상 생성 서버가 아직 준비되지 않았어요");
          if (trip.status === "driving")
            fail(409, "주차한 뒤 영상을 만들 수 있어요");
          if (body.externalGenerationConsent !== true)
            fail(400, "외부 영상 생성에 사용할 자료를 확인해 주세요");
          if (body.generation !== (trip.generation ?? 1))
            fail(409, "동의 세대가 바뀌었어요");
          const key = body.idempotencyKey;
          if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
            fail(400, "idempotencyKey: 8~100자 영문·숫자·_·-");
          const requestHash = fingerprint({
            momentId: body.momentId ?? null,
            templateId: body.templateId ?? null,
            audioReference: body.audioReference === true,
            planHash: body.planHash,
            generation: body.generation,
          });
          const old = await client.query(
            "SELECT * FROM short_generations WHERE trip_code=$1 AND participant_id=$2 AND idempotency_key=$3",
            [trip.code, caller.id, key],
          );
          if (old.rows[0]) {
            if (old.rows[0].request_hash !== requestHash)
              fail(409, "같은 요청 키의 내용이 달라요");
            return [200, view(old.rows[0])];
          }
          const prepared = await plan(trip, client, body);
          if (body.planHash !== prepared.plan.planHash)
            fail(409, "제작 계획을 다시 확인해 주세요");
          await client.query("SELECT pg_advisory_xact_lock(74630)");
          const {
            rows: [usage],
          } = await client.query(
            "SELECT COALESCE(sum((plan->>'estimatedGenerationSeconds')::int),0)::int AS seconds FROM short_generations WHERE created_at>=date_trunc('day',now())",
          );
          const daily = Number(process.env.SHORTS_DAILY_SECONDS ?? 120);
          if (
            !Number.isFinite(daily) ||
            daily <= 0 ||
            usage.seconds + prepared.plan.estimatedGenerationSeconds > daily
          )
            fail(429, "오늘의 영상 생성 한도를 모두 사용했어요");
          const active = await client.query(
            "SELECT count(*)::int AS n FROM short_generations WHERE trip_code=$1 AND state NOT IN ('completed','failed','canceled','submission_unknown')",
            [trip.code],
          );
          if (active.rows[0].n >= 2)
            fail(429, "이 여행의 영상 두 개를 만들고 있어요");
          const row = await client.query(
            `INSERT INTO short_generations(id,trip_code,participant_id,generation,moment_id,idempotency_key,request_hash,plan,source_key,shots,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [
              randomUUID(),
              trip.code,
              caller.id,
              body.generation,
              prepared.plan.momentId,
              key,
              requestHash,
              prepared.plan,
              prepared.sourceKey,
              JSON.stringify(
                prepared.plan.shots.map(() => ({ state: "pending" })),
              ),
              new Date(trip.createdAt + 48 * 3600_000),
            ],
          );
          return [202, view(row.rows[0])];
        }
        if (!id) {
          if (req.method !== "GET") fail(405, "GET 또는 POST만 가능해요");
          const r = await client.query(
            "SELECT * FROM short_generations WHERE trip_code=$1 AND generation=$2 ORDER BY created_at DESC LIMIT 50",
            [trip.code, trip.generation ?? 1],
          );
          return [200, { items: r.rows.map(view) }];
        }
        const r = await client.query(
          "SELECT * FROM short_generations WHERE trip_code=$1 AND id=$2",
          [trip.code, id],
        );
        const row = r.rows[0] ?? fail(404, "없는 생성 작업");
        if (
          row.generation !== (trip.generation ?? 1) ||
          new Date(row.expires_at).getTime() <= Date.now()
        )
          fail(410, "이 생성 작업의 보관 기간이나 동의가 끝났어요");
        if (req.method === "DELETE" && !leaf) {
          if (row.participant_id !== caller.id)
            fail(403, "만든 사람만 취소할 수 있어요");
          await client.query(
            "UPDATE short_generations SET state='canceled',cleanup_pending=true,result_key=NULL,updated_at=now() WHERE id=$1",
            [id],
          );
          return [200, { id, state: "canceled" }];
        }
        if (req.method !== "GET") fail(405, "GET 또는 DELETE만 가능해요");
        if (!terminal.has(row.state) || row.state === "completed") {
          const current = await plan(trip, client, row.plan);
          if (current.plan.planHash !== row.plan.planHash)
            fail(409, "제작 후 원음·자막·캐릭터가 바뀌었어요");
        }
        if (!leaf) return [200, view(row)];
        if (row.state !== "completed" || !row.result_key)
          fail(409, "아직 완성된 영상이 없어요");
        return { row };
      },
    );
    if (!response.row) return response;
    const row = response.row;
    const data = await media().get(row.result_key);
    // A slow download must not outlive a revocation or explicit deletion.
    await valid(row);
    const now = await db().query(
      "SELECT state,result_key FROM short_generations WHERE id=$1",
      [row.id],
    );
    if (
      now.rows[0]?.state !== "completed" ||
      now.rows[0]?.result_key !== row.result_key
    )
      fail(410, "영상이 삭제됐어요");
    return [200, data, "video/mp4"];
  }
  async function update(row, changes) {
    Object.assign(row, changes);
    const r = await db().query(
      `UPDATE short_generations SET state=$2,shots=$3,object_keys=$4,result_key=$5,bytes=$6,error_code=$7,cleanup_pending=$8,next_attempt_at=now()+interval '8 seconds',updated_at=now() WHERE id=$1 AND state<>'canceled' RETURNING *`,
      [
        row.id,
        row.state,
        JSON.stringify(row.shots),
        JSON.stringify(row.object_keys),
        row.result_key,
        row.bytes,
        row.error_code,
        row.cleanup_pending,
      ],
    );
    if (!r.rowCount) throw Error("job_canceled");
    return r.rows[0];
  }
  async function put(row, key, body, type) {
    if (!row.object_keys.includes(key)) {
      row.object_keys.push(key);
      await update(row, {});
    }
    await media().put(key, body, type);
    return key;
  }
  async function cleanup(row) {
    for (const key of row.object_keys) await media().remove(key);
    let pending = false;
    for (const shot of row.shots) {
      if (!shot.request || shot.providerDeleted) continue;
      try {
        const status = await provider().status(shot.request);
        if (status.status === "queued") {
          await provider().cancel(shot.request);
          pending = true;
        } else if (status.status === "in_progress") pending = true;
        else {
          await provider().remove(shot.request);
          shot.providerDeleted = true;
        }
      } catch (e) {
        if (e.code === "provider_http_404") shot.providerDeleted = true;
        else pending = true;
      }
    }
    await db().query(
      "UPDATE short_generations SET cleanup_pending=$2,shots=$3,object_keys='[]',source_key='',plan=jsonb_build_object('templateId',plan->'templateId','templateVersion',plan->'templateVersion','estimatedGenerationSeconds',plan->'estimatedGenerationSeconds'),result_key=NULL,next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
      [row.id, pending, JSON.stringify(row.shots)],
    );
  }
  async function runJob(row) {
    if (row.cleanup_pending) return cleanup(row);
    try {
      await valid(row);
    } catch (e) {
      if ([403, 404, 409, 410].includes(e.status)) {
        await db().query(
          "UPDATE short_generations SET state='canceled',cleanup_pending=true,error_code='source_changed' WHERE id=$1",
          [row.id],
        );
        return;
      }
      throw e;
    }
    if (terminal.has(row.state)) {
      await db().query(
        "UPDATE short_generations SET next_attempt_at=now()+interval '60 seconds' WHERE id=$1",
        [row.id],
      );
      return;
    }
    // No request id after a previous worker died: don't send another paid request.
    if (row.state === "submitting") {
      await update(row, {
        state: "submission_unknown",
        error_code: "submission_unconfirmed",
      });
      return;
    }
    const index = row.shots.findIndex((s) => s.state !== "completed");
    if (index >= 0) {
      const shot = row.shots[index],
        spec = row.plan.shots[index];
      if (shot.state === "pending") {
        const refs = [];
        for (let i = 0; i < 2; i++) {
          const key = `shorts/${row.id}/reference-${i}.png`;
          await put(
            row,
            key,
            await readFile(
              new URL(
                `../../frontend/web/chars/${row.plan.cast[i].character}.png`,
                import.meta.url,
              ),
            ),
            "image/png",
          );
          refs.push(await media().sign(key));
        }
        const input = {
          prompt: shotPrompt(row.plan, spec),
          image_urls: refs,
          duration: spec.generationSeconds,
          resolution: row.plan.resolution,
          aspect_ratio: "9:16",
          output_format: "mp4",
          generate_audio: row.plan.audioReference,
        };
        if (row.plan.audioReference) {
          const wav = await sourceAudio(row.source_key);
          if (!wav) throw Error("source_audio_missing");
          const key = `shorts/${row.id}/voice-${index}.wav`;
          await put(row, key, await audioSlice(wav, spec), "audio/wav");
          input.audio_urls = [await media().sign(key)];
        }
        await valid(row);
        await update(row, { state: "submitting" });
        let request;
        try {
          request = await provider().submit(row.plan.model, input);
        } catch (e) {
          await update(row, {
            state: e.uncertain ? "submission_unknown" : "failed",
            error_code: e.uncertain
              ? "submission_unconfirmed"
              : (e.code ?? "provider_rejected"),
          });
          return;
        }
        shot.request = request;
        shot.state = "generating";
        // Persist the provider id even if cancellation raced with submission, so cleanup can find it.
        await db().query(
          "UPDATE short_generations SET shots=$2,state=CASE WHEN state='canceled' THEN state ELSE 'generating' END,updated_at=now(),next_attempt_at=now()+interval '8 seconds' WHERE id=$1",
          [row.id, JSON.stringify(row.shots)],
        );
        return;
      }
      const status = await provider().status(shot.request);
      if (["failed", "nsfw", "canceled"].includes(status.status)) {
        await update(row, {
          state: "failed",
          error_code: `provider_${status.status}`,
        });
        return;
      }
      if (status.status !== "completed") {
        await update(row, { state: "generating" });
        return;
      }
      const video = await download(status.videoUrl);
      await valid(row);
      shot.key = await put(
        row,
        `shorts/${row.id}/shot-${index}.mp4`,
        video,
        "video/mp4",
      );
      shot.state = "completed";
      await update(row, { state: "generating" });
      return;
    }
    await update(row, { state: "composing" });
    const wav = await sourceAudio(row.source_key);
    if (!wav) throw Error("source_audio_missing");
    const videos = await Promise.all(row.shots.map((s) => media().get(s.key)));
    const controller = new AbortController();
    const timer = setInterval(() => {
      db()
        .query("SELECT state FROM short_generations WHERE id=$1", [row.id])
        .then((r) => {
          if (r.rows[0]?.state === "canceled") controller.abort();
        })
        .catch(() => controller.abort());
    }, 1000);
    timer.unref();
    let output;
    try {
      output = await compose(row.plan, videos, wav, {
        signal: controller.signal,
      });
    } finally {
      clearInterval(timer);
    }
    await valid(row);
    const key = await put(
      row,
      `shorts/${row.id}/final.mp4`,
      output,
      "video/mp4",
    );
    await valid(row);
    await update(row, {
      state: "completed",
      result_key: key,
      bytes: output.length,
    });
  }
  async function tick() {
    if (!ready() && !mediaReady()) return;
    const client = await db().connect();
    let locked = false;
    try {
      locked = (
        await client.query("SELECT pg_try_advisory_lock(74629) AS held")
      ).rows[0].held;
      if (!locked) return;
      await client.query(
        "DELETE FROM short_generations WHERE state='canceled' AND NOT cleanup_pending AND expires_at<now()-interval '1 day'",
      );
      const r = await client.query(
        "SELECT * FROM short_generations WHERE ($1 OR cleanup_pending OR expires_at<=now()) AND next_attempt_at<=now() AND (state<>'canceled' OR cleanup_pending) ORDER BY cleanup_pending DESC,(state NOT IN ('completed','failed','submission_unknown')) DESC,next_attempt_at LIMIT 1",
        [ready()],
      );
      if (!r.rows[0]) return;
      const row = r.rows[0];
      try {
        await runJob(row);
      } catch (e) {
        if (e.message === "job_canceled" || e.name === "AbortError") return;
        const transient =
          e.code?.startsWith("provider_http_5") ||
          e.code === "provider_http_429" ||
          e.code === "provider_connection";
        if (transient) {
          await db().query(
            "UPDATE short_generations SET next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
            [row.id],
          );
          return;
        }
        if (row.cleanup_pending) {
          await db().query(
            "UPDATE short_generations SET next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
            [row.id],
          );
          return;
        }
        await db().query(
          "UPDATE short_generations SET state='failed',error_code='generation_failed',next_attempt_at=now()+interval '60 seconds' WHERE id=$1 AND state<>'canceled'",
          [row.id],
        );
        log("warn", "short_generation_failed", { stage: row.state });
      }
    } finally {
      if (locked)
        await client.query("SELECT pg_advisory_unlock(74629)").catch(() => {});
      client.release();
    }
  }
  function start() {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      tick()
        .catch(() => log("warn", "short_worker_unavailable", {}))
        .finally(() => {
          running = false;
        });
    }, 2000);
    timer.unref();
    return () => clearInterval(timer);
  }
  return { request, tick, start, valid };
}
