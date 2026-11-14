import assert from "node:assert/strict";
import { test } from "node:test";
import { currentGroup, forgetIdentity } from "./profile-menu.js";

// 브라우저 Storage와 같은 모양(length·key·removeItem)만 흉내 낸다.
const storage = (entries) => {
  const m = new Map(entries);
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
};

test("로그아웃은 이 폰의 가치타 신원(프로필 토큰, 여행별 참가자 id·토큰·표시)을 모두 지우고 다른 키는 둔다", () => {
  const s = storage([["gachita:profile", "t"], ["gachita:ABCD", "p1"], ["gachita:ABCD:token", "x"], ["gachita:ABCD:asked", "1"], ["gachita:trip", "ABCD"], ["other-app", "keep"]]);
  forgetIdentity(s, "gachita:");
  assert.deepEqual(s.keys(), ["other-app"]);
});

test("로그아웃은 차 화면 미리보기 접두어를 따로 쓸 때 그 접두어만 지운다", () => {
  const s = storage([["gachita:vehicle-view:profile", "t"], ["gachita:profile", "phone"]]);
  forgetIdentity(s, "gachita:vehicle-view:");
  assert.deepEqual(s.keys(), ["gachita:profile"]);
});

test("드롭다운의 현재 동승 그룹은 가족이 먼저, 없으면 첫 그룹, 없으면 없음", () => {
  assert.equal(currentGroup([{ kind: "guest", name: "바다" }, { kind: "family", name: "우리 가족" }]).name, "우리 가족");
  assert.equal(currentGroup([{ kind: "guest", name: "바다" }]).name, "바다");
  assert.equal(currentGroup([]), null);
  assert.equal(currentGroup(undefined), null);
});
