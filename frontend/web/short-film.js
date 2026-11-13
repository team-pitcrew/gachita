// 원본 말랑 전신과 실제 장면 자막·소리로 만드는 540×960 쇼츠. 외부 영상은 사용하지 않습니다.
export const CHARACTER_TYPES = [["basic", "기본"], ["cap", "캡모자"], ["glasses", "안경"], ["travel", "여행"], ["game", "게임"], ["sport", "운동"], ["pet", "반려동물"], ["camping", "캠핑"], ["office", "직장인"], ["healing", "힐링"]];
export const CHARACTER_OPTIONS = CHARACTER_TYPES.flatMap(([key, label]) => [[key, `${label} · 큰`], [`${key}-small`, `${label} · 작은`]]);
export const characterKey = (key) => CHARACTER_OPTIONS.some(([value]) => value === key) ? key : "basic";
export const characterSource = (key) => `/chars/${characterKey(key)}.png`;
const fallbackSource = () => "/chars/basic.png";
const personCharacter = (person) => person.character ? characterKey(person.character) : ({ ROW_1_LEFT: "basic", ROW_1_RIGHT: "cap", ROW_2_LEFT: "glasses-small", ROW_2_CENTER: "travel-small", ROW_2_RIGHT: "basic-small" }[person.seat] ?? "basic");
const FONT = '"Pretendard Variable", Pretendard, -apple-system, "Noto Sans KR", sans-serif';
const COLOR = { ink: "#171713", paper: "#f6f4f1", mint: "#60c090", soft: "#d8ebe0", seat: "#d6d2c8", seatLine: "#b8b5a9", muted: "#b5b7ac", dark: "#30372f" };

export function characterImage(key) {
  const img = document.createElement("img");
  img.src = characterSource(key); img.alt = ""; img.decoding = "async";
  img.onerror = () => { img.onerror = null; img.src = fallbackSource(key); };
  return img;
}

export function recordingFormat(recorder = globalThis.MediaRecorder) {
  if (!recorder?.isTypeSupported) return null;
  const mime = ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => recorder.isTypeSupported(type));
  return mime ? { mime, extension: mime.startsWith("video/mp4") ? "mp4" : "webm" } : null;
}

export function filmSpeakers(cast, scene, time) {
  const cue = scene.cues.find((c) => c.start <= time && time < c.end) ?? null;
  const ids = [...new Set(scene.cues.map((c) => c.participantId).filter(Boolean))];
  const people = ids.map((id) => cast.find((p) => p.participantId === id)).filter(Boolean);
  const unknown = { participantId: null, name: "말한 사람 미확인", character: "basic" };
  const active = cue ? cast.find((p) => p.participantId === cue.participantId) ?? unknown : null;
  const left = people[0] ?? cast[0] ?? unknown;
  let right = people[1] ?? cast.find((p) => p.participantId !== left.participantId) ?? null;
  if (active && active.participantId !== left.participantId && active.participantId !== right?.participantId) right = active;
  return { cue, active, people: [left, right].filter(Boolean) };
}

export function fitContain(width, height, box) {
  const scale = Math.min(box.width / width, box.height / height);
  return { x: box.x + (box.width - width * scale) / 2, y: box.y + (box.height - height * scale) / 2, width: width * scale, height: height * scale };
}

// 투명 여백만 측정합니다. 전신·두 팔의 불투명 픽셀은 자르지 않습니다.
function characterGeometry(img) {
  const probe = document.createElement("canvas"); probe.width = 256; probe.height = Math.max(1, Math.round(img.naturalHeight / img.naturalWidth * 256));
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  const full = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  try {
    ctx.drawImage(img, 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    const w = probe.width, h = probe.height, factor = img.naturalWidth / w;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    const dark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const at = (y * w + x) * 4;
      if (data[at + 3] > 24) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      if (data[at + 3] > 160 && Math.max(data[at], data[at + 1], data[at + 2]) < 100) dark[y * w + x] = 1;
    }
    if (minX >= maxX || minY >= maxY) return { bounds: full };
    const width = maxX - minX + 1, height = maxY - minY + 1;
    const bounds = { x: Math.max(0, minX - 2) * factor, y: Math.max(0, minY - 2) * factor, width: Math.min(w - Math.max(0, minX - 2), width + 4) * factor, height: Math.min(h - Math.max(0, minY - 2), height + 4) * factor };
    const candidates = [];
    for (let first = 0; first < dark.length; first++) {
      if (!dark[first]) continue;
      const queue = [first]; dark[first] = 0;
      let x0 = w, x1 = 0, y0 = h, y1 = 0;
      for (let at = 0; at < queue.length; at++) {
        const pos = queue[at], x = pos % w, y = Math.floor(pos / w);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (const next of [x > 0 ? pos - 1 : -1, x < w - 1 ? pos + 1 : -1, pos - w, pos + w]) if (next >= 0 && next < dark.length && dark[next]) { dark[next] = 0; queue.push(next); }
      }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const nx = (cx - minX) / width, ny = (cy - minY) / height;
      if (queue.length >= 3 && Math.abs(nx - .5) < .11 && ny > .22 && ny < .64 && cw > ch * 1.1 && cw < width * .16 && ch < height * .09) candidates.push({ cx, cy, cw, ch, score: Math.abs(nx - .5) * 8 + Math.abs(ny - .42) });
    }
    const candidate = candidates.sort((a, b) => a.score - b.score)[0];
    if (!candidate) return { bounds };
    const sample = (Math.min(h - 1, Math.round(candidate.cy + candidate.ch + 4)) * w + Math.round(candidate.cx)) * 4;
    if (data[sample + 3] < 230 || Math.min(data[sample], data[sample + 1], data[sample + 2]) < 210) return { bounds };
    return { bounds, mouth: { x: candidate.cx * factor, y: candidate.cy * factor, width: candidate.cw * factor, height: candidate.ch * factor, fill: `rgb(${data[sample]} ${data[sample + 1]} ${data[sample + 2]})` } };
  } catch { return { bounds: full }; }
}

