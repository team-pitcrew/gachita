import assert from "node:assert/strict";
import { test } from "node:test";
import { captionPatch } from "./captions.js";

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
