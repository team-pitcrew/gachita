import { h } from "./shared.js";

const PATHS = {
  stop: "M6 6h12v12H6z",
  play: "M8 5v14l11-7z", pause: "M8 5v14M16 5v14",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8",
  sound: "M3 9h4l5-4v14l-5-4H3zM16 8q5 4 0 8M19 5q7 7 0 14",
  muted: "M3 9h4l5-4v14l-5-4H3zM17 9l5 6M22 9l-5 6",
  back: "m15 18-6-6 6-6", up: "m5 15 7-7 7 7", down: "m5 9 7 7 7-7",
  people: "M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M17 14a5 5 0 0 1 5 5v2",
};

export function mediaIcon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const shape = document.createElementNS(ns, name === "record" ? "circle" : "path");
  const props = name === "record" ? { cx: 12, cy: 12, r: 7, fill: "currentColor", stroke: "none" } : { d: PATHS[name] || PATHS.play };
  for (const [key, value] of Object.entries(props)) shape.setAttribute(key, value);
  svg.append(shape);
  return svg;
}

export function setMediaButton(button, icon, label) {
  button.setAttribute("aria-label", label);
  button.title = label;
  if (button.dataset.icon !== icon) { button.dataset.icon = icon; button.replaceChildren(mediaIcon(icon)); }
}

export function mediaButton(icon, label, onclick, className = "") {
  const button = h("button", { type: "button", className: `media-button ${className}`, onclick });
  setMediaButton(button, icon, label);
  return button;
}

export function mediaTime(seconds) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

// 실제 PCM의 구간별 최대 진폭. 무음에는 높이를 만들어 넣지 않는다.
export function waveformPeaks(channels, count = 80) {
  const length = channels[0]?.length || 0;
  if (!length || count < 1) return [];
  const bins = Math.min(count, length);
  return Array.from({ length: bins }, (_, i) => {
    let peak = 0;
    for (const channel of channels) for (let j = Math.floor(i * length / bins); j < Math.floor((i + 1) * length / bins); j++) peak = Math.max(peak, Math.abs(channel[j] || 0));
    return Math.min(1, peak);
  });
}

export async function audioPeaks(blob) {
  const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Context) return [];
  const context = new Context(1, 1, 16000);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  return waveformPeaks(Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)));
}

export function drawWaveform(canvas, peaks = [], progress = 0) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const colors = getComputedStyle(canvas);
  ctx.fillStyle = colors.getPropertyValue("--wave-muted").trim() || colors.color;
  ctx.fillRect(0, height / 2, width, 1);
  if (!peaks.length) return;
  const step = width / peaks.length;
  peaks.forEach((peak, i) => {
    ctx.fillStyle = i / peaks.length < progress ? colors.color : colors.getPropertyValue("--wave-muted").trim() || colors.color;
    const size = peak * (height - 8);
    ctx.fillRect(i * step, (height - size) / 2, Math.max(1, step * .48), Math.max(1, size));
  });
}

// 서버의 녹음 설정을 이 화면에서 관찰한 시간. 실제 마이크 수음 시간과 다르다.
export function createRecordingClock(now = () => performance.now()) {
  let key, elapsed = 0, since = null;
  return {
    update(nextKey, active) {
      const time = now();
      if (key !== nextKey) { key = nextKey; elapsed = 0; since = null; }
      if (active && since === null) since = time;
      else if (!active && since !== null) { elapsed += Math.max(0, time - since); since = null; }
    },
    seconds: () => (elapsed + (since === null ? 0 : Math.max(0, now() - since))) / 1000,
  };
}
