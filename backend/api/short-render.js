import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
const ff = process.env.FFMPEG_PATH || "ffmpeg";
const probe = process.env.FFPROBE_PATH || "ffprobe";
const safe = (text) =>
  String(text)
    .replace(/[\\{}]/g, "")
    .replace(/[\x00-\x1f]/g, " ")
    .trim();
const time = (s) => {
  const c = Math.round(Math.max(0, s) * 100);
  return `${Math.floor(c / 360000)}:${String(Math.floor(c / 6000) % 60).padStart(2, "0")}:${String(Math.floor(c / 100) % 60).padStart(2, "0")}.${String(c % 100).padStart(2, "0")}`;
};
function wrap(text, max = 20) {
  const chars = [...safe(text)];
  const lines = [];
  for (let i = 0; i < chars.length; i += max)
    lines.push(chars.slice(i, i + max).join(""));
  return lines;
}
export function subtitles(plan) {
  const rows = [];
  const line = (start, end, style, text) =>
    rows.push(
      `Dialogue: 0,${time(start)},${time(end)},${style},,0,0,0,,${text}`,
    );
  line(0, plan.seconds, "Title", wrap(plan.title, 18).slice(0, 3).join("\\N"));
  for (const c of plan.cues) {
    const parts = wrap(c.text);
    const pages = [];
    for (let i = 0; i < parts.length; i += 2)
      pages.push(parts.slice(i, i + 2).join("\\N"));
    const who = c.slot === null ? "화자 미확인" : plan.cast[c.slot].name;
    pages.forEach((text, i) =>
      line(
        c.start + ((c.end - c.start) * i) / pages.length,
        c.start + ((c.end - c.start) * (i + 1)) / pages.length,
        "Caption",
        `${safe(who)}\\N${text}`,
      ),
    );
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 2\nScaledBorderAndShadow: yes\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Title,Noto Sans CJK KR,42,&H00FFFFFF,&H00FFFFFF,&H001A211F,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,8,48,48,60,1\nStyle: Caption,Noto Sans CJK KR,40,&H00FFFFFF,&H00FFFFFF,&H001A211F,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,44,44,125,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${rows.join("\n")}\n`;
}
export async function audioSlice(wav, shot) {
  const dir = await mkdtemp(join(tmpdir(), "gachita-audio-"));
  try {
    await writeFile(join(dir, "input.wav"), wav);
    await exec(
      ff,
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-ss",
        String(shot.start),
        "-i",
        "input.wav",
        "-t",
        String(shot.seconds),
        "-ar",
        "16000",
        "-ac",
        "1",
        "slice.wav",
      ],
      { cwd: dir, timeout: 30_000, maxBuffer: 200_000 },
    );
    return await readFile(join(dir, "slice.wav"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function renderShort(plan, videos, wav, { signal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gachita-render-"));
  try {
    await writeFile(join(dir, "audio.wav"), wav);
    await writeFile(join(dir, "captions.ass"), subtitles(plan));
    for (let i = 0; i < videos.length; i++) {
      await writeFile(join(dir, `source-${i}.mp4`), videos[i]);
      const p = JSON.parse(
        (
          await exec(
            probe,
            [
              "-v",
              "error",
              "-show_entries",
              "format=duration:stream=width,height,codec_type",
              "-of",
              "json",
              `source-${i}.mp4`,
            ],
            { cwd: dir, timeout: 15_000, signal },
          )
        ).stdout,
      );
      if (
        Number(p.format?.duration) < plan.shots[i].seconds - 0.1 ||
        !p.streams?.some((s) => s.codec_type === "video" && s.height > s.width)
      )
        throw Error("invalid_generated_video_dimensions_or_duration");
      await exec(
        ff,
        [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-i",
          `source-${i}.mp4`,
          "-an",
          "-t",
          String(plan.shots[i].seconds),
          "-vf",
          "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x17221e,setsar=1,fps=30",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-threads",
          "2",
          "-pix_fmt",
          "yuv420p",
          `shot-${i}.mp4`,
        ],
        { cwd: dir, timeout: 180_000, maxBuffer: 200_000, signal },
      );
    }
    await writeFile(
      join(dir, "shots.txt"),
      videos.map((_, i) => `file 'shot-${i}.mp4'`).join("\n"),
    );
    await exec(
      ff,
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        "shots.txt",
        "-i",
        "audio.wav",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-t",
        String(plan.seconds),
        "-vf",
        "subtitles=captions.ass",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "output.mp4",
      ],
      { cwd: dir, timeout: 240_000, maxBuffer: 200_000, signal },
    );
    return await readFile(join(dir, "output.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
