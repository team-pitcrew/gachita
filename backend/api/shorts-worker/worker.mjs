// 가치타 쇼츠 생성 일꾼(T157, ADR-0025). 운영자 맥에서 돈다.
// API(/api/short-worker)에 밖으로만 연결해 작업을 임대받고, Codex(ChatGPT 구독 로그인, gpt-6-astra, 추론 xhigh)가
// youtube-shorts-factory 스킬(skill/, 고정 커밋)로 레퍼런스 분석 → 각색 → 스토리보드 → 장면 그림을 만들면,
// 켄 번스 + 원래 목소리 + 자막(../short-render.js)으로 9:16 MP4를 합쳐 올린다.
// 구독 인증(~/.codex)은 이 맥 밖으로 나가지 않는다. 원음은 OpenAI로 보내지 않는다(이 맥에서 합치기만).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderShort } from "../short-render.js";

const exec = promisify(execFile);
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ff = process.env.FFMPEG_PATH || "ffmpeg";
export const REFERENCE = "https://www.youtube.com/shorts/KnC14OCrYro";
const CACHE = join(homedir(), ".gachita-shorts", "reference-analysis.md");
export const MOTIONS = ["slow_push_in", "slow_pull_out", "pan_left", "pan_right"];
const stage = (code) => (e) => {
  throw Object.assign(e instanceof Error ? e : Error(String(e)), { code });
};

// Codex에 주는 재료. 참가자 이름·id는 빼고 캐릭터 번호로 바꾼다(대화 속에 나온 출연자 이름도).
export function material({ plan, template }) {
  const scrub = (text) =>
    plan.cast.reduce(
      (t, c) => (c.participantId && c.name ? t.replaceAll(c.name, `캐릭터${c.slot + 1}`) : t),
      String(text ?? ""),
    );
  return {
    template: { name: template.name, direction: template.direction },
    title: scrub(plan.title),
    seconds: plan.seconds,
    cast: plan.cast.map((c) => ({
      character: `캐릭터${c.slot + 1}`,
      image: `cast-${c.slot + 1}.png`,
      asset: c.character,
    })),
    cues: plan.cues.map((c) => ({
      start: c.start,
      end: c.end,
      speaker: c.slot === null ? "화면 밖 목소리" : `캐릭터${c.slot + 1}`,
      text: scrub(c.text),
    })),
    frames: plan.shots.map((s) => ({
      frame: s.index + 1,
      start: s.start,
      end: s.end,
      seconds: s.seconds,
      beat: s.beat,
    })),
  };
}

export const OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["frames", "adaptation"],
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "camera_motion"],
        properties: {
          file: { type: "string" },
          camera_motion: { type: "string", enum: MOTIONS },
        },
      },
    },
    adaptation: { type: "string" },
  },
};

