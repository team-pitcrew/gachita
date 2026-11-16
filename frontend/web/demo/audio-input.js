export const RATE = 16000;
export const LIMIT = RATE * 30 * 60;
export function wav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const str = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), true));
  return new Blob([buffer], { type: 'audio/wav' });
}

// 무음 0.45초에서 분리하고 긴 발화만 8초로 나눈다. 화자를 추정하지 않는다.
export function speechSegments(samples) {
  const hop = 320, minimum = RATE / 2, maximum = RATE * 8, quietLimit = RATE * .45;
  const segments = []; let start = -1, lastVoice = 0;
  for (let at = 0; at < samples.length; at += hop) {
    const end = Math.min(samples.length, at + hop);
    let power = 0; for (let i = at; i < end; i++) power += samples[i] ** 2;
    const voiced = Math.sqrt(power / (end - at)) > .008;
    if (voiced) { if (start < 0) start = Math.max(0, at - RATE * .12); lastVoice = end; }
    if (start >= 0 && (end - start >= maximum || (!voiced && end - lastVoice >= quietLimit) || end === samples.length)) {
      const stop = Math.min(samples.length, start + maximum, Math.max(start + minimum, lastVoice + RATE * .15));
      segments.push({ start, end: stop }); start = -1;
    }
  }
  return segments.filter((part) => part.end - part.start >= minimum);
}

export async function decodeInput(file) {
  if (file.size > 128 * 1024 * 1024) throw new Error('128MB 이하의 영상·음성 구간을 골라 주세요.');
  const decoder = new OfflineAudioContext(1, 1, RATE);
  let buffer;
  try { buffer = await decoder.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new Error('이 파일의 소리를 읽지 못했어요. WAV·MP3·MP4 파일을 골라 주세요.'); }
  if (buffer.duration < .5 || buffer.duration > LIMIT / RATE) throw new Error('0.5초에서 30분 사이의 영상·음성을 골라 주세요.');
  const samples = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] += data[i] / buffer.numberOfChannels;
  }
  return samples;
}

export async function microphone(onSamples, onEnded) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  let context, source, node, gain, stopped = false;
  const stop = () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); node?.disconnect(); source?.disconnect(); gain?.disconnect(); context?.close().catch(() => {}); };
  try {
    context = new AudioContext({ sampleRate: RATE });
    if (context.sampleRate !== RATE) throw new Error('이 브라우저는 16kHz 마이크 입력을 지원하지 않아요. 음성 파일을 선택해 주세요.');
    await context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    node = new AudioWorkletNode(context, 'gachita-pcm');
    node.port.onmessage = (event) => { if (!stopped) onSamples(event.data); };
    source = context.createMediaStreamSource(stream); gain = context.createGain(); gain.gain.value = 0;
    source.connect(node); node.connect(gain); gain.connect(context.destination);
    for (const track of stream.getTracks()) track.onended = () => { if (!stopped) { stop(); onEnded(); } };
    await context.resume();
    return { pause: () => context.suspend(), resume: () => context.resume(), stop };
  } catch (error) { stop(); throw error; }
}