// 말의 경계로 먼저 줄을 바꾸고, 한 단어가 너무 길 때만 자소를 보존해 나눕니다.
export function filmTextLines(text, measure, width) {
  const result = []; let line = "";
  for (const word of String(text ?? "").split(/\s+/u).filter(Boolean)) {
    if (line && measure(`${line} ${word}`) <= width) { line += ` ${word}`; continue; }
    if (line) result.push(line);
    line = "";
    for (const { segment } of new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(word)) {
      if (line && measure(line + segment) > width) { result.push(line); line = ""; }
      line += segment;
    }
  }
  if (line) result.push(line);
  return result;
}

export function createShortFilm({ title = "함께 남긴 순간", cast = [] }) {
  const canvas = Object.assign(document.createElement("canvas"), { width: 540, height: 960, className: "short-film" });
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "차량 실내의 말랑 캐릭터와 대화 자막으로 만든 쇼츠");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이 브라우저에서 쇼츠 화면을 만들지 못했어요.");
  const images = new Map();
  const load = (key) => {
    key = characterKey(key);
    if (images.has(key)) return images.get(key).ready;
    const img = new Image();
    const record = { img, loaded: false, png: true };
    record.ready = new Promise((resolve) => {
      img.onload = () => { record.loaded = true; record.geometry = record.png ? characterGeometry(img) : { bounds: { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight } }; resolve(); };
      img.onerror = () => { if (record.png) { record.png = false; img.src = fallbackSource(key); } else resolve(); };
    });
    images.set(key, record); img.src = characterSource(key); return record.ready;
  };
  const ready = Promise.all([load("basic"), ...cast.map((p) => load(personCharacter(p)))]);
  const round = (x, y, width, height, radius, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill(); };
  const label = (text, x, y, size, color = COLOR.paper, weight = 600, align = "center") => {
    ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = "middle"; ctx.fillText(text, x, y);
  };
  const block = (text, y, width, preferred, min, maxLines, color = COLOR.paper) => {
    let size = preferred, lines;
    do { ctx.font = `750 ${size}px ${FONT}`; lines = filmTextLines(text, (s) => ctx.measureText(s).width, width); if (lines.length <= maxLines || size <= min) break; size -= 2; } while (true);
    // 아주 긴 자막은 시간에 따라 이어 읽을 수 있게 draw()에서 페이지를 고릅니다.
    return { size, lines, draw: (shown, top = y) => shown.forEach((s, i) => label(s, 270, top + i * size * 1.4, size, color, 750)) };
  };
  function draw(scene, seconds = 0, playing = false) {
    if (!scene) return;
    const time = Math.max(0, Math.min(seconds, scene.seconds || 0));
    const { cue, active, people } = filmSpeakers(cast, scene, time);
    ctx.fillStyle = COLOR.ink; ctx.fillRect(0, 0, 540, 960);
    label("가치타", 270, 48, 23, COLOR.mint, 800);
    const heading = block(scene.label || title, 106, 456, 44, 24, 4);
    heading.draw(heading.lines, heading.lines.length === 1 ? 145 : heading.lines.length > 3 ? 94 : 106);
    // 차창·지붕·좌석은 코드로 그린 자체 배경입니다. 다른 영상의 프레임을 사용하지 않습니다.
    ctx.save(); ctx.beginPath(); ctx.roundRect(20, 258, 500, 402, 26); ctx.clip();
    ctx.fillStyle = COLOR.soft; ctx.fillRect(20, 258, 500, 402);
    ctx.fillStyle = "#a6c5af"; ctx.beginPath(); ctx.moveTo(0, 393);
    for (let x = 0; x <= 560; x += 20) ctx.lineTo(x, 370 + Math.sin(x / 95 + time * .17) * 23);
    ctx.lineTo(560, 470); ctx.lineTo(0, 470); ctx.fill();
    ctx.fillStyle = COLOR.dark; ctx.fillRect(20, 258, 500, 36);
    ctx.beginPath(); ctx.moveTo(20, 274); ctx.lineTo(56, 294); ctx.lineTo(77, 466); ctx.lineTo(20, 472); ctx.fill();
    ctx.beginPath(); ctx.moveTo(520, 274); ctx.lineTo(484, 294); ctx.lineTo(463, 466); ctx.lineTo(520, 472); ctx.fill();
    round(217, 284, 106, 25, 9, COLOR.ink); round(226, 290, 88, 11, 5, COLOR.seat);
    people.forEach((person, i) => {
      const x = i === 0 ? 38 : 286;
      round(x + 30, 331, 158, 92, 35, COLOR.seatLine);
      round(x, 390, 216, 280, 48, COLOR.seat);
      round(x + 10, 401, 196, 240, 42, "#e4e0d6");
      const speaking = Boolean(cue && person === active);
      const key = personCharacter(person), record = images.get(key);
      if (!record) { load(key); return; }
      if (record.loaded) {
        const small = key.endsWith("-small");
        const box = { x: x - 4, y: small ? 390 : 352, width: 224, height: small ? 254 : 292 };
        const bounds = record.geometry.bounds;
        const fit = fitContain(bounds.width, bounds.height, box);
        const center = fit.x + fit.width / 2, foot = fit.y + fit.height;
        const bob = playing ? speaking ? Math.sin(time * 14) * 3.2 : Math.sin(time * 3 + i) * 1.2 : 0;
        ctx.save(); ctx.translate(center, foot + bob); ctx.rotate(playing ? Math.sin(time * (speaking ? 8 : 2) + i) * (speaking ? .012 : .004) : 0);
        ctx.drawImage(record.img, bounds.x, bounds.y, bounds.width, bounds.height, fit.x - center, fit.y - foot, fit.width, fit.height);
        if (speaking && playing && record.geometry.mouth) {
          const mouth = record.geometry.mouth, scale = fit.width / bounds.width;
          const mx = fit.x - center + (mouth.x - bounds.x) * scale, my = fit.y - foot + (mouth.y - bounds.y) * scale;
          const mw = mouth.width * scale, mh = mouth.height * scale;
          ctx.fillStyle = mouth.fill; ctx.beginPath(); ctx.ellipse(mx, my, mw * .8 + 1, mh + 3, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#111210"; ctx.beginPath(); ctx.ellipse(mx, my, Math.max(2, mw * .49), Math.max(1.2, mh * (.35 + Math.abs(Math.sin(time * 17)) * .8)), 0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        // 원본 몸 전체를 유지하고 말의 리듬을 입과 반응선으로 보여 줍니다.
        if (speaking && playing) {
          ctx.strokeStyle = COLOR.mint; ctx.lineWidth = 4; ctx.lineCap = "round";
          for (let k = 0; k < 3; k++) { const rise = 4 + Math.abs(Math.sin(time * 12 + k)) * 11; ctx.beginPath(); ctx.moveTo(x + 174 + k * 10, 354 - rise); ctx.lineTo(x + 174 + k * 10, 354 + rise); ctx.stroke(); }
        }
      }
      round(x + 21, 616, 174, 32, 16, speaking ? COLOR.mint : COLOR.dark);
      label(person.name || "동승자", x + 108, 632, 18, speaking ? COLOR.ink : COLOR.paper, 700);
    });
    ctx.restore();
    const speakerName = cue ? active?.name || "말한 사람 미확인" : "함께 나눈 이야기";
    label(speakerName, 270, 704, 23, COLOR.mint, 700);
    const caption = block(cue?.text || (playing ? "" : "재생을 눌러 그 순간을 만나 보세요"), 756, 460, 35, 23, 3);
    const pages = Math.max(1, Math.ceil(caption.lines.length / 3));
    const page = cue ? Math.min(pages - 1, Math.floor((time - cue.start) / Math.max(.01, cue.end - cue.start) * pages)) : 0;
    caption.draw(caption.lines.slice(page * 3, page * 3 + 3));
    label("우리의 목소리로 남긴 순간", 270, 912, 20, COLOR.muted, 500);
    ctx.fillStyle = COLOR.mint; ctx.fillRect(44, 946, 452 * (scene.seconds ? time / scene.seconds : 0), 3);
  }
  return { canvas, ready, draw, dispose: () => { images.clear(); canvas.width = 0; canvas.height = 0; } };
}

// 현재 장면 전체를 실제 재생 시간 동안 녹화합니다. 파일 공유는 이 함수가 하지 않습니다.
export async function exportShortFilm({ title, cast, scene, getAudio, signal, canRead, checkAccess, onProgress = () => {} }) {
  const format = recordingFormat();
  const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!format || !AudioContextClass || !HTMLCanvasElement.prototype.captureStream) throw new Error("이 브라우저는 영상 만들기를 지원하지 않아요.");
  const context = new AudioContextClass();
  // 사용자 클릭의 활성 상태 안에서 먼저 오디오 컨텍스트를 엽니다.
  const resumed = context.resume();
  const film = createShortFilm({ title, cast });
  let source, stream, canvasStream, destination, recorder, frame, clock, heartbeat, checking = false;
  let finished = false, stopRecording;
  const chunks = [];
  const assertAccess = () => { if (signal.aborted || !canRead()) throw new DOMException("영상 만들기를 취소했어요.", "AbortError"); };
  const waiting = (promise) => new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException("영상 만들기를 취소했어요.", "AbortError"));
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
  const abort = () => stopRecording?.(new DOMException("영상 만들기를 취소했어요.", "AbortError"));
  const hidden = () => { if (document.hidden) stopRecording?.(new Error("화면을 벗어나 영상 만들기를 멈췄어요. 다시 시작해 주세요.")); };
  try {
    signal.addEventListener("abort", abort, { once: true });
    document.addEventListener("visibilitychange", hidden);
    assertAccess();
    await waiting(resumed);
    await waiting(checkAccess(signal));
    const bytes = await waiting(getAudio(signal));
    assertAccess();
    const buffer = await waiting(context.decodeAudioData(bytes));
    await waiting(film.ready);
    await waiting(document.fonts?.ready ?? Promise.resolve());
    assertAccess();
    const duration = Math.min(buffer.duration, scene.seconds);
    if (!(duration > 0) || !Number.isFinite(duration)) throw new Error("장면 소리를 읽지 못했어요.");
    film.draw(scene, 0, true);
    canvasStream = film.canvas.captureStream(30);
    destination = context.createMediaStreamDestination();
    source = context.createBufferSource(); source.buffer = buffer; source.connect(destination); source.connect(context.destination);
    stream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
    if (!stream.getAudioTracks().length) throw new Error("영상에 소리를 연결하지 못했어요.");
    recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
    const recorded = new Promise((resolve, reject) => {
      let problem = null;
      stopRecording = (error) => {
        if (finished) return; finished = true; problem = error ?? null;
        try { source.stop(); } catch {}
        if (recorder.state !== "inactive") recorder.stop(); else error ? reject(error) : resolve();
      };
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => stopRecording(new Error("영상을 만드는 중 오류가 났어요. 다시 시도해 주세요."));
      recorder.onstop = () => problem ? reject(problem) : resolve();
    });
    recorder.start(250);
    const begun = context.currentTime;
    const paint = () => {
      if (finished) return;
      try { assertAccess(); } catch (error) { stopRecording(error); return; }
      const time = Math.min(duration, context.currentTime - begun);
      film.draw(scene, time, true); onProgress(time / duration);
      frame = requestAnimationFrame(paint);
    };
    // rAF가 지연되어도 권한·취소·종료는 별도로 확인합니다.
    clock = setInterval(() => { try { assertAccess(); if (context.currentTime - begun >= duration) stopRecording(); } catch (error) { stopRecording(error); } }, 100);
    heartbeat = setInterval(async () => {
      if (checking || finished) return; checking = true;
      try { await checkAccess(signal); assertAccess(); } catch (error) { stopRecording(error); } finally { checking = false; }
    }, 2000);
    source.onended = () => stopRecording();
    source.start(0, 0, duration); paint();
    await recorded;
    assertAccess();
    await waiting(checkAccess(signal));
    assertAccess();
    const mime = recorder.mimeType || format.mime;
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error("영상 파일이 비어 있어요. 다시 만들어 주세요.");
    const extension = mime.startsWith("video/mp4") ? "mp4" : "webm";
    const safeTitle = String(scene.label || title || "가치타-쇼츠").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 60);
    return new File([blob], `${safeTitle}.${extension}`, { type: mime });
  } finally {
    finished = true; cancelAnimationFrame(frame); clearInterval(clock); clearInterval(heartbeat);
    signal.removeEventListener("abort", abort); document.removeEventListener("visibilitychange", hidden);
    try { source?.stop(); } catch {}
    if (recorder?.state !== "inactive" && recorder?.state) recorder.stop();
    source?.disconnect(); destination?.disconnect(); stream?.getTracks().forEach((track) => track.stop()); canvasStream?.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => {}); film.dispose(); chunks.length = 0;
  }
}
