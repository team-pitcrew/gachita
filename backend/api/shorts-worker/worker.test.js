import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { material, kenBurns, inside, make, prompt, MOTIONS } from "./worker.mjs";

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