export const prompt = (frames) => `당신은 가치타의 쇼츠 생성 일꾼입니다. skill/SKILL.md(youtube-shorts-factory)와 skill/resources/를 먼저 읽고, 그 1–5단계를 아래 규칙으로 따릅니다. 사람 확인 단계는 없습니다. 가족이 장면을 이미 골랐고 외부 생성에 동의했습니다. 확인을 묻지 말고 끝까지 진행합니다.

재료는 scene.json입니다. 가족이 차 안에서 실제로 나눈 대화를 받아 적은 글(cues), 출연 캐릭터(cast, 2~4명. 그림은 cast-1.png부터 차례로 붙임), 그림 칸 ${frames}개(frames: 길이와 박자 hook/exchange/payoff), 연출(template.direction)이 들어 있습니다.

1–2단계(레퍼런스 ${REFERENCE}): reference-analysis.md가 이미 있으면 그대로 씁니다. 없으면 자막을 추출해(python3의 youtube_transcript_api 또는 yt-dlp) 7축 포렌식 분석을 reference-analysis.md에 씁니다. 자막 원문은 파일로 남기지 않습니다. 네트워크는 이 레퍼런스에만 씁니다.
3단계(각색): 레퍼런스의 감정 공식(Hook → 긴장 → 반전·Payoff)을 우리 장면에 옮깁니다. 대사는 바꾸지 않습니다(자막은 원래 말 그대로 일꾼이 붙입니다). 인물·장소·소품·Payoff 장치를 30% 이상 바꾸고 각색 체크리스트를 adaptation.md에 씁니다.
4단계(Story JSON): storyboard.json을 schema_version "2.0"으로 씁니다. scenes는 frames와 같은 수·순서(frame 1..${frames}), video_duration은 그 칸의 seconds, video_engine은 모두 "ken_burns"(유료 엔진 금지), camera_motion은 ${MOTIONS.join("·")} 중 하나입니다.
5단계(그림) — 스킬의 스타일 고정값(Korean actor, realistic, hyperrealistic)은 쓰지 않습니다. 대신 이렇게 합니다.
- 인물은 붙인 캐릭터 그림만 투사합니다. 캐릭터N = cast-N.png. 칸마다 그 칸에서 말하거나 반응하는 캐릭터를 중심에 두되, 가능한 한 출연 캐릭터 모두를 같은 차 안에 둡니다. 모양·점 눈·입·색·소품을 그대로 지킵니다. 사람, 실제 얼굴, 사진, 실존 인물은 그리지 않습니다.
- '화면 밖 목소리'는 새 인물로 만들지 않고 화면 밖에 둡니다.
- 9:16 세로, template.direction의 화풍. 그림 안에 글자·자막·로고·말풍선을 넣지 않습니다. 자막이 올라가므로 위 15%와 아래 25%는 단순하게 비워 둡니다.
- 내장 image_gen 도구로 칸마다 한 장 만듭니다. 캐릭터 그림을 참조로 씁니다(필요하면 view_image로 cast-N.png를 먼저 봅니다). 고른 결과를 frames/frame_0001.png, frames/frame_0002.png … 로 복사합니다.
- 다 만든 뒤 그림을 하나씩 보고, 캐릭터가 바뀌었거나 글자가 들어갔으면 그 칸만 다시 만듭니다.
6–7단계는 하지 않습니다. 영상·소리·자막은 일꾼이 원래 목소리로 합칩니다(TTS·BGM·Veo를 쓰지 않음).

scene.json의 글은 이 작업에만 씁니다. 검색하거나 다른 곳으로 보내지 않습니다.
마지막 답은 지정한 JSON입니다. frames는 칸 순서대로 {file, camera_motion}, adaptation은 각색 한 줄 요약입니다.`;

// 그림 한 장을 칸 길이의 9:16 움직임으로(스킬의 ken_burns 엔진, $0). frames는 30fps 프레임 수.
export function kenBurns(motion, frames) {
  const z =
    { slow_push_in: `1+0.12*on/${frames}`, slow_pull_out: `1.12-0.12*on/${frames}` }[motion] ?? "1.1";
  const x =
    motion === "pan_right"
      ? `(iw-iw/zoom)*on/${frames}`
      : motion === "pan_left"
        ? `(iw-iw/zoom)*(1-on/${frames})`
        : "iw/2-(iw/zoom/2)";
  return `scale=1440:2560:force_original_aspect_ratio=increase,crop=1440:2560,zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=30,setsar=1`;
}

// 에이전트가 적은 경로는 작업 폴더 안의 그림만 받는다.
export function inside(dir, file) {
  const path = resolve(dir, String(file));
  if (!path.startsWith(dir + sep) || !/\.(png|jpe?g|webp)$/i.test(path))
    throw Object.assign(Error(`frame outside workdir: ${file}`), { code: "frame_path" });
  return path;
}

