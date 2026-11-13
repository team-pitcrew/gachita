// 가치타 서비스 워커(T6). 네트워크 우선: 서버가 답하면 언제나 그 응답을 쓰고, 끊겼을 때만 마지막으로 받은 것을 준다.
// 서버가 화면 파일을 no-cache + ETag로 주므로 온라인에서는 옛 파일을 붙잡지 않는다(판 번호를 바꿀 일이 없다).
// 캐시에 두는 것: 같은 출처 GET 중 주소에 ?가 없는 화면 파일, 그리고 여행 읽기(/api/trips/<코드>, ?v= 폴링의 새 판도 같은 자리에).
// 프로필·기록본 같은 다른 API, 구글 복귀 주소(?code=…), 쓰기 요청은 손대지 않고 네트워크로 보낸다.
const CACHE = "gachita";
const TRIP = /^\/api\/trips\/[A-Z0-9]+$/;
const KEEP_MS = 48 * 3600 * 1000; // 서버가 여행을 지우는 때(만든 뒤 48시간). 그 뒤로는 끊겨도 보이지 않게 한다

// 설치할 때 화면 파일을 받아 둔다. 첫 방문 뒤 바로 끊겨도(이 파일들은 워커가 켜지기 전에 읽혔다) 다시 열 수 있게.
const SHELL = ["/", "/app.js", "/shared.js", "/shares.js", "/records.js", "/style.css", "/manifest.webmanifest", "/icon.svg"];

addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => skipWaiting())));
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const trip = TRIP.test(url.pathname);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") ? !trip : url.search) return;
  const key = url.origin + url.pathname;
  const save = (res) => {
    // 새 판은 갈아 끼우고, 서버가 지운 여행(404)은 이 폰에서도 지운다. 복사는 화면이 본문을 읽기 전에 떠 둔다.
    const copy = res.ok && res.clone();
    if (copy || (trip && res.status === 404)) e.waitUntil(caches.open(CACHE).then((c) => (copy ? c.put(key, copy) : c.delete(key))));
    return res;
  };
  // ?v= 폴링은 끊기면 그대로 실패시킨다(앱이 '연결이 끊겼어요'를 보인다). 받은 새 판만 캐시에 둔다.
  if (url.search) return e.respondWith(fetch(req).then(save));
  e.respondWith(fetch(req).then(save, () => offline(req, key, trip)));
});

// 끊김: 그 주소의 마지막 응답, 화면 주소(/#코드, /j/<초대>)면 첫 화면. 없으면 끊긴 그대로.
async function offline(req, key, trip) {
  const hit = (await caches.match(key)) ?? (req.mode === "navigate" ? await caches.match("/") : undefined);
  if (hit && trip && Date.now() - (await hit.clone().json()).createdAt > KEEP_MS) return (await caches.open(CACHE)).delete(key).then(() => Response.error());
  return hit ?? Response.error();
}
