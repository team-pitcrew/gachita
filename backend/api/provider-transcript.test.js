import assert from "node:assert/strict";
import { test } from "node:test";
import { providerTranscript } from "./providers/transcript.js";
import { cues } from "./scenes.js";

test("공급자가 준 익명 화자·양끝 시각과 겹치는 발화를 보존합니다", () => {
  const raw = "<spk:0> 00:00.00 같이 출발할까요? 00:01.82 <spk:1> 00:01.78 네, 좋아요. 00:03.10 <spk:0> 00:03.20 00:01.23라고 적혀 있네요. 00:05.00";
  const result = providerTranscript(raw, 7.5);
  assert.deepEqual(result, { text: "같이 출발할까요? 네, 좋아요. 00:01.23라고 적혀 있네요.", providerText: raw,
    segments: [
      { start: 0, end: 1.82, text: "같이 출발할까요?", speakerLabel: "spk:0" },
      { start: 1.78, end: 3.1, text: "네, 좋아요.", speakerLabel: "spk:1" },
      { start: 3.2, end: 5, text: "00:01.23라고 적혀 있네요.", speakerLabel: "spk:0" },
    ], diarization: { status: "available" } });
});

test("태그나 시각이 없는 답에는 구간을 만들지 않습니다", () => {
  for (const [raw, text, reason] of [
    ["그냥 같이 가요.", "그냥 같이 가요.", "missing_speaker_tags"],
    ["<spk:0> 그냥 같이 가요. <spk:1> 네.", "그냥 같이 가요. 네.", "missing_timestamps"],
  ]) assert.deepEqual(providerTranscript(raw, 5), { text, providerText: raw, segments: null, diarization: { status: "unavailable", reason } });
});

test("잘못된 구간은 전부 무효로 표시하고 발화와 공급자 원문을 보존합니다", () => {
  for (const [raw, text, reason] of [
    ["<spk:0> 00:02.00 역전된 구간입니다. 00:01.00", "역전된 구간입니다.", "out_of_bounds"],
    ["<spk:0> 00:01.00 길이가 없습니다. 00:01.00", "길이가 없습니다.", "out_of_bounds"],
    ["<spk:0> 00:04.00 범위를 넘었습니다. 00:05.01", "범위를 넘었습니다.", "out_of_bounds"],
    ["<spk:0> 00:00.00 맞는 구간. 00:01.00 <spk:1> 끝 시각 없음", "맞는 구간. 끝 시각 없음", "malformed_segment"],
    ["<spk:0> 00:00.00 시작만 있습니다.", "시작만 있습니다.", "malformed_segment"],
    ["<spk:0> 00:00.00 00:01.00", "", "empty_segment"],
    ["<spk:이름> 00:00.00 이름을 추정하지 않습니다. 00:01.00", "이름을 추정하지 않습니다.", "invalid_speaker_label"],
    ["누락되면 안 되는 앞 문장. <spk:0> 00:00.00 다음 문장. 00:01.00", "누락되면 안 되는 앞 문장. 다음 문장.", "unexpected_text"],
    ["<spk:0> 00:60.00 잘못된 시각. 00:61.00", "잘못된 시각.", "out_of_bounds"],
  ]) {
    const result = providerTranscript(raw, 5);
    assert.equal(result.providerText, raw);
    assert.equal(result.text, text);
    assert.equal(result.segments, null);
    assert.deepEqual(result.diarization, { status: reason === "missing_timestamps" ? "unavailable" : "invalid", reason });
  }
});

test("자막은 실제 끝 시각·겹침·클립 이전에 시작한 구간을 보존합니다", () => {
  const scope = "b3cbb470-177d-4567-bf6e-d07e50faf424";
  const result = cues([
    { at: 1000, endAt: 2500, text: "앞에서 시작한 말", speakerLabel: "spk:0", speakerScope: scope },
    { at: 1800, endAt: 3200, text: "겹치는 말", speakerLabel: "spk:1", speakerScope: scope },
    { at: 2900, endAt: 4500, text: "끝에서 이어지는 말", speakerLabel: "spk:0", speakerScope: scope },
  ], 1500, 2);
  assert.deepEqual(result.map(({ start, end, endAt, speakerLabel, speakerScope }) => ({ start, end, endAt, speakerLabel, speakerScope })), [
    { start: 0, end: 1, endAt: 2500, speakerLabel: "spk:0", speakerScope: scope },
    { start: 0.3, end: 1.7, endAt: 3200, speakerLabel: "spk:1", speakerScope: scope },
    { start: 1.4, end: 2, endAt: 4500, speakerLabel: "spk:0", speakerScope: scope },
  ]);
  assert.ok(result.every((cue) => cue.participantId === null && cue.profileId === null));
});
