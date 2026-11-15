import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { material, kenBurns, inside, make, prompt, MOTIONS, cover, coverPrompt, api, seatBlock, SEAT_PLACE } from "./worker.mjs";

const job = {
  template: { name: "차 안 대화극", direction: "Warm hand-drawn 2D sitcom frames. no human faces." },
  plan: {
    title: "서준의 정답",
    seconds: 15,
    cast: [
      { slot: 0, participantId: "p1", name: "서준", character: "cap", seat: "ROW_2_LEFT" },
      { slot: 1, participantId: null, name: "화자 미확인", character: "basic-small", seat: null },
    ],
    cues: [
      { start: 0.5, end: 3, text: "서준아 이거 봐", slot: 0, participantId: "p1" },
      { start: 4, end: 6, text: "하하", slot: null, participantId: null },
    ],
    shots: [
      { index: 0, start: 0, end: 7.5, seconds: 7.5, beat: "hook" },
      { index: 1, start: 7.5, end: 15, seconds: 7.5, beat: "payoff" },
    ],
  },
};

test("Codex에 주는 재료에는 참가자 이름·id가 없고 캐릭터 번호만 있습니다", () => {
  const m = material(job);
  const text = JSON.stringify(m);
  assert.doesNotMatch(text, /서준|p1|participantId|ROW_2/);
  assert.equal(m.title, "캐릭터1의 정답");
  assert.deepEqual(m.cues.map((c) => [c.speaker, c.text]), [["캐릭터1", "캐릭터1아 이거 봐"], ["화면 밖 목소리", "하하"]]);
  assert.deepEqual(m.cast.map((c) => c.image), ["cast-1.png", "cast-2.png"]);
  assert.match(prompt(2), /ken_burns/);
  assert.doesNotMatch(prompt(2), /hyperrealistic, /);
});

test("켄 번스는 칸 길이만큼 720×1280으로 움직이고 모르는 움직임은 가운데 확대로 둡니다", () => {
  for (const m of MOTIONS) assert.match(kenBurns(m, 90), /d=90:s=720x1280:fps=30/);
  assert.match(kenBurns("slow_push_in", 90), /z='1\+0\.12\*on\/90'/);
  assert.match(kenBurns("pan_right", 90), /x='\(iw-iw\/zoom\)\*on\/90'/);
  assert.match(kenBurns("orbit", 90), /z='1\.1'/);
});

test("에이전트가 적은 그림 경로는 작업 폴더 안의 그림만 받습니다", () => {
  assert.equal(inside("/w", "frames/frame_0001.png"), "/w/frames/frame_0001.png");
  for (const bad of ["../x.png", "/etc/passwd", "frames/a.sh", "/w2/a.png"]) assert.throws(() => inside("/w", bad), (e) => e.code === "frame_path");
});

// ffmpeg가 있는 곳(운영자 맥)에서만: 그림 둘 → 켄 번스 → 원음·자막 합성까지 실제로 돌린다. Codex 자리는 대역.
const ffmpeg = (() => { try { execFileSync("ffmpeg", ["-version"]); return true; } catch { return false; } })();
test("그림·원음으로 장면 길이의 9:16 MP4를 만듭니다(ffmpeg)", { skip: !ffmpeg }, async () => {
  const src = await mkdtemp(join(tmpdir(), "gachita-worker-test-"));
  const wav = join(src, "a.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=220:d=15", "-ar", "16000", "-ac", "1", wav]);
  let seen;
  const drawFrames = async (dir, j) => {
    seen = dir;
    for (const s of j.plan.shots) execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x88aa99:s=941x1672", "-frames:v", "1", join(dir, "frames", `frame_000${s.index + 1}.png`)]);
    return { out: { frames: j.plan.shots.map((s, i) => ({ file: `frames/frame_000${s.index + 1}.png`, camera_motion: MOTIONS[i] })), adaptation: "대역" }, usage: null };
  };
  const { video } = await make(job, await readFile(wav), { drawFrames });
  const out = join(src, "out.mp4");
  await writeFile(out, video);
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", out]));
  assert.ok(Math.abs(Number(p.format.duration) - 15) < 0.5);
  assert.deepEqual(p.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
  assert.deepEqual([p.streams.find((s) => s.width).width, p.streams.find((s) => s.width).height], [720, 1280]);
  assert.ok(seen, "작업 폴더를 그림 단계에 넘깁니다");
});

test("표지 그림(T166): 시안 표지·캐릭터 그림을 주고, 고른 그림을 표지 크기(800×1100) PNG로 자릅니다", { skip: !ffmpeg }, async () => {
  let given;
  const drawCover = async (dir) => {
    given = (await import("node:fs")).readdirSync(dir).sort();
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0xfdf0d8:s=1024x1536", "-frames:v", "1", join(dir, "cover.png")]);
    return { file: "cover.png" };
  };
  const png = await cover(job, { drawCover });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const src = await mkdtemp(join(tmpdir(), "gachita-cover-test-"));
  await writeFile(join(src, "c.png"), png);
  const p = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json", join(src, "c.png")]));
  assert.deepEqual([p.streams[0].width, p.streams[0].height], [800, 1100]);
  assert.deepEqual(given.filter((f) => f !== "cover.png"), ["cast-1.png", "cast-2.png", "reference-1.png", "reference-2.png", "scene.json"]);
  assert.match(coverPrompt(2), /글자·숫자·자막·로고·말풍선·UI를 넣지 않습니다/);
  await assert.rejects(cover(job, { drawCover: async () => ({ file: "../escape.png" }) }), (e) => e.code === "frame_path");
});

