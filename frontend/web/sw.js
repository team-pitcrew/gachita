// 가치타 서비스 워커(T6). 네트워크 우선: 서버가 답하면 언제나 그 응답을 쓰고, 끊겼을 때만 마지막으로 받은 것을 준다.
// 서버가 화면 파일을 no-cache + ETag로 주므로 온라인에서는 옛 파일을 붙잡지 않는다(판 번호를 바꿀 일이 없다).
// 캐시에 두는 것: 같은 출처 GET 중 주소 뒤에 ?가 없는 화면 파일과 여행 첫 읽기(/api/trips/<코드>).
// 프로필·기록본 같은 다른 API, ?v= 폴링, 구글 복귀 주소(?code=…), 쓰기 요청은 손대지 않고 네트워크로 보낸다.
const CACHE = "gachita";
const TRIP = /^\/api\/trips\/[A-Z0-9]+$/;

// 설치할 때 화면 파일을 받아 둔다. 첫 방문 뒤 바로 끊겨도(이 파일들은 워커가 켜지기 전에 읽혔다) 다시 열 수 있게.
const SHELL = ["/", "/app.js", "/shared.js", "/style.css", "/manifest.webmanifest", "/icon.svg"];

addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => skipWaiting())));
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.search) return;
  if (url.pathname.startsWith("/api/") && !TRIP.test(url.pathname)) return;
  e.respondWith(
    fetch(req).then(
      (res) => {
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      },
      // 끊김: 그 주소의 마지막 응답, 화면 주소(/#코드, /j/<초대>)면 첫 화면. 없으면 끊긴 그대로(앱이 '연결이 끊겼어요'를 보인다).
      async () => (await caches.match(req)) ?? (req.mode === "navigate" ? await caches.match("/") : undefined) ?? Response.error(),
    ),
  );
});
