// 숏폼 자막 큐 규칙의 공유 시험 벡터(T125 voice-vectors.json 방식). 차량 앱이 재생에 쓰는 큐를 같은 규칙(scenes.js cues)으로
// 차 안에서 계산하므로, 이 시험은 scenes.js가 파일과 같은 큐를 내는지, 차량 단위 시험은 Kotlin 구현이 같은 큐를 내는지 본다.
// 규칙을 고쳤으면 `UPDATE_CUE_VECTORS=1 node --test cue-vectors.test.js`로 파일을 다시 만들고 차량 구현도 같이 고친다.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { cues } from "./scenes.js";

const FILE = new URL("cue-vectors.json", import.meta.url);
const T0 = 1_763_000_000_000;
const line = (seq, at, text, more = {}) => ({ device: "car", seq, at: T0 + at, text, ...more });

const INPUTS = [
  { name: "글자 수로 어림(글자당 0.15초, 1~6초), 다음 발화에서 자르되 1초는 남김", startAt: T0, seconds: 20,
    lines: [line(1, 1000, "응"), line(2, 3000, "바다가 보인다 진짜 넓다 와 저기 배도 있어 봐봐 정말 크다"), line(3, 3500, "어디?"), line(4, 12_000, "저기 저 끝에")] },
  { name: "끝 시각이 있으면 그대로, 겹침 보존", startAt: T0, seconds: 10,
    lines: [line(1, 1000, "같이 말해", { endAt: T0 + 4000 }), line(2, 2000, "나도", { endAt: T0 + 3000 })] },
  { name: "클립보다 먼저 시작해 겹치는 실제 구간은 넣고, 끝 시각 없는 앞 발화는 뺌", startAt: T0 + 5000, seconds: 5,
    lines: [line(1, 0, "앞에서 끝남"), line(2, 1000, "길게 말함", { endAt: T0 + 7000 }), line(3, 6000, "안쪽")] },
  { name: "클립 끝을 넘지 않음(소수 초 클립)", startAt: T0, seconds: 2.5,
    lines: [line(1, 1500, "끝에 걸친 말이 길다 아주 길다"), line(2, 2400, "막 끝남", { endAt: T0 + 9000 })] },
  { name: "글은 수동 수정 → 재전사 → 원문, 어림은 원문의 코드포인트 수", startAt: T0, seconds: 30,
    lines: [line(1, 1000, "원문", { displayText: "고친 글", asrText: "재전사" }), line(2, 9000, "원문2", { asrText: "재전사2" }), line(3, 17_000, "😀😀😀😀😀😀😀😀😀😀")] },
  { name: "클립 밖", startAt: T0 + 60_000, seconds: 10, lines: [line(1, 0, "한참 전"), line(2, 80_000, "한참 뒤")] },
];

const shape = (cs) => cs.map((c) => ({ seq: c.seq, start: c.start, end: c.end, text: c.text }));

if (process.env.UPDATE_CUE_VECTORS) {
  writeFileSync(FILE, JSON.stringify({
    rule: "scenes.js cues: 클립 구간(startAt부터 seconds초) 안의 발화를 자막으로. start·end는 클립 처음부터의 초(ms 반올림/1000). 끝 시각이 있으면 그것(클립 끝까지), 없으면 원문 코드포인트 수×0.15초(1~6초)를 다음 발화에서 자르되 1초는 남김",
    cases: INPUTS.map((c) => ({ ...c, expected: shape(cues(c.lines, c.startAt, c.seconds)) })),
  }, null, 1) + "\n");
}

test("숏폼 자막 큐: scenes.js가 시험 벡터 파일과 같은 큐를 낸다", () => {
  const { cases } = JSON.parse(readFileSync(FILE, "utf8"));
  assert.equal(cases.length, INPUTS.length);
  for (const c of cases) assert.deepEqual(shape(cues(c.lines, c.startAt, c.seconds)), c.expected, c.name);
  assert.equal(cases.at(-1).expected.length, 0);
});
