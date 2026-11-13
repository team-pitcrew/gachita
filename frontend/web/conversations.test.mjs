import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationAccess, transcriptLines } from "./conversations.js";

const trip = { code: "TRIP01", generation: 2, createdAt: 1000 };
const person = { id: "person-1", consent: true };
const session = { code: trip.code, generation: 2, participantId: person.id };

test("녹취는 현재 여행의 동의한 참가자에게만 보이고 동의 세대·여행·참가자가 바뀌면 닫는다", () => {
  assert.equal(conversationAccess(session, trip, person, "participant-token", 2000), "");
  for (const [current, me, token] of [
    [null, person, "token"],
    [{ ...trip, code: "OTHER" }, person, "token"],
    [{ ...trip, generation: 3 }, person, "token"],
    [trip, { ...person, consent: false }, "token"],
    [trip, { ...person, id: "another" }, "token"],
    [trip, person, null],
  ]) assert.notEqual(conversationAccess(session, current, me, token, 2000), "");
});

test("오프라인이어도 여행 생성 48시간 경계부터 녹취를 표시하지 않는다", () => {
  const expiresAt = trip.createdAt + 48 * 3600 * 1000;
  assert.equal(conversationAccess(session, trip, person, "token", expiresAt - 1), "");
  assert.match(conversationAccess(session, trip, person, "token", expiresAt), /보관 기간/);
});

test("서버 표시 자막을 우선하고 삭제된 글을 빼며 시간순으로 보여 준다", () => {
  const data = { utterances: [
    { device: "car", seq: 3, at: 3000, text: "원문", displayText: "고친 자막", participantId: "known" },
    { device: "car", seq: 1, at: 1000, text: "이전 말", participantId: null, seatArea: "ROW_2_LEFT" },
    { device: "car", seq: 2, at: 2000, text: "삭제 이전 글", displayText: "" },
    { device: "car", seq: 4, at: 4000, text: "원문2", asrText: "재전사", editedText: "수동 수정" },
  ] };
  const lines = transcriptLines(data);
  assert.deepEqual(lines.map((line) => line.shown), ["이전 말", "고친 자막", "수동 수정"]);
  assert.equal(lines[0].participantId, null);
  assert.equal(data.utterances[0].text, "원문");
  assert.deepEqual(transcriptLines({ items: [{ text: "개인 피드는 녹취 전문이 아님" }] }), []);
});
