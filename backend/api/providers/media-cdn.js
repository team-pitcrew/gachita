// 미디어(쇼츠·표지·프로필 사진)를 CloudFront 서명 주소로 내준다(ADR-0027, 길과 버킷 정책은 ADR-0026).
// 값 셋(MEDIA_CDN_BASE·MEDIA_KEY_PAIR_ID·MEDIA_PRIVATE_KEY)이 다 있을 때만 켜진다. 하나라도 없으면 아무 필드도 더하지 않는다 —
// 로컬·CI·시험과 인프라가 생기기 전의 운영은 지금처럼 API가 본문을 준다.
// 서명은 canned policy(객체 하나 + 만료 시각)이고 SDK 없이 Node crypto로 만든다:
// RSA-SHA1(정책 글) → base64 → CloudFront 치환(+ → -, = → _, / → ~).
// 누구에게 서명을 줄지는 부르는 쪽이 정한다 — 이 파일은 권한을 보지 않는다.
import { createSign } from "node:crypto";
import { errFields, log } from "../log.js";

// CDN이 버킷에서 읽을 수 있는 접두사만 서명한다(ADR-0026 1절의 버킷 정책: shorts/·profiles/·public/ — public/은 서명이 필요 없다).
// 원음 클립(여행 코드 아래)과 기기 영상(short-assets/)은 서명이 있어도 CDN에서 403이라 지금처럼 API로 받는다.
// 인프라가 접두사를 더 열면 여기에 더한다.
const SERVED = /^(shorts|profiles)\//;

// 만료 시각을 5분 구간으로 올린다: 같은 구간 안에서는 같은 주소가 나와 브라우저 캐시가 산다. 남은 시간은 10~15분.
const WINDOW = 300;

function config() {
  const base = process.env.MEDIA_CDN_BASE?.trim().replace(/\/+$/, "");
  const keyPairId = process.env.MEDIA_KEY_PAIR_ID?.trim();
  const key = process.env.MEDIA_PRIVATE_KEY?.trim();
  // 비밀 값을 한 줄로 넣은 환경(\n을 글자로 적음)도 받는다.
  return base && keyPairId && key ? { base, keyPairId, key: key.replace(/\\n/g, "\n") } : null;
}

export const mediaBase = () => config()?.base ?? null;

// ponytail: 프로세스 안의 작은 기억(키+만료 → 서명). 목록 하나에 서명이 수십 개라 같은 구간에서는 다시 계산하지 않는다.
const memo = new Map();
let memoKey = null; // 기억은 그 개인 키로 만든 서명만 담는다 — 키가 바뀌면 비운다

// 객체 키 하나의 서명. 꺼져 있거나 키가 없으면 null.
// url은 서명 없는 CDN 주소, mediaUrl은 주소에 서명을 붙인 것(폰 웹의 <video>·<img>), 나머지는 차량 앱이 쿠키 머리말로 붙일 값.
export function signMedia(objectKey, now = Date.now()) {
  const c = config();
  if (!c || !objectKey || !SERVED.test(objectKey)) return null;
  const url = `${c.base}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  const expires = (Math.floor(now / 1000 / WINDOW) + 3) * WINDOW;
  const id = `${c.keyPairId}\n${url}\n${expires}`;
  if (memoKey !== c.key) { memo.clear(); memoKey = c.key; }
  let signature = memo.get(id);
  if (!signature) {
    const policy = `{"Statement":[{"Resource":"${url}","Condition":{"DateLessThan":{"AWS:EpochTime":${expires}}}}]}`;
    try {
      signature = createSign("RSA-SHA1").update(policy).sign(c.key, "base64").replace(/\+/g, "-").replace(/=/g, "_").replace(/\//g, "~");
    } catch (e) {
      // 키가 잘못 들어온 환경: 서명 없이 지금처럼 동작하게 두고 기록만 남긴다(목록 전체를 500으로 만들지 않는다).
      log("warn", "media_sign_failed", { err: errFields(e) });
      return null;
    }
    if (memo.size > 5000) memo.clear();
    memo.set(id, signature);
  }
  return { url, expires, signature, keyPairId: c.keyPairId, mediaUrl: `${url}?Expires=${expires}&Signature=${signature}&Key-Pair-Id=${c.keyPairId}` };
}

// 응답에 더할 필드 둘. name이 "media"면 mediaUrl·mediaAuth, "thumbnailMedia"면 thumbnailMediaUrl·thumbnailMediaAuth, "photo"면 photoUrl·photoAuth.
// 꺼져 있으면 빈 객체라 응답 모양이 그대로다.
export function mediaFields(objectKey, name = "media", now) {
  const s = signMedia(objectKey, now);
  if (!s) return {};
  const { mediaUrl, ...auth } = s;
  return { [`${name}Url`]: mediaUrl, [`${name}Auth`]: auth };
}
