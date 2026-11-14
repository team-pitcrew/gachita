// 장면 후보 규칙의 공유 시험 벡터(T125 voice-vectors.json 방식). 차량 앱(Scenes.kt)이 같은 규칙으로 자기 보관함에서 후보를 고르므로,
// 이 시험은 scenes.js가 파일과 같은 후보를 내는지, 차량 단위 시험(ScenesTest.kt)은 Kotlin 구현이 같은 파일의 후보를 내는지 본다.
// 규칙을 고쳤으면 `UPDATE_SCENE_VECTORS=1 node --test scene-vectors.test.js`로 파일을 다시 만들고 Scenes.kt도 같이 고친다.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { suggest } from "./scenes.js";

const FILE = new URL("scene-vectors.json", import.meta.url);
const T0 = 1_763_000_000_000;

// 발화 n개를 step 밀리초 간격으로. who(k)는 k번째 발화의 말한 사람({ seatArea } | { profileId } | {}).
const burst = (start, n, step, who = () => ({}), seq0 = 0) =>
  Array.from({ length: n }, (_, k) => ({ seq: seq0 + k, at: start + k * step, text: `말 ${seq0 + k}`, ...who(k) }));

const INPUTS = [
  { name: "앞뒤 줄이 번갈아 말함, 위치 있음", lines: burst(T0, 8, 3000, (k) => ({ seatArea: k % 2 ? "rear" : "front", ...(k === 2 ? { lat: 37.75, lng: 128.9 } : {}) })), moments: [] },
  { name: "구역 없이 프로필만", lines: burst(T0, 5, 4000, (k) => ({ profileId: k % 2 ? "p2" : "p1" })), moments: [] },
  { name: "말한 사람 모름(2점 깎임)", lines: burst(T0, 6, 2000), moments: [] },
  { name: "4줄 미만은 후보 아님", lines: burst(T0, 3, 1000, () => ({ seatArea: "front" })), moments: [] },
  { name: "구간 없는 장면·구간 있는 장면과 겹치지 않음", lines: [...burst(T0, 6, 2000, () => ({ seatArea: "front" })), ...burst(T0 + 120_000, 6, 2000, () => ({ seatArea: "rear" }), 6), ...burst(T0 + 240_000, 6, 2000, (k) => ({ seatArea: k % 2 ? "rear" : "front" }), 12)],
    moments: [{ at: T0 + 5000 }, { at: T0 + 200_000, from: T0 + 230_000, to: T0 + 245_000 }] },
  { name: "후보는 다섯까지, 점수 순으로 고르고 시각 순으로", lines: Array.from({ length: 7 }, (_, b) => burst(T0 + b * 60_000, 4 + (b % 3), 3000, (k) => ({ seatArea: k % 2 && b % 2 ? "rear" : "front" }), b * 10)).flat(), moments: [] },
];

const shape = (items) => items.map(({ lines, ...c }) => ({ ...c, lines: lines.map((u) => u.seq) }));

if (process.env.UPDATE_SCENE_VECTORS) {
  writeFileSync(FILE, JSON.stringify({
    rule: "scenes.js suggest: 30초 창, 4줄 이상, 15초 이상, 5개까지. 출력 lines는 발화 seq",
    cases: INPUTS.map((input) => ({ ...input, expected: shape(suggest(input.lines, input.moments)) })),
  }, null, 1) + "\n");
}

test("장면 후보: scenes.js가 시험 벡터 파일과 같은 후보를 낸다", () => {
  const { cases } = JSON.parse(readFileSync(FILE, "utf8"));
  assert.equal(cases.length, INPUTS.length);
  for (const c of cases) assert.deepEqual(shape(suggest(c.lines, c.moments)), c.expected, c.name);
  // 시험이 비지 않게: 위치·다섯 개 한도·겹침 제외가 실제로 나타난다.
  assert.ok(cases[0].expected[0].lat === 37.75);
  assert.equal(cases[3].expected.length, 0);
  assert.equal(cases[5].expected.length, 5);
});
