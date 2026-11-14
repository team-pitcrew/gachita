// '콘텐츠 기록' 탭(최종 시안 P33–P38, D補 emptyContent·player2·3·export2·3, 하단 작업 2026:3146).
// 갤러리 | 타임라인 | 지도, 지도에서 고른 장면, 플레이어, 내보내기. 무엇을 보일지는 서버가 준 값으로 고른다:
// - 프로필이 있으면 GET /profiles/me/trips(여러 여행), 없으면 지금 여행의 GET /trips/{code}/contents(참가자 토큰) — 같은 모양(docs/api/places.md)
// - 장소·경로·자막 줄은 녹음에 동의한 참가자에게만 온다(T136). 없으면 그 칸을 비워 그리고 지어내지 않는다.
// - 영상 파일은 그 여행의 참가자 토큰으로 받는다(전원 동의 규칙, short-assets.md).
// 지도는 지도 제공자 없이 기록한 좌표(route·contents의 lat/lng)를 상자에 투영해 그린다(개편 계획 결정 5).
import { api, h, toast } from "./shared.js";
import { appBar, hhmm, journeyTabs } from "./ride.js";

const monthDay = (at) => new Date(at).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
export const clock = (seconds = 0) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const secondsLabel = (s) => `${Math.round(Number(s) || 0)}초`;
const button = (text, onclick, className = "") => h("button", { type: "button", className, onclick }, text);
const named = (p) => p && typeof p.name === "string" && p.name.trim();

// 받침이 있으면 '과', 없으면 '와'.
const wa = (word) => {
  const code = String(word).codePointAt(String(word).length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 ? `${word}과` : `${word}와`;
};

// 콘텐츠를 날짜·여행으로 묶는다(최신 여행 먼저, 여행 안은 시각 순). 콘텐츠가 없는 여행은 뺀다.
export function contentGroups(trips) {
  return (Array.isArray(trips) ? trips : [])
    .filter((t) => Array.isArray(t.contents) && t.contents.length)
    .map((t) => ({ trip: t, title: `${monthDay(t.startedAt ?? t.createdAt)}  ${t.title || "함께 탄 여행"}`, items: [...t.contents].sort((a, b) => a.at - b.at) }));
}

// 타임라인 머리 '09:20 출발 → 하나로마트 → 10:28 숙소': 출발 시각, 들른 곳, 마지막 도착 시각과 이름. 장소가 없으면 빈 글.
export function tripLine(places) {
  const list = (Array.isArray(places) ? places : []).filter(named).sort((a, b) => a.at - b.at);
  const start = list.find((p) => p.kind === "start");
  const arrivals = list.filter((p) => p.kind === "arrived" || p.kind === "stop");
  const names = [...new Set(arrivals.map((p) => p.name.trim()))];
  const last = arrivals.at(-1);
  const parts = [];
  if (start) parts.push(`${hhmm(start.at)} 출발`);
  names.forEach((n, i) => parts.push(i === names.length - 1 && last ? `${hhmm(last.at)} ${n}` : n));
  return parts.length > 1 ? parts.join(" → ") : parts.join("");
}

// 지도 아래 '동해고속도로 → 하나로마트 → 강릉 숙소': 출발·곧 도착을 뺀 장소 이름을 처음 나온 순서로.
export const placeChain = (places) => [...new Set((Array.isArray(places) ? places : []).filter(named).filter((p) => !["start", "approaching"].includes(p.kind)).sort((a, b) => a.at - b.at).map((p) => p.name.trim()))].join(" → ");

// 핀 글: 긴 제목은 줄인다.
export const pinLabel = (title) => { const t = String(title ?? "").trim(); return t.length > 10 ? `${t.slice(0, 9)}…` : t; };

// mock: 서버에 장면 머리글(시안 '바다를 찾는 아빠와 이미 찾은 서준')의 원천이 없다. 말한 사람 이름으로 만든 글을 둔다(#392 플랜 표 '목업').
export function headline(content) {
  const names = (content?.cast ?? []).map((p) => p.name).filter(Boolean);
  if (names.length >= 2) return `${wa(names[0])} ${names[1]}의 이야기`;
  if (names.length === 1) return `${names[0]}의 이야기`;
  return content?.title || "우리 가족의 장면";
}

// mock: 서버에 영상 형식 이름이 없다. 기기에서 만든 기본 영상은 캐릭터 자막형, 생성한 영상은 가족 대화형으로 부른다(시안 C32의 두 이름).
export const styleLabel = (content) => (content?.kind === "generated" ? "가족 대화형" : "캐릭터 자막형");

// 재생 위치(초)의 자막 줄: 장면 구간 시작(from)에서 지난 시간으로 그 전에 시작한 마지막 줄. 없으면 첫 줄.
export function lineAt(content, seconds) {
  const lines = Array.isArray(content?.lines) ? content.lines : [];
  if (!lines.length) return null;
  const from = Number.isFinite(content.from) ? content.from : lines[0].at;
  return lines.findLast((l) => (l.at - from) / 1000 <= seconds) ?? lines[0];
}

// 좌표를 w×h 상자에 투영한다(위가 북쪽, 가로·세로 같은 축척, 여백 pad). 좌표가 하나도 없으면 null.
export function projector(points, w, hgt, pad = 24) {
  const ok = points.filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
  if (!ok.length) return null;
  const lats = ok.map((p) => p[0]), lngs = ok.map((p) => p[1]);
  const [minLat, maxLat, minLng, maxLng] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180); // 경도 1도의 길이는 위도에 따라 줄어든다
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((w - 2 * pad) / spanX, (hgt - 2 * pad) / spanY);
  const ox = (w - spanX * scale) / 2, oy = (hgt - spanY * scale) / 2;
  return ([lat, lng]) => [ox + (lng - minLng) * kx * scale, oy + (maxLat - lat) * scale];
}