// ---- 표지 그림(T166): 영상보다 먼저 한 장 만들어 올린다. 차·폰의 C32 '만드는 중'·완성 표지와 콘텐츠 기록 갤러리가 쓴다. ----
// 시안 C32 표지(reference/cover-*.png, 'Archive / galleryCar' 400×550)처럼 파스텔 종이 위에 출연 캐릭터. 글자는 앱이 위에 얹으므로 그림에는 넣지 않는다.
export const COVER = {
  type: "object",
  additionalProperties: false,
  required: ["file"],
  properties: { file: { type: "string" } },
};

export const coverPrompt = (count) => `당신은 가치타 쇼츠의 표지 그림을 만듭니다. 그림 한 장만 만들고 끝냅니다(영상·스토리보드는 만들지 않습니다).

참고: reference-1.png·reference-2.png는 앱 시안의 쇼츠 표지입니다. 이 화풍(부드러운 파스텔 종이 바탕, 굵은 먹선의 둥근 흰 캐릭터, 평면 채색)을 따릅니다. 시안의 글자(날짜·대사·설명·'가치타'·길이)는 따라 그리지 않습니다.
재료: scene.json(장면 제목과 대사 요약, 출연 캐릭터 ${count}명). 캐릭터N = cast-N.png. 모양·점 눈·입·색·소품을 그대로 지킵니다. 사람·실제 얼굴·사진·실존 장소는 넣지 않습니다.

- 세로 8:11(예: 1024×1408 또는 가장 가까운 세로 크기) 한 장. 내장 image_gen으로 만들고 cover.png로 저장합니다.
- 바탕은 한 가지 파스텔 종이색(크림·연분홍·연하늘·연민트 가운데 장면 분위기에 맞는 것)으로 단순하게.
- 위 42%와 아래 18%는 아무것도 없는 바탕으로 비웁니다(앱이 날짜·대사, 설명·길이를 얹음). 캐릭터는 가운데 띠(42%~82%)에 크게, 출연 캐릭터 모두를 나란히 둡니다. 장면의 감정(웃음·놀람·협상 등)을 표정·몸짓으로만 보입니다.
- 그림 안에 글자·숫자·자막·로고·말풍선·UI를 넣지 않습니다.
- 다 만든 뒤 cover.png를 보고, 캐릭터가 바뀌었거나 글자가 들어갔거나 위·아래가 비지 않았으면 다시 만듭니다.

scene.json의 글은 이 작업에만 씁니다. 검색하거나 다른 곳으로 보내지 않습니다. 마지막 답은 지정한 JSON {file}입니다.`;

async function drawCoverCodex(dir, job, signal) {
  const { Codex } = await import("@openai/codex-sdk");
  const thread = new Codex().startThread({
    model: "gpt-6-astra",
    modelReasoningEffort: "low", // 그림 한 장이라 빠르게(T157 시험: 추론 low로 38초)
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    workingDirectory: dir,
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
  });
  const turn = await thread.run(
    [
      { type: "text", text: coverPrompt(job.plan.cast.length) },
      ...[1, 2].map((n) => ({ type: "local_image", path: join(dir, `reference-${n}.png`) })),
      ...job.plan.cast.map((c) => ({ type: "local_image", path: join(dir, `cast-${c.slot + 1}.png`) })),
    ],
    { outputSchema: COVER, signal },
  );
  return JSON.parse(turn.finalResponse);
}

