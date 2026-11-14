import test from "node:test";
import assert from "node:assert/strict";
import { planShort } from "./short-templates.js";
import { subtitles } from "./short-render.js";
const source = () => ({
  generation: 1,
  title: "우리 여행",
  cast: [
    { participantId: "a", name: "가", character: "cap", seat: "ROW_1_LEFT" },
    {
      participantId: "b",
      name: "나",
      character: "glasses-small",
      seat: "ROW_1_RIGHT",
    },
  ],
  scenes: [
    {
      momentId: "m",
      seconds: 30.319,
      at: 1,
      label: "휴게소 농담",
      cues: [
        {
          start: 1,
          end: 2,
          text: "안녕",
          participantId: "a",
          device: "car",
          seq: 1,
          editVersion: 0,
        },
        {
          start: 4,
          end: 6,
          text: "하하하",
          participantId: "b",
          device: "car",
          seq: 2,
          editVersion: 0,
        },
      ],
    },
  ],
});
test("대화와 캐릭터는 고정하고 15~45초를 4~8초 장면 그림 단위로 나눕니다", () => {
  for (const seconds of [15, 30.319, 45]) {
    const s = source();
    s.scenes[0].seconds = seconds;
    const p = planShort(s);
    assert.equal(p.shots[0].start, 0);
    assert.equal(p.shots.at(-1).end, seconds);
    assert.ok(
      p.shots.every(
        (x) => x.generationSeconds >= 4 && x.generationSeconds <= 8,
      ),
    );
    assert.deepEqual(
      p.cast.map((x) => x.character),
      ["cap", "glasses-small"],
    );
    assert.equal(p.planHash, planShort(s, p).planHash);
  }
  const s = source();
  s.scenes[0].seconds = 46;
  assert.throws(
    () => planShort(s),
    (e) => e.status === 409,
  );
});
test("미확인 화자를 실명으로 추측하지 않고 수정된 자막은 새 제작 계획이 됩니다", () => {
  const s = source();
  s.scenes[0].cues.forEach((x) => (x.participantId = null));
  const p = planShort(s);
  assert.deepEqual(
    p.cast.map((x) => x.participantId),
    [null, null],
  );
  assert.deepEqual(
    p.cast.map((x) => x.character),
    ["basic", "basic-small"],
  );
  assert.ok(p.cues.every((x) => x.slot === null));
  const before = p.planHash;
  s.scenes[0].cues[0].text = "다른 대화";
  assert.notEqual(planShort(s).planHash, before);
  // 원음은 외부 생성으로 보내지 않는다(ADR-0025). 옛 앱의 false는 받는다.
  assert.throws(() => planShort(s, { audioReference: true }), (e) => e.status === 400);
  assert.equal(planShort(s, { audioReference: false }).audioReference, false);
  assert.ok(!p.externalData.some((x) => x.includes("원음")));
});
test("한국어 자막은 원문을 모두 유지하고 ASS 태그를 실행하지 않습니다", () => {
  const p = planShort(source());
  p.cues[0].text = "{\\pos(0,0)}" + "가".repeat(110);
  const ass = subtitles(p);
  assert.doesNotMatch(ass, /\{\\pos/);
  assert.equal((ass.match(/가/g) || []).length, 113);
  assert.match(ass, /Noto Sans CJK KR/);
});
