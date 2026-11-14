// 계정·온보딩(T142)의 단계 고르기와 화면 문장. 화면 그리기는 390×844 브라우저 확인(verification/20261115-F1)으로 본다.
import assert from "node:assert/strict";
import test from "node:test";
import { accountError, callName, firstStep, MIN_SECONDS, nextAfterAccount, provisionalName, VOICE_SECONDS } from "./onboarding.js";

test("처음 열 때: 토큰 없음 → 시작, 기기 프로필 → 계정 만들기, 동의 전 → 동의, 그 밖 → 프로필부터", () => {
  assert.equal(firstStep(null, false), "welcome");
  assert.equal(firstStep({ email: null, consent: false }, true), "signup");
  assert.equal(firstStep({ email: "a@b.co", consent: false }, true), "consent");
  assert.equal(firstStep({ email: "a@b.co", consent: true, hasVoice: false }, true), "profile");
  assert.equal(firstStep({ email: "a@b.co", consent: true, hasVoice: true }, true), "profile");
});

test("계정 뒤: 동의가 없으면 동의, 로그인했고 목소리까지 있으면 끝, 아니면 프로필", () => {
  assert.equal(nextAfterAccount({ consent: false, hasVoice: true }, "login"), "consent");
  assert.equal(nextAfterAccount({ consent: true, hasVoice: true }, "login"), null);
  assert.equal(nextAfterAccount({ consent: true, hasVoice: false }, "login"), "profile");
  assert.equal(nextAfterAccount({ consent: true, hasVoice: true }, "signup"), "profile");
});

test("읽을 문장의 이름 뒤 조사는 받침을 따른다", () => {
  assert.equal(callName("민준"), "민준이야");
  assert.equal(callName("하은"), "하은이야");
  assert.equal(callName("서아"), "서아야");
  assert.equal(callName("Jay"), "Jay이야");
});

test("가입 때 임시 이름은 이메일 앞부분 20자", () => {
  assert.equal(provisionalName("minjun@example.com"), "minjun");
  assert.equal(provisionalName("a".repeat(30) + "@x.io"), "a".repeat(20));
});

test("서버 오류를 화면 문장으로(로그인 실패는 어느 칸인지 말하지 않음)", () => {
  assert.equal(accountError({ status: 401, message: "" }, "login"), "이메일 또는 비밀번호가 맞지 않아요.");
  assert.equal(accountError({ status: 409, message: "" }, "signup"), "이미 가입한 이메일이에요. 로그인해 주세요.");
  assert.equal(accountError({ status: 400, message: "password: 글자 8~72자" }, "signup"), "비밀번호는 8~72자로 적어 주세요.");
  assert.equal(accountError({ status: 0, message: "" }, "signup"), "연결이 끊겨서 보내지 못했어요.");
});

test("녹음은 15초, '녹음 완료'는 5초부터(서버는 1~20초)", () => {
  assert.equal(VOICE_SECONDS, 15);
  assert.ok(MIN_SECONDS >= 1 && MIN_SECONDS < VOICE_SECONDS);
});

test("초대 링크로 들어온 이메일 계정은 동의·직접 정한 이름·목소리를 마쳐야 그룹에 참여한다", async () => {
  const { accountReady, provisionalOnly } = await import("./onboarding.js");
  const p = { email: "demo-mom-1115@example.com", name: "demo-mom-1115", consent: true, hasVoice: true };
  assert.equal(provisionalOnly(p), true, "가입 때의 임시 이름(이메일 앞부분)");
  assert.equal(accountReady(p), false);
  assert.equal(accountReady({ ...p, name: "엄마" }), true);
  assert.equal(accountReady({ ...p, name: "엄마", hasVoice: false }), false, "첫 프로필은 목소리 필수");
  assert.equal(accountReady({ ...p, name: "엄마", consent: false }), false);
  assert.equal(provisionalOnly({ email: null, name: "기기 프로필" }), false, "이메일 없는 기기 프로필은 해당 없음");
});
