// 서명 주소(T178, ADR-0026: mediaUrl·thumbnailMediaUrl·photoUrl)로 미디어를 받는 도우미(T180).
// 서버가 항목에 서명이 붙은 CDN 주소를 주면 그 주소를 <video>·<audio>·<img>에 바로 걸거나 거기서 본문을 받는다(브라우저·CDN 캐시가 산다).
// 주지 않으면(로컬·CI·CDN이 없는 운영) 부르는 쪽의 지금 경로(같은 출처 + Authorization)가 그대로 돈다.
// - 권한 머리말·쿠키·Referer를 서명 주소로 보내지 않는다. 프로필·참가자 토큰이 다른 출처로 나가면 안 된다.
// - 서명은 10~15분 뒤 만료된다(403). 못 받으면 renew()로 목록을 다시 읽어 얻은 새 주소로 한 번 더, 그래도 안 되면 지금 경로로 받는다.
//   요소(<video> 등)는 상태 코드를 알려 주지 않고, CDN의 오류 응답에는 CORS 머리말이 없을 수 있어 실패의 종류를 가리지 않는다.

/** 서명 주소로 쓸 수 있는 값(절대 http(s) 주소)이면 그 값, 아니면 null. */
export const signedUrl = (value) => (typeof value === "string" && /^https?:\/\//.test(value) ? value : null);

// 서버에 미디어 CDN이 켜져 있는가(GET /api/config의 mediaBase, app.js가 넣는다). 한 건 조회로 서명을 따로 받아야 하는 곳(쇼츠 보관함)이 본다.
let mediaBase = null;
export const setMediaBase = (value) => { mediaBase = signedUrl(value); };
export const mediaOn = () => Boolean(mediaBase);

/**
 * 미디어 본문 받기 → Response. url: 항목의 서명 주소, renew: 목록을 다시 읽어 새 서명 주소를 돌려주는 함수(없어도 됨),
 * direct: 지금 경로(같은 출처 + 권한 머리말)로 받는 함수, accept: 서명 주소의 응답을 쓸 수 있는지(형식 확인).
 * 서명 주소가 없으면 그 자리에서 direct()를 부른다 — 전과 똑같다(같은 순간에 같은 요청). direct의 응답과 오류는 부르는 쪽이 전처럼 다룬다.
 * 서명 주소에서 받은 응답은 늘 ok다.
 */
export function mediaResponse({ url, renew, direct, signal, accept = () => true }) {
  return signedUrl(url) ? signedResponse({ url, renew, direct, signal, accept }) : direct();
}
async function signedResponse({ url, renew, direct, signal, accept }) {
  const get = async (address) => {
    if (!signedUrl(address)) return null;
    try {
      const res = await fetch(address, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
      return res.ok && accept(res) ? res : null;
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      return null;
    }
  };
  const first = await get(url);
  if (first) return first;
  const next = renew ? await (async () => renew())().catch((e) => (e?.name === "AbortError" ? Promise.reject(e) : null)) : null;
  return (next !== url ? await get(next) : null) ?? direct();
}

/**
 * <video>·<audio>·<img>에 서명 주소를 건다. 못 받으면(error) renew()로 새 주소를 받아 한 번 더 걸고(보던 자리에서 이어서),
 * 그래도 안 되면 fallback()을 부른다(지금 경로). 새 주소가 실제로 받아졌으면 다음 만료 때 또 한 번 새로 받는다(연달아 실패할 때만 넘긴다).
 * 돌려주는 함수를 부르면 더 지켜보지 않는다(다른 것을 고르거나 닫을 때).
 */
export function attachSigned(el, url, { renew, fallback } = {}) {
  let renewed = false, off = false, current = url;
  const worked = () => { renewed = false; };
  const stop = () => { off = true; for (const [name, fn] of [["error", failed], ["loadeddata", worked], ["load", worked]]) el.removeEventListener(name, fn); };
  const put = (address, at = 0, play = false) => {
    if ("referrerPolicy" in el) el.referrerPolicy = "no-referrer";
    el.src = current = address;
    if (at > 0) el.currentTime = at;
    if (play) el.play?.().catch(() => {});
  };
  async function failed() {
    if (off) return;
    // 재생을 걸어 둔 채 못 받았으면(처음부터 만료된 주소였을 때 포함) 새 주소에서도 재생을 건다. 멈춰 둔 것은 멈춘 채로.
    const at = el.currentTime || 0, play = el.paused === false && !el.ended;
    const next = !renewed && renew ? signedUrl(await (async () => renew())().catch(() => null)) : null;
    renewed = true;
    if (off) return;
    if (next && next !== current) return put(next, at, play);
    stop();
    fallback?.();
  }
  el.addEventListener("error", failed);
  el.addEventListener("loadeddata", worked); // <video>·<audio>
  el.addEventListener("load", worked); // <img>
  put(url);
  return stop;
}