test("서버가 잠깐 다시 뜨는 동안의 연결 실패는 다시 보내고, 서버의 거절은 바로 끝냅니다", async () => {
  process.env.GACHITA_API ??= "http://127.0.0.1:1";
  let calls = 0;
  const flaky = async () => { if (++calls < 3) throw new TypeError("fetch failed"); return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); };
  assert.deepEqual(await api("/x", { method: "PUT", body: Buffer.from("v"), fetcher: flaky, wait: 0 }), { ok: true });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(api("/x", { fetcher: async () => { calls++; return new Response("", { status: 410 }); }, wait: 0 }), (e) => e.status === 410);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(api("/claim", { method: "POST", tries: 1, fetcher: async () => { calls++; throw new TypeError("fetch failed"); }, wait: 0 }), (e) => e.code === "api_unreachable");
  assert.equal(calls, 1);
});

test("그룹 프로필의 좌석을 모든 칸의 지침에 고정합니다(운전석·좌우·운전대)", () => {
  const four = { ...job, plan: { ...job.plan, cast: [
    { slot: 0, participantId: "p1", name: "서준", character: "cap", seat: "ROW_2_LEFT" },
    { slot: 1, participantId: "p2", name: "아빠", character: "glasses", seat: "ROW_1_LEFT" },
    { slot: 2, participantId: "p3", name: "엄마", character: "healing", seat: "ROW_1_RIGHT" },
    { slot: 3, participantId: null, name: "화자 미확인", character: "basic-small", seat: null },
  ] } };
  const m = material(four);
  assert.deepEqual(m.cast.map((c) => c.seat), [SEAT_PLACE.ROW_2_LEFT, SEAT_PLACE.ROW_1_LEFT, SEAT_PLACE.ROW_1_RIGHT, "등록 좌석 없음 — 운전석이 아닌 빈 자리"]);
  const block = seatBlock(m.cast);
  assert.match(block, /캐릭터2\(cast-2\.png\): 운전석 — 앞줄, 그림 오른쪽/);
  assert.match(block, /운전대는 운전석 캐릭터만/);
  assert.match(prompt(4, m.cast), /좌석표 줄을 칸마다 그대로 다시 적음/);
  assert.match(prompt(4, m.cast), /캐릭터1\(cast-1\.png\): 운전석 뒷자리 — 뒷줄, 그림 오른쪽/);
  assert.doesNotMatch(JSON.stringify(m), /서준|아빠|엄마/, "좌석을 넣어도 이름은 보내지 않습니다");
  assert.match(seatBlock(material(job).cast), /운전석은 비워 두고 아무도 운전대를 잡지 않습니다/, "운전석 주인이 출연하지 않으면 아무도 운전하지 않음");
});
test("앞단의 502–504는 다시 보내고, 다시 보낸 끝의 거절에는 시도 횟수를 남깁니다", async () => {
  process.env.GACHITA_API ??= "http://127.0.0.1:1";
  let calls = 0;
  const deploy = async () => (++calls < 3 ? new Response("", { status: 503 }) : new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
  assert.deepEqual(await api("/x", { method: "PUT", body: Buffer.from("v"), fetcher: deploy, wait: 0 }), { ok: true });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(api("/x", { fetcher: async () => { calls++; return new Response("", { status: 502 }); }, tries: 2, wait: 0 }), (e) => e.status === 502 && e.attempts === 2);
  assert.equal(calls, 2);
  calls = 0;
  const lost = async () => (++calls === 1 ? new Response("", { status: 504 }) : new Response("", { status: 410 }));
  await assert.rejects(api("/x", { method: "PUT", fetcher: lost, wait: 0 }), (e) => e.status === 410 && e.attempts === 2, "응답만 잃고 이미 받아들여진 경우를 가릴 수 있다");
});
test("파일을 주고받는 요청은 느린 운영 경로를 견디게 제한 시간을 길게 줍니다", async () => {
  process.env.GACHITA_API ??= "http://127.0.0.1:1";
  const slow = (ms) => async (url, o) => new Promise((ok, no) => { const t = setTimeout(() => ok(new Response(null, { status: 204 })), ms); o.signal.addEventListener("abort", () => { clearTimeout(t); no(o.signal.reason); }); });
  await assert.rejects(api("/x", { fetcher: slow(200), timeout: 50, tries: 1 }), (e) => e.code === "api_unreachable");
  assert.equal(await api("/x", { fetcher: slow(200), timeout: 1000, tries: 1 }), null);
  const src = (await import("node:fs")).readFileSync(new URL("./worker.mjs", import.meta.url), "utf8");
  for (const call of ["job.thumbnail", "job.audio", "job.result"]) assert.match(src.split("\n").find((l) => l.includes(`api(${call}`)), /timeout: SLOW/, `${call}에 긴 제한`);
});
test("프로필이 성명이면 대화 속 호칭(성을 뗀 이름)도 캐릭터 번호로 바꿉니다", () => {
  const j = { ...job, plan: { ...job.plan, title: "민준님이 낼 때까지", cast: [
    { slot: 0, participantId: "p1", name: "김상현", character: "glasses", seat: "ROW_1_LEFT" },
    { slot: 1, participantId: "p2", name: "유민준", character: "basic-small", seat: "ROW_2_RIGHT" },
  ], cues: [{ start: 1, end: 3, text: "거기다 주차하고, 민준님이 하나 낼 때까지 놀자. 유민준 씨, 상현이 형도요.", slot: 0, participantId: "p1" }] } };
  const m = material(j);
  assert.doesNotMatch(JSON.stringify(m), /민준|상현/);
  assert.equal(m.cues[0].text, "거기다 주차하고, 캐릭터2님이 하나 낼 때까지 놀자. 캐릭터2 씨, 캐릭터1이 형도요.");
  assert.equal(m.title, "캐릭터2님이 낼 때까지");
});

