import assert from "node:assert/strict";
import { test } from "node:test";
import { createProfileMenu, currentGroup, forgetIdentity } from "./profile-menu.js";

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

test("내 얼굴 단추는 프로필이 없어도 늘 있고(빈 원형 + 기본 캐릭터), 누르면 로그인·계정 만들기로 간다", async () => {
  const el = (tag) => ({ tagName: tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, append(...k) { this.kids.push(...k); } });
  globalThis.document = { createElement: el };
  let profile = null;
  const went = [];
  const menu = createProfileMenu({ getProfile: () => profile, face: () => "얼굴", onSignIn: () => went.push("signIn"), onProfile: () => went.push("profile") });
  const guest = menu.button();
  assert.equal(guest.className, "me-button is-guest");
  assert.equal(guest.attrs["aria-label"], "로그인·계정 만들기");
  assert.deepEqual(guest.kids, ["얼굴"]);
  await guest.onclick();
  assert.deepEqual(went, ["signIn"]);
  profile = { name: "민준" };
  assert.equal(menu.button().className, "me-button");
  // 계정 토큰은 있는데 프로필을 다시 읽는 중이면 기본 얼굴(로그인 길)이 아니라 내 얼굴 자리 → 내 프로필로
  profile = null;
  const loading = createProfileMenu({ getProfile: () => null, signedIn: () => true, face: () => "얼굴", onSignIn: () => went.push("signIn"), onProfile: () => went.push("profile") });
  assert.equal(loading.button().className, "me-button");
  await loading.button().onclick();
  assert.deepEqual(went, ["signIn", "profile"]);
  delete globalThis.document;
});
