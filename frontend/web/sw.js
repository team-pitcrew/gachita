// 가치타 서비스 워커(T6). 네트워크 우선: 서버가 답하면 언제나 그 응답을 쓰고, 끊겼을 때만 마지막으로 받은 것을 준다.
// 서버가 화면 파일을 no-cache + ETag로 주므로 온라인에서는 옛 파일을 붙잡지 않는다(판 번호를 바꿀 일이 없다).
// 캐시에 두는 것: 같은 출처 GET 중 주소에 ?가 없는 화면 파일, 그리고 여행 읽기(/api/trips/<코드>, ?v= 폴링의 새 판도 같은 자리에).
// 프로필·기록본 같은 다른 API, 구글 복귀 주소(?code=…), 쓰기 요청은 손대지 않고 네트워크로 보낸다.
//
// 화면 파일이 다른 주소에서 올 때(T180): 서버가 첫 화면의 정적 주소를 CDN(…/public/web/{커밋}/)으로 바꿔 주면 app.js가 자기가 온 자리를
// 붙여 등록한다(/sw.js?assets=<그 주소>). 그러면 SHELL을 그 주소에서 받아 두고(같은 출처 사본을 느린 길로 다시 받지 않는다),
// 그 주소 아래 요청은 캐시 먼저 준다 — 경로에 커밋이 들어 있어 내용이 바뀌지 않는다. 판이 바뀌면 주소가 달라져 새 워커가 서고 옛 판 항목을 지운다.
// 첫 화면(/)과 여행 읽기는 그대로 같은 출처·네트워크 우선이다. ?assets가 없으면(같은 출처로 줄 때) 모든 동작이 전과 같다.
const CACHE = "gachita";
const TRIP = /^\/api\/trips\/[A-Z0-9]+$/;
const ASSETS = new URLSearchParams(location.search).get("assets");

// 설치할 때 화면 파일을 받아 둔다. 첫 방문 뒤 바로 끊겨도(이 파일들은 워커가 켜지기 전에 읽혔다) 다시 열 수 있게.
const SHELL = ["/", "/app.js", "/shared.js", "/media.js", "/media-controls.js", "/captions.js", "/shares.js", "/share-card.js", "/qrcode.js", "/records.js", "/conversations.js", "/todos.js", "/ride.js", "/short-film.js", "/short-studio.js", "/short-generation.js", "/short-library.js", "/short-scenes.js", "/boarding.js", "/vehicle-boarding.js", "/onboarding.js", "/voice-embed.js", "/voice-meter.js", "/wespeaker.js", "/wespeaker-worker.js", "/groups.js", "/profile-menu.js", "/style.css", "/manifest.webmanifest", "/icon.svg", "/brand/mascot.svg", "/icons/gachita-32.png", "/icons/gachita-180.png", "/icons/gachita-192.png", "/icons/gachita-512.png", "/brief.js", "/contents.js", "/after-trip.js", "/maps/gangneung.jpg", "/brief-icons/1f6bb.svg", "/brief-icons/1f6d2.svg", "/brief-icons/1f969.svg", "/brief-icons/1f34a.svg", "/brief-icons/1f36c.svg", "/brief-icons/1f964.svg", "/brief-icons/1f9ca.svg", "/brief-icons/1f9f3.svg", "/brief-icons/trash.svg"];

