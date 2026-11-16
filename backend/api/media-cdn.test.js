// 실행: 저장소 루트에서 make check. CloudFront 서명(providers/media-cdn.js)의 형식과 꺼짐 동작.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, test } from "node:test";
import { mediaBase, mediaFields, signMedia } from "./providers/media-cdn.js";
import { captureLog } from "./log.js";

captureLog(() => {}); // 잘못된 키 시험의 경고를 출력에 섞지 않는다

// 시험마다 새로 만든 키로 서명하고 짝인 공개 키로 검증한다(저장소에 개인 키를 두지 않는다).
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const on = (extra = {}) => Object.assign(process.env, { MEDIA_CDN_BASE: "https://media.example.test/", MEDIA_KEY_PAIR_ID: "K2TESTKEYPAIR", MEDIA_PRIVATE_KEY: PEM, ...extra });
afterEach(() => { for (const k of ["MEDIA_CDN_BASE", "MEDIA_KEY_PAIR_ID", "MEDIA_PRIVATE_KEY"]) delete process.env[k]; });
const NOW = Date.UTC(2026, 10, 16, 3, 2, 10); // 구간 중간

test("값 셋 중 하나라도 없으면 서명도 필드도 없다", () => {
  assert.equal(signMedia("shorts/a/final.mp4"), null);
  assert.deepEqual(mediaFields("shorts/a/final.mp4"), {});
  assert.equal(mediaBase(), null);
  for (const missing of ["MEDIA_CDN_BASE", "MEDIA_KEY_PAIR_ID", "MEDIA_PRIVATE_KEY"]) {
    on();
    delete process.env[missing];
    assert.equal(signMedia("shorts/a/final.mp4"), null, `${missing} 없음`);
    assert.equal(mediaBase(), null);
  }
});

test("canned policy 서명: 정책 글을 RSA-SHA1로 서명해 CloudFront 치환을 한 값이고, 주소에 Expires·Signature·Key-Pair-Id가 붙는다", () => {
  on();
  const s = signMedia("shorts/0b1c/final.mp4", NOW);
  assert.equal(s.url, "https://media.example.test/shorts/0b1c/final.mp4", "끝의 /는 한 번만");
  assert.equal(s.keyPairId, "K2TESTKEYPAIR");
  assert.equal(s.expires % 300, 0, "만료는 5분 구간의 끝");
  const left = s.expires - NOW / 1000;
  assert.ok(left >= 600 && left <= 900, `남은 시간 10~15분: ${left}`);
  assert.match(s.signature, /^[A-Za-z0-9\-_~]+$/, "치환 뒤에는 +, =, /가 없다");
  const policy = `{"Statement":[{"Resource":"${s.url}","Condition":{"DateLessThan":{"AWS:EpochTime":${s.expires}}}}]}`;
  const raw = Buffer.from(s.signature.replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"), "base64");
  assert.ok(createVerify("RSA-SHA1").update(policy).verify(publicKey, raw), "공개 키로 검증된다");
  assert.equal(s.mediaUrl, `${s.url}?Expires=${s.expires}&Signature=${s.signature}&Key-Pair-Id=K2TESTKEYPAIR`);
});

test("같은 5분 구간에서는 같은 주소, 다음 구간에서는 다른 주소", () => {
  on();
  const a = signMedia("shorts/x/thumbnail.png", NOW), b = signMedia("shorts/x/thumbnail.png", NOW + 100_000), c = signMedia("shorts/x/thumbnail.png", NOW + 300_000);
  assert.equal(a.mediaUrl, b.mediaUrl);
  assert.notEqual(a.mediaUrl, c.mediaUrl);
  assert.equal(c.expires - a.expires, 300);
});

test("키의 마디는 주소로 옮길 때 인코딩하고, 필드 이름은 자리마다 붙인다", () => {
  on({ MEDIA_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") }); // 한 줄로 넣은 비밀 값
  const s = signMedia("profiles/p 1/photo/사진.png", NOW);
  assert.equal(s.url, `https://media.example.test/profiles/${encodeURIComponent("p 1")}/photo/${encodeURIComponent("사진.png")}`);
  const f = mediaFields("shorts/x/thumbnail.png", "thumbnailMedia", NOW);
  assert.deepEqual(Object.keys(f), ["thumbnailMediaUrl", "thumbnailMediaAuth"]);
  assert.deepEqual(Object.keys(f.thumbnailMediaAuth), ["url", "expires", "signature", "keyPairId"]);
  assert.deepEqual(mediaFields("", "media", NOW), {}, "키가 없으면 없음");
});

test("CDN이 내주지 않는 접두사(원음 클립, 기기 영상)는 서명하지 않는다", () => {
  on();
  for (const key of ["AB12CD/m1-9f3a.wav", "short-assets/AB12CD/a.mp4", "public/chars/basic.png", "shortsx/a.mp4"]) assert.equal(signMedia(key, NOW), null, key);
  for (const key of ["shorts/a/final.mp4", "shorts/a/thumbnail.png", "profiles/p/photo/0123456789abcdef.jpg"]) assert.ok(signMedia(key, NOW), key);
});

test("개인 키가 잘못된 환경은 던지지 않고 서명 없이 둔다", () => {
  on({ MEDIA_PRIVATE_KEY: "not-a-key" });
  assert.equal(signMedia("shorts/a/final.mp4", NOW), null);
  assert.deepEqual(mediaFields("shorts/a/final.mp4", "media", NOW), {});
});
