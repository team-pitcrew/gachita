import assert from "node:assert/strict";
import { test } from "node:test";
import { captionPatch, captionSelection } from "./captions.js";

test("자막 저장은 읽은 버전·동의 세대를 보존하고 원문·화자 정보를 보내지 않는다", () => {
  const row = { text: "원문", asrText: "자동", editedText: "수정", editVersion: 3, profileId: "speaker" };
  assert.deepEqual(captionPatch(row, "  새 자막  ", 7), { text: "새 자막", expectedVersion: 3, generation: 7 });
  assert.deepEqual(captionPatch(row, null, 7), { text: null, expectedVersion: 3, generation: 7 });
});

test("빈 자막·500자 초과·아직 버전 없는 응답은 저장하지 않는다", () => {
  assert.throws(() => captionPatch({ editVersion: 0 }, "  ", 1));
  assert.throws(() => captionPatch({ editVersion: 0 }, "a".repeat(501), 1));
  assert.throws(() => captionPatch({}, "자막", 1));
});

test("장면 자막은 기기와 순번이 모두 맞는 발화만 편집하고 원문과 버전을 보존한다", () => {
  const rows = [
    { device: "car-a", seq: 1, text: "첫 장면", editVersion: 3 },
    { device: "car-b", seq: 1, text: "다른 기기", editVersion: 7 },
    { device: "car-a", seq: 2, text: "다음 장면", editVersion: 9 },
  ];
  const selected = captionSelection(rows, [{ device: "car-a", seq: 1 }]);
  assert.deepEqual(selected, [rows[0]]);
  assert.equal(selected[0], rows[0]);
  assert.deepEqual(captionPatch(selected[0], "바꾼 자막", 2), { text: "바꾼 자막", expectedVersion: 3, generation: 2 });
  assert.equal(captionSelection(rows), rows);
  assert.deepEqual(captionSelection(rows, []), []);
});
