// 쇼츠 서버 생성(T157, ADR-0025). API는 작업을 받아 큐(short_generations)에 두기만 하고, 만들기는 밖의 생성 일꾼(운영자 맥,
// backend/api/shorts-worker)이 한다. 일꾼은 밖으로만 연결해 /api/short-worker/*로 작업을 임대받고 결과 MP4를 올린다.
// 앱 계약(short-plans, short-generations, …/file, 콘텐츠 기록)은 T85 그대로다.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { tripsDb } from "./db.js";
import { planShort, templates, fingerprint } from "./short-templates.js";
import { shortMedia, mediaReady } from "./providers/short-media.js";
import { ASSET_MAX_BYTES, inspectVideo } from "./providers/short-asset-probe.js";
import { clipStore } from "./providers/clips.js";
import { log } from "./log.js";
const fail = (status, error) => {
  throw { status, error };
};
// ponytail: 임대 60분 고정. Codex xhigh 한 편이 이보다 길어지면 심장박동(연장) 경로를 더한다.
const LEASE = "60 minutes";
const workerToken = () => process.env.SHORTS_WORKER_TOKEN ?? "";
const enabled = () =>
  process.env.SHORTS_ENABLED === "true" &&
  workerToken().length >= 32 &&
  mediaReady();
const terminal = new Set([
  "completed",
  "failed",
  "canceled",
  "submission_unknown",
]);
const uuid = (id) =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export const generationView = (r) => ({
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
const view = generationView;
export const shortTemplateCatalog = () => ({
  enabled: enabled(),
  provider: "openai-codex",
  templates: templates.map(({ direction, ...t }) => t),
});

export function shortGenerations(ctx, overrides = {}) {
  const db = overrides.db ?? tripsDb;
  const media = () => overrides.media ?? shortMedia();
  const ready = overrides.ready ?? enabled;
  const probe = overrides.probe ?? inspectVideo;
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
    if (row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now())
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
  const cancel = (id, code = "source_changed") =>
    db().query(
      "UPDATE short_generations SET state='canceled',cleanup_pending=true,error_code=$2,updated_at=now() WHERE id=$1",
      [id, code],
    );
  async function request(req, code, sub, id, leaf, body) {
    if (leaf && !id) fail(404, "없는 생성 경로");
    if (sub === "short-plans") {
      if (req.method !== "POST" || id) fail(405, "POST만 가능해요");
      return ctx.withTrip(code, false, async (trip, client) => {
        ensureTrip(trip, ctx.participantOf(req, trip));
        return [200, (await plan(trip, client, body)).plan];
      });
    }
    if (id && !uuid(id)) fail(404, "없는 생성 작업");
    if (leaf && leaf !== "file") fail(404, "없는 생성 경로");
    const methods = !id ? ["GET", "POST"] : leaf ? ["GET"] : ["GET", "DELETE"];
    if (!methods.includes(req.method)) fail(405, "지원하지 않는 요청 방식이에요");
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
          const {
            rows: [made],
          } = await client.query(
            "SELECT count(*)::int AS n, count(*) FILTER (WHERE state NOT IN ('completed','failed','canceled','submission_unknown'))::int AS active FROM short_generations WHERE trip_code=$1 AND generation=$2",
            [trip.code, trip.generation ?? 1],
          );
          if (made.n >= Number(process.env.SHORTS_TRIP_JOBS ?? 3))
            fail(429, "이 여행에서 만들 수 있는 영상 수를 모두 썼어요");
          if (made.active >= 2)
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
              null,
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
          (row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now())
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

  // ---- 생성 일꾼 계약(docs/api/short-generation.md). 사람 토큰이 아니라 일꾼 토큰 하나로만 들어온다. ----
  function authorize(req) {
    const want = Buffer.from(workerToken());
    const got = Buffer.from(
      String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
    if (
      want.length < 32 ||
      got.length !== want.length ||
      !timingSafeEqual(want, got)
    )
      fail(401, "생성 일꾼 토큰이 필요해요");
  }
  async function leased(id) {
    if (!uuid(id)) fail(404, "없는 생성 작업");
    const row =
      (await db().query("SELECT * FROM short_generations WHERE id=$1", [id]))
        .rows[0] ?? fail(404, "없는 생성 작업");
    if (row.state !== "generating" || row.cleanup_pending)
      fail(410, "이 작업은 취소됐거나 임대가 끝났어요");
    return row;
  }
  async function readVideo(req) {
    if (String(req.headers["content-type"] ?? "").split(";")[0].trim() !== "video/mp4")
      fail(400, "video/mp4 파일을 보내 주세요");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > ASSET_MAX_BYTES) fail(413, "영상은 64MB까지 받아요");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function worker(req, seg, body) {
    // 경로·방식을 먼저 가리고(404·405) 그다음 토큰을 본다.
    const claim = seg[0] === "claim" && seg.length === 1;
    const leaf = seg[0] === "jobs" && seg.length === 3 ? seg[2] : null;
    const method = claim ? "POST" : new Map([["audio", "GET"], ["fail", "POST"], ["result", "PUT"]]).get(leaf);
    if (!method) fail(404, "없는 일꾼 경로");
    if (req.method !== method) fail(405, `${method}만 가능해요`);
    authorize(req);
    if (claim) {
      if (!ready()) return [204];
      const row = (
        await db().query(
          `UPDATE short_generations SET state='generating',next_attempt_at=now()+interval '${LEASE}',updated_at=now()
           WHERE id=(SELECT id FROM short_generations WHERE state='queued' AND NOT cleanup_pending ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING *`,
        )
      ).rows[0];
      if (!row) return [204];
      try {
        await valid(row);
      } catch (e) {
        if (![403, 404, 409, 410].includes(e.status)) throw e;
        await cancel(row.id);
        return [204];
      }
      const t = templates.find((x) => x.id === row.plan.templateId);
      log("info", "short_job_claimed", { id: row.id });
      return [
        200,
        {
          id: row.id,
          leaseUntil: row.next_attempt_at,
          template: { id: t.id, name: t.name, direction: t.direction },
          plan: row.plan,
          audio: `/api/short-worker/jobs/${row.id}/audio`,
          result: `/api/short-worker/jobs/${row.id}/result`,
        },
      ];
    }
    const row = await leased(seg[1]);
    if (leaf === "audio") {
      const wav = await sourceAudio(row.source_key);
      if (!wav) fail(410, "장면 원음이 없어요");
      return [200, wav, "audio/wav"];
    }
    if (leaf === "fail") {
      const code = /^[a-z0-9_]{1,40}$/.test(body?.errorCode ?? "")
        ? body.errorCode
        : "worker_failed";
      await db().query(
        "UPDATE short_generations SET state='failed',error_code=$2,next_attempt_at=now()+interval '60 seconds',updated_at=now() WHERE id=$1 AND state='generating'",
        [row.id, `worker_${code}`.slice(0, 48)],
      );
      log("warn", "short_job_failed", { id: row.id, code });
      return [200, { id: row.id, state: "failed" }];
    }
    const data = await readVideo(req);
    // 실제 파일을 본다: 9:16, 영상·소리 하나씩, 길이가 장면과 1초 안(short-assets와 같은 검사).
    const measured = await probe(data, "video/mp4", row.plan.seconds);
    // 만드는 사이 동의 철회·자막 수정이 있었으면 결과를 받지 않고 작업을 취소한다.
    const still = () =>
      valid(row).catch(async (e) => {
        if ([403, 404, 409, 410].includes(e.status)) await cancel(row.id);
        throw e;
      });
    await still();
    const key = `shorts/${row.id}/final.mp4`;
    // 키를 먼저 적어 둔다. 올리는 사이 취소돼도 정리 작업이 이 키를 지운다.
    await db().query(
      "UPDATE short_generations SET object_keys=object_keys || to_jsonb($2::text) WHERE id=$1 AND NOT object_keys ? $2",
      [row.id, key],
    );
    await media().put(key, data, "video/mp4");
    await still();
    const done = await db().query(
      `UPDATE short_generations SET state='completed',result_key=$2,bytes=$3,shots=$4,next_attempt_at=now()+interval '60 seconds',updated_at=now()
       WHERE id=$1 AND state='generating' AND NOT cleanup_pending RETURNING *`,
      [
        row.id,
        key,
        data.length,
        JSON.stringify(row.shots.map((s) => ({ ...s, state: "completed" }))),
      ],
    );
    if (!done.rows[0]) fail(410, "올리는 사이 작업이 취소됐어요");
    log("info", "short_job_completed", {
      id: row.id,
      bytes: data.length,
      seconds: measured.seconds,
    });
    return [200, view(done.rows[0])];
  }

  async function cleanup(row) {
    for (const key of row.object_keys) await media().remove(key);
    await db().query(
      "UPDATE short_generations SET cleanup_pending=false,object_keys='[]',source_key='',plan=jsonb_build_object('templateId',plan->'templateId','templateVersion',plan->'templateVersion','estimatedGenerationSeconds',plan->'estimatedGenerationSeconds'),result_key=NULL,next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
      [row.id],
    );
  }
  // 서버 안에서 도는 것은 지키기뿐이다: 동의 철회·원본 변경을 다시 보고, 끝난 임대를 실패로 돌리고, 취소된 결과를 지운다.
  async function runJob(row) {
    if (row.cleanup_pending) return cleanup(row);
    try {
      await valid(row);
    } catch (e) {
      if ([403, 404, 409, 410].includes(e.status)) return cancel(row.id);
      throw e;
    }
    if (row.state === "generating") {
      // 고른 행의 next_attempt_at이 지났다 = 일꾼이 임대 안에 결과도 실패도 알리지 않았다. 다시 주지 않는다.
      await db().query(
        "UPDATE short_generations SET state='failed',error_code='worker_timeout',updated_at=now(),next_attempt_at=now()+interval '60 seconds' WHERE id=$1 AND state='generating'",
        [row.id],
      );
      return;
    }
    await db().query(
      "UPDATE short_generations SET next_attempt_at=now()+interval '60 seconds' WHERE id=$1",
      [row.id],
    );
  }
  async function tick() {
    if (!mediaReady() && !overrides.media) return;
    const client = await db().connect();
    let locked = false;
    try {
      locked = (
        await client.query("SELECT pg_try_advisory_lock(74629) AS held")
      ).rows[0].held;
      if (!locked) return;
      // 취소 행도 멱등 키를 보존합니다. 무기한 여행의 늦은 재전송이 작업을 다시 만들지 않게 합니다.
      const r = await client.query(
        "SELECT * FROM short_generations WHERE next_attempt_at<=now() AND (state<>'canceled' OR cleanup_pending) ORDER BY cleanup_pending DESC,next_attempt_at LIMIT 1",
      );
      if (!r.rows[0]) return;
      const row = r.rows[0];
      try {
        await runJob(row);
      } catch {
        await db().query(
          "UPDATE short_generations SET next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
          [row.id],
        );
        log("warn", "short_generation_check_failed", { stage: row.state });
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
  return { request, worker, tick, start, valid };
}