export function createContents({ getProfileToken, getTrip, getParticipant, getParticipantToken, tokenFor, avatar, isOnline = () => true, onHome, onRide, onTalk, onProfile, onStudio }) {
  const dialog = h("dialog", { className: "conversations-dialog contents-dialog", "aria-labelledby": "contents-title" });
  document.body.append(dialog);
  let state = null;
  const close = () => {
    const s = state;
    state = null;
    if (s) { s.controller.abort(); s.video?.pause(); if (s.url) URL.revokeObjectURL(s.url); }
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
  };
  dialog.addEventListener("close", () => { if (state) close(); });
  addEventListener("hashchange", close);

  const face = (person) => h("span", { className: "content-face" }, avatar(person ?? {}));
  const castOf = (c, trip) => (c.cast?.length ? c.cast : []).slice(0, 2).map((p) => ({ ...p, seat: trip?.members?.find((m) => m.participantId === p.participantId)?.seat }));
  const all = (s) => contentGroups(s.trips).flatMap((g) => g.items.map((item) => ({ item, trip: g.trip })));
  const find = (s, id) => all(s).find((x) => x.item.id === id);
  const go = (s, view, extra = {}) => { if (s.view === "player" && view !== "player" && view !== "export") s.video?.pause(); Object.assign(s, { view, ...extra }); paint(s); };

  // ---- 조각 ----
  const seg = (s) => h("div", { className: "contents-seg", role: "tablist", "aria-label": "콘텐츠 보기" },
    [["gallery", "갤러리"], ["timeline", "타임라인"], ["map", "지도"]].map(([id, label]) => {
      const b = button(label, () => go(s, id), s.view === id ? "selected" : "");
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(s.view === id)); return b;
    }));
  const title = (text, sub, extra) => h("div", { className: "conversation-title contents-title" }, h("div", { className: "between" }, h("h1", { id: "contents-title" }, text), extra), sub && h("p", { className: "sub" }, sub));

  function gallery(s) {
    return contentGroups(s.trips).map((g) => h("section", { className: "content-group" },
      h("h2", {}, g.title),
      h("div", { className: "content-grid" }, g.items.map((c, i) => {
        const tile = button("", () => open(s, c.id), `content-tile tone-${i % 2}`);
        tile.append(h("span", { className: "content-cast" }, castOf(c, g.trip).map(face)), h("strong", {}, c.title), h("small", {}, `${secondsLabel(c.seconds)} / ${hhmm(c.at)}`));
        return tile;
      }))));
  }

  function timeline(s) {
    return contentGroups(s.trips).map((g) => h("section", { className: "content-group" },
      h("div", { className: "content-trip" }, h("h2", {}, g.title), tripLine(g.trip.places) && h("p", {}, tripLine(g.trip.places))),
      g.items.map((c) => {
        const row = button("", () => open(s, c.id), "content-row");
        row.append(face(castOf(c, g.trip)[1] ?? castOf(c, g.trip)[0]), h("span", {}, h("strong", {}, `${hhmm(c.at)}  ${c.title}`), h("small", {}, [secondsLabel(c.seconds), c.place].filter(Boolean).join(" / "))));
        return row;
      })));
  }

  // 지도: 경로(초록 선)와 콘텐츠 핀. 시안의 도로·바다는 배경 무늬이고 실제 지형이 아니다.
  function map(s, small = false) {
    const W = 318, H = small ? 204 : 204;
    const items = all(s).filter(({ item }) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
    const trip = items[0]?.trip ?? contentGroups(s.trips)[0]?.trip;
    const route = (trip?.route ?? []).map((p) => [p[0], p[1]]);
    const project = projector([...route, ...items.filter((x) => x.trip === trip).map(({ item }) => [item.lat, item.lng])], W, H, 36);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "content-map-art"); svg.setAttribute("aria-hidden", "true");
    const line = (d, cls) => { const p = document.createElementNS(ns, "path"); p.setAttribute("d", d); p.setAttribute("class", cls); svg.append(p); };
    line(`M0 ${H * 0.66} L${W} ${H * 0.44}`, "map-road"); line(`M${W * 0.36} 0 L${W * 0.52} ${H}`, "map-road"); line(`M${W * 0.56} 0 L${W * 0.72} ${H}`, "map-road");
    line(`M${W * 0.86} 0 C${W * 0.8} ${H * 0.3} ${W * 0.95} ${H * 0.6} ${W * 0.88} ${H} L${W} ${H} L${W} 0 Z`, "map-water");
    if (project && route.length > 1) line(route.map((p, i) => `${i ? "L" : "M"}${project(p).map((v) => v.toFixed(1)).join(" ")}`).join(" "), "map-route");
    const box = h("div", { className: "content-map" }, svg);
    if (project) items.filter((x) => x.trip === trip).forEach(({ item }, i) => {
      const [x, y] = project([item.lat, item.lng]);
      const pin = button("", () => { s.pin = item.id; paint(s); }, `content-pin tone-${i % 2}${s.pin === item.id ? " selected" : ""}`);
      pin.style.left = `${(x / W) * 100}%`; pin.style.top = `${(y / H) * 100}%`;
      pin.setAttribute("aria-label", `${item.title} 장면`);
      pin.append(face(castOf(item, trip)[1] ?? castOf(item, trip)[0]), h("span", {}, pinLabel(item.title)));
      box.append(pin);
    });
    if (!project) box.append(h("p", { className: "content-map-empty" }, "기록한 위치가 없어 길을 그리지 못했어요."));
    return h("section", { className: "content-map-card" }, box, trip && placeChain(trip.places) && h("p", { className: "meta" }, placeChain(trip.places)));
  }

  function detail(s) {
    const picked = find(s, s.pin) ?? all(s).find(({ item }) => Number.isFinite(item.lat)) ?? all(s)[0];
    const near = picked ? all(s).filter(({ item, trip }) => trip === picked.trip && item.place === picked.item.place) : [];
    return [map(s, true), ...near.map(({ item, trip }) => {
      const row = button("", () => open(s, item.id), "content-row picked");
      row.append(face(castOf(item, trip)[1] ?? castOf(item, trip)[0]), h("span", {}, h("strong", {}, [hhmm(item.at), item.place].filter(Boolean).join(" / ")), h("small", {}, `${item.title} / ${secondsLabel(item.seconds)}`)));
      return row;
    })];
  }

  function player(s) {
    const { item, trip } = find(s, s.selected) ?? {};
    if (!item) return [];
    const t = s.video?.currentTime ?? 0;
    const said = lineAt(item, t);
    const total = Number(item.seconds) || s.video?.duration || 0;
    const seek = h("input", { type: "range", min: 0, max: String(Math.max(total, 1)), step: "0.1", value: String(t), className: "content-seek", "aria-label": "재생 위치",
      oninput: (e) => { if (s.video) { s.video.currentTime = Number(e.target.value); paint(s); } } });
    const play = button(`${s.video && !s.video.paused ? "❚❚" : "▶"}  ${clock(t)} / ${clock(total)}`, () => toggle(s), "content-play");
    play.setAttribute("aria-label", s.video && !s.video.paused ? "일시정지" : "재생");
    return [h("section", { className: "content-player" },
      h("h2", {}, headline(item)),
      h("div", { className: "content-cast big" }, castOf(item, trip).map(face)),
      said && h("p", { className: "content-line" }, said.name && h("span", {}, `${said.name}  `), `“${said.text}”`),
      play, seek,
      s.loading && h("p", { className: "meta", role: "status" }, "영상을 불러오고 있어요"),
      s.error && h("p", { className: "meta", role: "status" }, s.error))];
  }

  function exporter(s) {
    const { item, trip } = find(s, s.selected) ?? {};
    if (!item) return [];
    const save = button("", () => saveFile(s), "content-save");
    save.append(h("strong", {}, "내 계정으로 폰에 저장"), h("small", {}, s.saved ? "저장했어요. 콘텐츠 기록에서도 같은 영상을 볼 수 있어요" : "콘텐츠 기록에서 같은 영상을 바로 확인"));
    return [h("section", { className: "content-row picked static" }, face(castOf(item, trip)[1] ?? castOf(item, trip)[0]), h("span", {}, h("strong", {}, `${styleLabel(item)} / 9:16`), h("small", {}, `${s.mime === "video/webm" ? "WebM" : "MP4"} / 세로 영상 ${secondsLabel(item.seconds)}`))),
      save, s.error && h("p", { className: "meta", role: "status" }, s.error)];
  }

  // ---- 동작 ----
  async function fileOf(s) {
    const { item, trip } = find(s, s.selected) ?? {};
    if (!item) throw new Error("영상을 다시 골라 주세요.");
    if (s.file && s.fileId === item.id) return s.file;
    const token = await tokenFor(trip.code);
    if (!token) throw new Error("이 폰에서 이 여행에 다시 연결해 주세요.");
    const res = await fetch(item.url, { headers: { authorization: `Bearer ${token}` }, signal: s.controller.signal, cache: "no-store" });
    if (!res.ok) throw Object.assign(new Error(res.status === 403 ? "모두가 기록에 동의한 여행의 영상만 볼 수 있어요." : "영상을 불러오지 못했어요. 다시 확인해 주세요."), { status: res.status });
    const type = res.headers.get("content-type")?.split(";")[0];
    if (!["video/mp4", "video/webm"].includes(type)) throw new Error("영상 형식을 확인해 주세요.");
    s.mime = type;
    s.file = new File([await res.blob()], `gachita-${item.id.slice(0, 8)}.${type === "video/webm" ? "webm" : "mp4"}`, { type });
    s.fileId = item.id;
    return s.file;
  }
  async function load(s) {
    s.loading = true; s.error = ""; paint(s);
    try {
      const file = await fileOf(s);
      if (state !== s) return;
      if (s.url) URL.revokeObjectURL(s.url);
      s.url = URL.createObjectURL(file);
      s.video.src = s.url;
    } catch (e) { if (state === s && e.name !== "AbortError") s.error = e.message; }
    finally { if (state === s) { s.loading = false; paint(s); } }
  }
  function toggle(s) {
    if (!s.video.src) return load(s).then(() => state === s && s.video.src && s.video.play().catch((e) => toast(e.message)));
    if (s.video.paused) s.video.play().catch((e) => toast(e.message)); else s.video.pause();
  }
  async function saveFile(s) {
    if (s.busy) return;
    s.busy = true; s.error = ""; paint(s);
    try {
      const file = await fileOf(s);
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: find(s, s.selected)?.item.title || "가치타 영상" }); } catch (e) { if (e.name !== "AbortError") throw e; return; }
      } else {
        const url = URL.createObjectURL(file);
        const link = h("a", { href: url, download: file.name });
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      s.saved = true; toast("영상을 폰에 저장했어요.");
    } catch (e) { if (state === s && e.name !== "AbortError") s.error = e.message; }
    finally { s.busy = false; if (state === s) paint(s); }
  }
  function open(s, id) {
    if (s.selected !== id) { s.video.pause(); s.video.removeAttribute("src"); s.file = null; s.fileId = null; s.saved = false; s.error = ""; }
    go(s, "player", { selected: id });
    if (!s.video.src) load(s);
  }

  // ---- 그리기 ----
  const FOOT = {
    gallery: (s) => [button("우리 가족 프로필", () => { close(); onProfile(); }, "primary")],
    timeline: (s) => [button("지도에서 보기", () => go(s, "map"), "primary")],
    map: (s) => [button("장면 확대하기", () => go(s, "detail"), "primary")],
    detail: (s) => [button("지도로 돌아가기", () => go(s, "map")), button("이 장면 보기", () => { const p = find(s, s.pin) ?? all(s).find(({ item }) => Number.isFinite(item.lat)) ?? all(s)[0]; if (p) open(s, p.item.id); }, "primary")],
    // 하단 작업(2026:3146): '콘텐츠 기록'(보조) + '영상 내보내기'(주)
    player: (s) => [button("콘텐츠 기록", () => go(s, "gallery")), button("영상 내보내기", () => go(s, "export"), "primary")],
    export: (s) => [button("콘텐츠 기록으로", () => go(s, "gallery"), "primary")],
    empty: () => [button("함께 타는 중으로", () => { close(); onRide(); }, "primary")],
  };
  function paint(s) {
    if (state !== s) return;
    const empty = s.ready && !all(s).length;
    const view = empty ? "empty" : s.view;
    const picked = find(s, s.selected)?.item;
    const studio = onStudio && button("쇼츠 만들기·보관함", () => { close(); onStudio(); }, "plain contents-studio");
    let head, body;
    if (view === "player" && picked) { head = title(picked.title, [`${monthDay(picked.at)} ${hhmm(picked.at)}`, picked.place].filter(Boolean).join(" / ")); body = player(s); }
    else if (view === "export" && picked) { head = title("공유할 준비가 됐어요", "캐릭터와 우리 목소리가 담긴 짧은 영상"); body = exporter(s); }
    else if (view === "detail") { head = title("이 길에서 나눈 이야기", "지도에서 선택한 우리 가족의 장면"); body = detail(s); }
    else {
      const sub = { gallery: "우리 가족 / 차량과 폰에서 이어보기", timeline: "날짜를 따라 다시 보는 우리 가족", map: "어디에서 나눈 이야기였을까요?", empty: "우리 가족 / 차량과 폰에서 이어보기" }[view] ?? "";
      head = title("콘텐츠 기록", sub, studio);
      body = !s.ready ? [h("p", { className: "meta", role: "status" }, s.error || "콘텐츠 기록을 불러오고 있어요")]
        : empty ? [h("p", { className: "content-empty" }, "아직 생성한 콘텐츠가 없어요.", h("br"), "여행을 마친 뒤 대화에서 장면을 골라 보세요.")]
        : [seg(s), ...(view === "timeline" ? timeline(s) : view === "map" ? [map(s)] : gallery(s))];
    }
    const scroll = h("div", { className: "conversation-body contents-body" }, head, body);
    dialog.replaceChildren(
      appBar({ online: isOnline(), onHome: () => { close(); onHome?.(); } }),
      journeyTabs("contents", { ride: () => { close(); onRide(); }, talk: () => { close(); onTalk(); }, contents: () => go(s, "gallery") }),
      scroll,
      h("footer", { className: `conversation-bottom${(FOOT[view]?.(s) ?? []).length > 1 ? " two" : ""}` }, FOOT[view]?.(s) ?? []),
    );
  }

  async function read(s) {
    const token = getProfileToken();
    const trip = getTrip(), me = getParticipant(), mine = getParticipantToken();
    if (token) return (await s.request("GET", "/profiles/me/trips", null, token)).items;
    if (trip && me && mine) return [await s.request("GET", `/trips/${trip.code}/contents`, null, mine)];
    return [];
  }

  async function show({ view = "gallery", selected } = {}) {
    close();
    const video = h("video", { playsInline: true, preload: "auto", hidden: true });
    // 영상은 화면에 붙이지 않은 video로 재생한다(시안은 영상 대신 캐릭터와 자막 줄을 그린다). 소리는 그대로 난다.
    const s = state = { view, selected, trips: [], ready: false, controller: new AbortController(), video };
    s.request = (method, path, body, token) => api(method, path, body, token, s.controller.signal);
    video.ontimeupdate = video.onplay = video.onpause = video.onended = () => paint(s);
    paint(s);
    dialog.showModal();
    try { s.trips = await read(s); }
    catch (e) { if (state !== s || e.name === "AbortError") return; s.error = e.status === 403 ? "기록에 동의한 사람만 콘텐츠 기록을 볼 수 있어요." : e.message; paint(s); return; }
    if (state !== s) return;
    s.ready = true;
    paint(s);
  }
  return { open: show, close };
}
