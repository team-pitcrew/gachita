import assert from "node:assert/strict";
import test from "node:test";
import { shareOptions, shareExpired } from "./shares.js";

test("공유의 기한이 null이거나 없으면 만료하지 않고 명시한 유한 기한만 지킨다", () => {
  const now = Date.now();
  for (const item of [{}, { expiresAt: null }, { expiresAt: now + 1 }]) assert.equal(shareExpired(item, now), false);
  for (const expiresAt of [now, now - 1, 0]) assert.equal(shareExpired({ expiresAt }, now), true);
});

test("공개 여행 장면과 내 앨범의 교집합만 공유 대상으로 보여 준다", () => {
  const trip = { code: "TRIP01", moments: [{ id: "mine" }, { id: "others" }], participants: [] };
  // 앨범 응답(GET /profiles/me/moments?trip=)의 장면. 공개 여행에 없는 장면(old)과 다른 여행 것은 빠진다.
  const own = { id: "mine", tripCode: "TRIP01", at: 1, label: "내 장면" };
  const items = [own, { id: "old", tripCode: "TRIP01", at: 2 }, { id: "others", tripCode: "TRIP02", at: 3 }];
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

test("앨범 장면이 많아도 자르지 않는다(피드 100개 제한과 무관)", () => {
  const moments = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, tripCode: "TRIP01", at: i }));
  const trip = { code: "TRIP01", moments: moments.map(({ id }) => ({ id })), participants: [] };
  assert.equal(shareOptions(trip, moments, "self").moments.length, 150);
});
