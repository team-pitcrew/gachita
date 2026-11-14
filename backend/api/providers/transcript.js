// Nemotron이 실제 반환한 <spk:N> MM:SS.xx 발화 MM:SS.xx 형식만 읽습니다.
// 시각이나 화자를 추정하지 않고, 잘못된 구간이 하나라도 있으면 구간 전체를 null로 돌려줍니다.
const TIME = "\\d{2,}:\\d{2}\\.\\d{2,3}";
const startTime = new RegExp(`^\\s*(${TIME})\\s+`);
const endTime = new RegExp(`\\s+(${TIME})\\s*$`);
const secondsOf = (value) => {
  const [minutes, seconds] = value.split(":").map(Number);
  return seconds < 60 ? minutes * 60 + seconds : NaN;
};

export function providerTranscript(providerText, seconds) {
  const tags = [...providerText.matchAll(/<spk:([^>]*)>/g)];
  if (!tags.length) return {
    text: providerText.trim(), providerText, segments: null,
    diarization: { status: "unavailable", reason: "missing_speaker_tags" },
  };
  const words = [], segments = [];
  const prefix = providerText.slice(0, tags[0].index).trim();
  let reason = prefix ? "unexpected_text" : null;
  let missing = 0, timed = 0;
  if (prefix) words.push(prefix);
  for (let i = 0; i < tags.length; i++) {
    const label = tags[i][1];
    const body = providerText.slice(tags[i].index + tags[i][0].length, tags[i + 1]?.index ?? providerText.length).trim();
    const first = startTime.exec(body), last = endTime.exec(body);
    // 형식이 깨져도 확인된 양끝 시각만 뺍니다. 문장 안의 숫자·시각 표현은 그대로 남깁니다.
    const from = first?.[0].length ?? 0, to = last?.index ?? body.length;
    const text = body.slice(from, Math.max(from, to)).trim();
    if (text) words.push(text);
    if (!/^\d{1,4}$/.test(label)) reason ??= "invalid_speaker_label";
    if (!first || !last) { missing++; if (first || last) timed++; continue; }
    timed++;
    const start = secondsOf(first[1]), end = secondsOf(last[1]);
    if (!text) reason ??= "empty_segment";
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > seconds) reason ??= "out_of_bounds";
    segments.push({ start, end, text, speakerLabel: `spk:${label}` });
  }
  if (missing) reason ??= timed ? "malformed_segment" : "missing_timestamps";
  return {
    text: words.join(" "), providerText, segments: reason ? null : segments,
    diarization: reason ? { status: reason === "missing_timestamps" ? "unavailable" : "invalid", reason } : { status: "available" },
  };
}
