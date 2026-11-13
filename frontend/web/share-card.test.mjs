import assert from "node:assert/strict";
import test from "node:test";
import { shareCardText, wrapCardText } from "./share-card.js";

test("다운로드에는 선택한 내용만 넣고 계정·여행·토큰·수신자·소리를 옮기지 않는다", () => {
  const item = { label: "바다에서", caption: "우리 함께\n즐거운 시간", at: 1, sender: { name: "보낸 사람" }, recipients: [{ name: "다른 동승자" }], tripCode: "ABC123", participantToken: "private-token", audioUrl: "private-audio", expiresAt: 2 };
  const card = shareCardText(item);
  assert.deepEqual(Object.keys(card).sort(), ["caption", "location", "time", "title"]);
  assert.equal(card.title, "바다에서");
  assert.equal(card.caption, "우리 함께 즐거운 시간");
  assert.equal(card.location, "");
  assert.equal(shareCardText({ ...item, lat: 37.5, lng: 127 }).location, "37.50000, 127.00000");
});

test("공백 없는 500자와 결합 이모지도 글자 손실 없이 카드 폭 안에 나눈다", () => {
  const message = "함께".repeat(250);
  const measure = (s) => [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(s)].length * 10;
  const lines = wrapCardText(message, measure, 180);
  assert.equal(lines.join(""), message);
  assert.ok(lines.every((line) => measure(line) <= 180));
  assert.deepEqual(wrapCardText("가족👨‍👩‍👧‍👦여행", measure, 30), ["가족👨‍👩‍👧‍👦", "여행"]);
});