// 같은 출처에 남는 것: 첫 화면과 매니페스트(서버가 주소를 바꾸지 않는다). 나머지는 화면 파일이 온 주소에서.
const HERE = ["/", "/manifest.webmanifest"];
const shell = () => (ASSETS ? SHELL.map((path) => (HERE.includes(path) ? path : ASSETS + path.slice(1))) : SHELL);
// 다른 출처의 화면 파일은 CORS로 받는다: 그림·CSS의 no-cors 요청을 그대로 받으면 불투명 응답이라 캐시 자리를 크게 잡고 상태도 볼 수 없다.
// 브라우저 캐시에 CORS 머리말 없이 받아 둔 사본(워커가 서기 전의 <img> 등)이 있어 실패하면 한 번은 새로 받는다.
const CORS = { mode: "cors", credentials: "omit" };
const pull = (url) => fetch(url, CORS).catch(() => fetch(url, { ...CORS, cache: "reload" }));
const keep = async (cache, url) => {
  const res = await pull(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await cache.put(url, res);
};

addEventListener("install", (e) => e.waitUntil(caches.open(CACHE)
  .then((c) => (ASSETS ? Promise.all(shell().map((url) => (url.startsWith(ASSETS) ? keep(c, url) : c.add(url)))) : c.addAll(SHELL)))
  .then(() => skipWaiting())));
// 켜질 때 옛 판의 화면 파일(지금 주소 밖의 다른 출처 항목)을 지운다. 같은 출처 항목(첫 화면, 여행)은 그대로 둔다.
addEventListener("activate", (e) => e.waitUntil(caches.open(CACHE)
  .then(async (c) => Promise.all((await c.keys()).filter((r) => !r.url.startsWith(`${location.origin}/`) && !(ASSETS && r.url.startsWith(ASSETS))).map((r) => c.delete(r))))
  .then(() => clients.claim())));
addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const trip = TRIP.test(url.pathname);
  if (ASSETS && req.method === "GET" && req.url.startsWith(ASSETS) && !req.headers.has("range")) return e.respondWith(asset(e));
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") ? !trip : url.search) return;
  const key = url.origin + url.pathname;
  // 화자 모델·실행기(wespeaker.js, 38 MB)는 가로채지 않는다: 서버가 판 번호 붙은 주소를 1년 고정(immutable)으로 주니 브라우저 캐시가 맡는다.
  // 여기서 받으면 같은 38 MB를 캐시 저장소에 한 벌 더 둔다.
  if (/^\/(models|vendor)\//.test(url.pathname)) return;
  const save = (res) => {
    // 새 판은 갈아 끼우고, 서버가 지운 여행(404)은 이 폰에서도 지운다. 복사는 화면이 본문을 읽기 전에 떠 둔다.
    const copy = res.ok && res.clone();
    if (copy || (trip && res.status === 404)) e.waitUntil(caches.open(CACHE).then((c) => (copy ? c.put(key, copy) : c.delete(key))));
    return res;
  };
  // 화면 주소(T182): 받아 둔 첫 화면을 먼저 주고 뒤에서 새로 받는다. 아래 page()에 조건과 이유가 있다.
  if (ASSETS && req.mode === "navigate" && !url.search) return e.respondWith(page(e, req, key, save));
  // ?v= 폴링은 끊기면 그대로 실패시킨다(앱이 '연결이 끊겼어요'를 보인다). 받은 새 판만 캐시에 둔다.
  if (url.search) return e.respondWith(fetch(req).then(save));
  e.respondWith(fetch(req).then(save, () => offline(req, key)));
});

// 다른 주소에서 오는 화면 파일: 받아 둔 것이 있으면 그것, 없으면 받아서 둔다. CORS로 받지 못하면(CDN 설정 등) 요청 그대로 보내고 두지 않는다.
async function asset(e) {
  const req = e.request, cache = await caches.open(CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  let res;
  try { res = await pull(req.url); } catch { return fetch(req); }
  if (res.ok) e.waitUntil(cache.put(req.url, res.clone()));
  return res;
}

// 첫 화면은 이 폰에 받아 둔 것을 먼저 주고, 뒤에서 서버 것을 받아 맞춘다(T182). 서버를 기다리는 0.5~1초가 없어진다.
// - 화면 파일이 판 주소(ASSETS)에서 올 때만: 받아 둔 HTML이 가리키는 화면 파일은 그 판의 주소라 내용이 바뀌지 않고 캐시에도 있다.
//   같은 출처로 줄 때는 HTML과 화면 파일의 판이 어긋날 수 있어 전처럼 서버 먼저다.
// - 오래 붙잡지 않는다: 받아 둔 지 하루를 넘겼거나 받은 때를 모르면 서버 먼저. 뒤에서 받은 것이 다르면 그 화면에 알려
//   (app.js가 아직 손대지 않은 화면을 한 번 새로 연다) 다음 방문을 기다리지 않는다.
// - 여행·대화·쇼츠 같은 API 응답은 여기를 지나지 않는다. 그 값은 언제나 서버에서 온다.
const SHELL_MAX_AGE = 86400_000;
const entry = (html) => html.match(/<script[^>]*type="module"[^>]*src="([^"]*)"/)?.[1] ?? null;
async function page(e, req, key, save) {
  const hit = await caches.match(key);
  const age = hit ? Date.now() - Date.parse(hit.headers.get("date") ?? "") : NaN;
  const fresh = fetch(req).then(save);
  if (!hit || !(age < SHELL_MAX_AGE)) return fresh.catch(() => offline(req, key));
  // 같은 판인지는 HTML이 가리키는 화면 파일 주소(판마다 다른 CDN 경로)로 본다. ETag와 본문은 쓰지 못한다: 운영의 첫 화면은
  // ETag 없이 오고, Cloudflare가 화면 이동 응답에만 측정 스크립트를 넣어 설치 때 받아 둔 것과 본문이 다르다(11/16 확인).
  const kept = hit.clone().text();
  e.waitUntil(fresh.then(async (res) => {
    if (!res.ok || entry(await res.text()) === entry(await kept)) return;
    const client = await globalThis.clients?.get?.(e.resultingClientId || e.clientId);
    client?.postMessage({ type: "shell-updated" });
  }, () => {}));
  return hit;
}

// 끊김: 그 주소의 마지막 응답, 화면 주소(/#코드, /j/<초대>)면 첫 화면. 없으면 끊긴 그대로.
async function offline(req, key) {
  const hit = (await caches.match(key)) ?? (req.mode === "navigate" ? await caches.match("/") : undefined);
  return hit ?? Response.error();
}