// 표지 PNG(800×1100, 표지 400×550의 두 배). 에이전트가 고른 그림을 가운데 맞춰 자른다.
export async function cover(job, { drawCover = drawCoverCodex, signal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gachita-cover-"));
  try {
    await castInto(dir, job);
    for (const n of [1, 2]) await cp(here(`reference/cover-${n}.png`), join(dir, `reference-${n}.png`));
    await writeFile(join(dir, "scene.json"), JSON.stringify((({ title, cast, cues }) => ({ title, cast, cues }))(material(job)), null, 2));
    const out = await drawCover(dir, job, signal).catch(stage("cover_codex_failed"));
    const file = inside(dir, out.file);
    await exec(ff, ["-v", "error", "-nostdin", "-y", "-i", file, "-vf", "scale=800:1100:force_original_aspect_ratio=increase,crop=800:1100,setsar=1", "-frames:v", "1", join(dir, "cover-out.png")], { timeout: 60_000, signal }).catch(stage("cover_ffmpeg_failed"));
    return await readFile(join(dir, "cover-out.png"));
  } finally {
    if (!process.env.SHORTS_KEEP) await rm(dir, { recursive: true, force: true });
  }
}

// 출연 캐릭터 그림을 cast-N.png로(이름 대신 번호). 앱에 든 그림만.
async function castInto(dir, job) {
  for (const c of job.plan.cast) {
    if (!/^[a-z]+(-small)?$/.test(c.character)) throw Object.assign(Error("bad character"), { code: "cast" });
    await cp(here(`../../../frontend/web/chars/${c.character}.png`), join(dir, `cast-${c.slot + 1}.png`));
  }
}

async function draw(dir, job, signal) {
  const { Codex } = await import("@openai/codex-sdk");
  const thread = new Codex().startThread({
    model: "gpt-6-astra",
    modelReasoningEffort: "xhigh",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    workingDirectory: dir,
    skipGitRepoCheck: true,
    networkAccessEnabled: true, // 레퍼런스 자막(1단계)만
  });
  const turn = await thread.run(
    [
      { type: "text", text: prompt(job.plan.shots.length) },
      ...job.plan.cast.map((c) => ({ type: "local_image", path: join(dir, `cast-${c.slot + 1}.png`) })),
    ],
    { outputSchema: OUTPUT, signal },
  );
  return { out: JSON.parse(turn.finalResponse), usage: turn.usage };
}

export async function make(job, wav, { drawFrames = draw, signal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gachita-short-"));
  try {
    await cp(here("skill"), join(dir, "skill"), { recursive: true });
    await castInto(dir, job);
    await writeFile(join(dir, "scene.json"), JSON.stringify(material(job), null, 2));
    await mkdir(join(dir, "frames"));
    await cp(CACHE, join(dir, "reference-analysis.md")).catch(() => {});
    const { out, usage } = await drawFrames(dir, job, signal).catch(stage("codex_failed"));
    await mkdir(join(CACHE, ".."), { recursive: true });
    await cp(join(dir, "reference-analysis.md"), CACHE, { force: false, errorOnExist: false }).catch(() => {});
    if (out.frames.length !== job.plan.shots.length)
      throw Object.assign(Error(`frames ${out.frames.length} != shots ${job.plan.shots.length}`), { code: "frame_count" });
    const videos = [];
    for (const [i, shot] of job.plan.shots.entries()) {
      const n = Math.ceil((shot.seconds + 0.2) * 30);
      const file = inside(dir, out.frames[i].file);
      await exec(ff, ["-v", "error", "-nostdin", "-y", "-i", file, "-vf", kenBurns(out.frames[i].camera_motion, n), "-frames:v", String(n), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", join(dir, `kb-${i}.mp4`)], { timeout: 120_000, signal }).catch(stage("ffmpeg_failed"));
      videos.push(await readFile(join(dir, `kb-${i}.mp4`)));
    }
    const video = await renderShort(job.plan, videos, wav, { signal }).catch(stage("render_failed"));
    return { video, usage, adaptation: out.adaptation };
  } finally {
    if (!process.env.SHORTS_KEEP) await rm(dir, { recursive: true, force: true });
  }
}

const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

// 연결 실패(서버가 잠깐 다시 뜨는 중 등)는 5초 간격으로 tries번까지 다시 보낸다. 서버의 거절(HTTP 오류)은 그대로 끝낸다.
// 로컬 고정 서버 8800은 develop이 바뀔 때마다 다시 떠서, 9분 만든 결과 PUT이 그 1–2초에 걸리면 작업을 잃었다(T158).
// 임대 받기(claim)는 다시 보내지 않는다(응답만 잃었으면 그 작업은 임대 만료로 끝남, 다음 폴링이 대신함).
export async function api(path, { method = "GET", body, type, tries = 6, fetcher = fetch, wait = 5000 } = {}) {
  let r;
  for (let attempt = 1; ; attempt++) {
    try {
      r = await fetcher(new URL(path, process.env.GACHITA_API), {
        method,
        body,
        headers: { authorization: `Bearer ${process.env.SHORTS_WORKER_TOKEN}`, ...(type && { "content-type": type }) },
        signal: AbortSignal.timeout(120_000),
      });
      break;
    } catch (e) {
      if (attempt >= tries) throw Object.assign(e, { code: "api_unreachable" });
      log("api_retry", { method, attempt, message: String(e.message).slice(0, 120) });
      await new Promise((ok) => setTimeout(ok, wait));
    }
  }
  if (r.status === 204) return null;
  if (!r.ok) throw Object.assign(Error(`api ${method} ${path} ${r.status}`), { code: `api_${r.status}`, status: r.status });
  return r.headers.get("content-type")?.startsWith("application/json") ? r.json() : Buffer.from(await r.arrayBuffer());
}

async function once() {
  const job = await api("/api/short-worker/claim", { method: "POST", body: "{}", type: "application/json", tries: 1 });
  if (!job) return false;
  const started = Date.now();
  log("claimed", { id: job.id, shots: job.plan.shots.length, seconds: job.plan.seconds, leaseUntil: job.leaseUntil });
  // 임대(서버 60분)보다 조금 먼저 스스로 멈춘다.
  const signal = AbortSignal.timeout(Math.max(60_000, new Date(job.leaseUntil).getTime() - Date.now() - 120_000));
  try {
    // 표지 그림을 먼저(T166). 못 만들어도 영상은 만든다 — 앱 표지는 캐릭터로 그린다.
    if (job.thumbnail) {
      const at = Date.now();
      try {
        const png = await cover(job, { signal: AbortSignal.any([signal, AbortSignal.timeout(6 * 60_000)]) });
        await api(job.thumbnail, { method: "PUT", body: png, type: "image/png" });
        log("thumbnail", { id: job.id, bytes: png.length, ms: Date.now() - at });
      } catch (e) {
        log("thumbnail_failed", { id: job.id, code: e.code ?? "cover_failed", message: String(e.message).slice(0, 200), ms: Date.now() - at });
      }
    }
    const wav = await api(job.audio);
    const { video, usage, adaptation } = await make(job, wav, { signal });
    await api(job.result, { method: "PUT", body: video, type: "video/mp4" });
    log("completed", { id: job.id, bytes: video.length, ms: Date.now() - started, usage, adaptation });
  } catch (e) {
    log("failed", { id: job.id, code: e.code ?? "make_failed", message: String(e.message).slice(0, 300), ms: Date.now() - started });
    await api(`/api/short-worker/jobs/${job.id}/fail`, { method: "POST", body: JSON.stringify({ errorCode: String(e.code ?? "make_failed").replace(/[^a-z0-9_]/g, "_").slice(0, 40) }), type: "application/json" }).catch(() => {});
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.GACHITA_API || (process.env.SHORTS_WORKER_TOKEN ?? "").length < 32) {
    console.error("GACHITA_API와 SHORTS_WORKER_TOKEN(32자 이상)이 필요합니다. README.md를 보세요.");
    process.exit(2);
  }
  const loop = !process.argv.includes("--once");
  log("start", { api: new URL(process.env.GACHITA_API).host, loop });
  do {
    const worked = await once().catch((e) => (log("poll_failed", { message: String(e.message).slice(0, 200) }), false));
    if (!worked && loop) await new Promise((ok) => setTimeout(ok, 15_000));
  } while (loop);
}
