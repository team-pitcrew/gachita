import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
export const ASSET_MAX_BYTES = 64_000_000;
const fail = (status, error) => { throw { status, error }; };
const ratio = (value) => {
  const [a, b = 1] = String(value ?? "").split("/").map(Number);
  return a / b;
};

// 파일 이름/클라이언트 메타데이터를 신뢰하지 않습니다. 실제 컨테이너·스트림·프레임을 확인합니다.
function streamsOf(probe, mimeType) {
  const video = probe.streams?.filter(s => s.codec_type === "video") ?? [];
  const audio = probe.streams?.filter(s => s.codec_type === "audio") ?? [];
  const allowed = mimeType === "video/mp4" ? /(^|,)mp4(,|$)/ : /(^|,)webm(,|$)/;
  if (!allowed.test(probe.format?.format_name ?? "") || video.length !== 1 || audio.length !== 1 || probe.streams.length !== 2) fail(400, "영상과 소리 트랙이 하나씩 있는 MP4·WebM 파일이 필요해요");
  const v = video[0], a = audio[0];
  const width = Number(v.width), height = Number(v.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 240 || height < 426 || width > 2160 || height > 3840 || Math.abs(width / height - 9 / 16) > .02) fail(400, "9:16 세로 영상이 필요해요(240×426~2160×3840)");
  return { v, a, width, height };
}

export function measuredVideo(probe, mimeType, expectedSeconds) {
  const { v, a, width, height } = streamsOf(probe, mimeType);
  const spans = new Map();
  for (const packet of probe.packets ?? []) {
    const at = Number(packet.pts_time), duration = Number(packet.duration_time ?? 0);
    if (!Number.isFinite(at) || !Number.isFinite(duration) || duration < 0) continue;
    const span = spans.get(packet.stream_index) ?? { start: Infinity, end: -Infinity };
    span.start = Math.min(span.start, at); span.end = Math.max(span.end, at + duration);
    spans.set(packet.stream_index, span);
  }
  const length = (stream) => {
    const span = spans.get(stream.index);
    return span ? span.end - Math.max(0, span.start) : NaN;
  };
  if (![v, a].every(s => spans.get(s.index)?.start >= -1 && spans.get(s.index)?.start <= .5)) fail(400, "영상과 소리가 시작부터 재생되는 파일이 필요해요");
  const videoSeconds = length(v), audioSeconds = length(a);
  const seconds = Math.max(videoSeconds, audioSeconds);
  if (![videoSeconds, audioSeconds].every(n => Number.isFinite(n) && n >= .5 && n <= 61 && Math.abs(n - expectedSeconds) <= 1)) fail(400, "영상과 소리 길이가 선택한 원음 장면과 맞지 않아요");
  const frames = Number(v.nb_read_frames), audioFrames = Number(a.nb_read_frames);
  const fps = frames / videoSeconds, declaredFps = ratio(v.avg_frame_rate) || ratio(v.r_frame_rate);
  if (!Number.isFinite(fps) || fps < 1 || fps > 61 || declaredFps > 61 || !Number.isInteger(frames) || frames < 1 || !Number.isInteger(audioFrames) || audioFrames < 1) fail(400, "재생할 수 있는 영상·소리 프레임을 확인하지 못했어요");
  const audioSampleRate = Number(a.sample_rate), audioChannels = Number(a.channels);
  if (!Number.isInteger(audioSampleRate) || !Number.isInteger(audioChannels) || audioSampleRate < 8000 || audioSampleRate > 96000 || audioChannels < 1 || audioChannels > 2) fail(400, "지원하지 않는 음성 형식이에요");
  return { mimeType, seconds, width, height, fps: Math.round(fps * 1000) / 1000,
    videoCodec: v.codec_name, audioCodec: a.codec_name, audioSampleRate, audioChannels, videoFrames: frames, audioFrames };
}

export async function inspectVideo(data, mimeType, seconds, { signal } = {}) {
  if (!Buffer.isBuffer(data) || data.length < 12 || data.length > ASSET_MAX_BYTES) fail(data?.length > ASSET_MAX_BYTES ? 413 : 400, "영상 파일 크기를 확인해 주세요(최대 64MB)");
  const mp4 = data.toString("ascii", 4, 8) === "ftyp", webm = data.readUInt32BE(0) === 0x1a45dfa3;
  if ((mimeType === "video/mp4" && !mp4) || (mimeType === "video/webm" && !webm) || !["video/mp4", "video/webm"].includes(mimeType)) fail(400, "파일 내용과 MP4·WebM 형식이 맞지 않아요");
  const dir = await mkdtemp(join(tmpdir(), "gachita-upload-"));
  try {
    const input = join(dir, mp4 ? "input.mp4" : "input.webm");
    await writeFile(input, data, { mode: 0o600 });
    const common = ["-v", "error", "-threads", "2", "-max_alloc", "67108864", "-protocol_whitelist", "file", "-f", mp4 ? "mov" : "matroska", ...(mp4 ? ["-enable_drefs", "0"] : [])];
    const run = (options) => exec(process.env.FFPROBE_PATH || "ffprobe", [...common,...options,"-of","json",input], { timeout: 25_000, maxBuffer: 2_000_000, signal });
    // 큰 프레임을 디코딩하기 전에 해상도·트랙 수·컨테이너를 먼저 제한합니다.
    const header = await run(["-show_entries", "format=format_name:stream=codec_type,width,height"]);
    if (header.stderr.trim()) fail(400, "손상된 영상 파일이에요");
    streamsOf(JSON.parse(header.stdout), mimeType);
    const { stdout, stderr } = await run(["-count_frames", "-show_packets", "-show_entries",
      "format=format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,sample_rate,channels:packet=stream_index,pts_time,duration_time",
    ]);
    if (stderr.trim()) fail(400, "영상·소리 프레임을 완전히 읽지 못했어요");
    return measuredVideo(JSON.parse(stdout), mimeType, seconds);
  } catch (error) {
    if (error?.status) throw error;
    if (error?.code === "ENOENT") fail(503, "영상 검사 도구가 준비되지 않았어요");
    if (signal?.aborted || error?.killed || error?.code === "ETIMEDOUT") fail(504, "영상 검사 시간이 지났어요. 다시 시도해 주세요");
    fail(400, "영상 파일을 읽지 못했어요. 재생 가능한 MP4·WebM을 골라 주세요");
  } finally { await rm(dir, { recursive: true, force: true }); }
}
