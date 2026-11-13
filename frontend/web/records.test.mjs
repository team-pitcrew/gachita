import assert from "node:assert/strict";
import { test } from "node:test";
import { chosenMoment } from "./records.js";

test("후보를 확정할 때 선택 구간을 보존하고 표시용 대화·화자 정보는 보내지 않는다", () => {
  const candidate = { at: 2000, from: 1000, to: 16000, score: 7, why: "두 사람이 번갈아 말함", lines: [{ text: "개인적인 대화", profileId: "person" }], lat: 37.5, lng: 127.1 };
  assert.deepEqual(chosenMoment(candidate, "  휴게소에서 웃은 순간  "), { at: 2000, from: 1000, to: 16000, label: "휴게소에서 웃은 순간", lat: 37.5, lng: 127.1 });
});

test("위치가 없는 장면은 좌표를 만들지 않고, 비운 이름에는 기본값을 쓴다", () => {
  const candidate = { at: 2000, from: 1000, to: 16000, lat: null, lng: null };
  assert.deepEqual(chosenMoment(candidate, " "), { at: 2000, from: 1000, to: 16000, label: "함께 남긴 장면" });
  assert.equal("lat" in chosenMoment({ ...candidate, lat: 37.5 }, "장면"), false);
});
