import assert from "node:assert/strict";
import test from "node:test";
import { shareOptions } from "./shares.js";

test("공개 여행 장면과 내 앨범의 교집합만 공유 대상으로 보여 준다", () => {
  const trip = { code: "TRIP01", moments: [{ id: "mine" }, { id: "others" }], participants: [] };
  const own = { kind: "moment", id: "mine", tripCode: "TRIP01", label: "내 장면" };
  const items = [own, { kind: "moment", id: "old", tripCode: "TRIP01" }, { kind: "moment", id: "others", tripCode: "TRIP02" }, { kind: "utterance", id: "others", tripCode: "TRIP01", text: "대화" }];
  assert.deepEqual(shareOptions(trip, items, "self").moments, [own]);
  assert.deepEqual(shareOptions(trip, [], "self").moments, [], "원본 앨범을 지운 뒤에는 공개 여행에 남아 있어도 고를 수 없음");
});

test("동의한 다른 프로필 참가자만 대상으로 남고, 철회하면 다음 읽기에서 빠진다", () => {
  const other = { id: "other-seat", profileId: "other", consent: true, name: "동승자" };
  const trip = { code: "TRIP01", moments: [], participants: [
    { id: "me", profileId: "self", consent: true },
    { id: "same-profile", profileId: "self", consent: true },
    { id: "guest", consent: true },
    { id: "off", profileId: "declined", consent: false }, other,
  ] };
  assert.deepEqual(shareOptions(trip, [], "self").recipients, [other]);
  other.consent = false;
  assert.deepEqual(shareOptions(trip, [], "self").recipients, []);
});
