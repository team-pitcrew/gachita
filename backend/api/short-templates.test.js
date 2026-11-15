import test from "node:test";
import assert from "node:assert/strict";
import { planShort, fixedCharacter } from "./short-templates.js";
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
  // 같이 탄 사람의 캐릭터는 나오지만, 대조되지 않은 줄을 누구에게도 붙이지 않는다(자막 '화자 미확인').
  assert.deepEqual(
    p.cast.map((x) => x.character),
    ["cap", "glasses-small"],
  );
  assert.ok(p.cues.every((x) => x.slot === null));
  assert.deepEqual(planShort({ ...s, cast: [] }).cast.map((x) => [x.participantId, x.character]), [[null, "basic"], [null, "basic-small"]]);
  const before = p.planHash;
  // 재전사가 글만 바꾸면(끝 시각도 따라 바뀜) 같은 계획이다. 사람이 고치면(editVersion) 새 계획이다.
  s.scenes[0].cues[0].text = "다시 받아 적은 조금 더 긴 대화";
  s.scenes[0].cues[0].end = 3.5;
  assert.equal(planShort(s).planHash, before);
  assert.equal(planShort(s).cues[0].text, "다시 받아 적은 조금 더 긴 대화");
  s.scenes[0].cues[0].editVersion = 1;
  assert.notEqual(planShort(s).planHash, before);
  // 원음은 외부 생성으로 보내지 않는다(ADR-0025). 옛 앱의 false는 받는다.
  assert.throws(() => planShort(s, { audioReference: true }), (e) => e.status === 400);
  assert.equal(planShort(s, { audioReference: false }).audioReference, false);
  assert.ok(!p.externalData.some((x) => x.includes("원음")));
});
test("가족 넷이 말하면 많이 말한 순서로 네 캐릭터가 모두 나옵니다", () => {
  const s = source();
  s.cast.push(
    { participantId: "c", name: "다", character: "pet", seat: "ROW_2_LEFT" },
    { participantId: "d", name: "라", character: "travel-small", seat: "ROW_2_RIGHT" },
    { participantId: "e", name: "마", character: "office", seat: null },
  );
  const say = (participantId, start) => ({ start, end: start + 1, text: "말", participantId, device: "car", seq: start, editVersion: 0 });
  s.scenes[0].cues.push(say("c", 7), say("c", 8), say("c", 9), say("d", 10), say("d", 11), say("e", 12));
  const p = planShort(s);
  assert.deepEqual(p.cast.map((x) => [x.slot, x.participantId]), [[0, "c"], [1, "d"], [2, "a"], [3, "b"]]);
  assert.equal(p.cues.find((x) => x.participantId === "e").slot, null, "다섯째는 캐릭터 없이 화면 밖 목소리");
});
test("한 사람만 대조돼도 같이 탄 네 사람의 캐릭터가 모두 나오고 말은 그 사람에게만 붙습니다", () => {
  const s = source();
  s.cast.push({ participantId: "c", name: "다", character: "pet", seat: "ROW_2_LEFT" }, { participantId: "d", name: "라", character: "healing", seat: "ROW_2_RIGHT" });
  s.scenes[0].cues[0].participantId = "d";
  s.scenes[0].cues[1].participantId = null;
  const p = planShort(s);
  assert.deepEqual(p.cast.map((x) => x.participantId), ["d", "a", "b", "c"]);
  assert.deepEqual(p.cues.map((x) => x.slot), [0, null]);
});
test("사람과 캐릭터의 짝은 말한 순서·장면과 무관하게 고정입니다", () => {
  const s = source();
  s.cast[1].character = ""; // 나: 프로필 캐릭터 없음
  const first = planShort(s).cast.find((x) => x.participantId === "b").character;
  s.scenes[0].cues.reverse().forEach((c) => (c.participantId = "b")); // 이번엔 나만 말함 → slot 0
  const second = planShort(s).cast.find((x) => x.participantId === "b");
  assert.equal(second.slot, 0);
  assert.equal(second.character, first, "slot이 바뀌어도 같은 캐릭터");
  assert.equal(fixedCharacter({ name: "나", character: "" }), first, "다른 여행에서도 이름이 같으면 같은 캐릭터");
  assert.equal(fixedCharacter({ name: "가", character: "cap" }), "cap", "프로필 캐릭터가 있으면 그대로");
  assert.equal(fixedCharacter({ name: "", character: "" }), null);
});
test("한국어 자막은 원문을 모두 유지하고 ASS 태그를 실행하지 않습니다", () => {
  const p = planShort(source());
  p.cues[0].text = "{\\pos(0,0)}" + "가".repeat(110);
  const ass = subtitles(p);
  assert.doesNotMatch(ass, /\{\\pos/);
  assert.equal((ass.match(/가/g) || []).length, 113);
  assert.match(ass, /Noto Sans CJK KR/);
});
test("자막은 낱말 경계에서 줄을 바꾸고 문장부호만 남은 줄을 만들지 않습니다", () => {
  const p = planShort(source());
  p.title = "같이 간 다음에 부산 가는 거예요 부산";
  p.cues[0].text = "이게 근데 우리 지금 다 긴장해야 돼요. 우리도 다 진짜. 우리도 돌아가는 길에 당하는 거 아니야?";
  p.cues[1].text = "했는데 해서 이제 바로 출발하는 거죠.";
  const texts = subtitles(p).split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => l.split(",,0,0,0,,")[1]);
  const lines = texts.flatMap((t) => t.split("\\N"));
  assert.ok(lines.every((l) => /[가-힣A-Za-z0-9]/.test(l)), "글자 없는 줄(문장부호만)이 없다");
  assert.ok(lines.every((l) => [...l].length <= 20));
  const words = p.cues[0].text.split(" ");
  const shown = texts.filter((t) => t.startsWith("가\\N")).flatMap((t) => t.split("\\N").slice(1)).join(" ").split(" ");
  assert.deepEqual(shown.slice(0, words.length), words, "낱말이 갈리지 않고 순서대로 남는다");
});

