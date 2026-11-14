import { api, h, toast } from "/shared.js";
import { ShortGeneration, activeGeneration, generationState } from "/short-generation.js";
import { characterImage } from "/short-film.js";
import { readShortLibrary, keepLibraryShort, removeLibraryShort, shortPoster, shortMetadata, libraryGroups, tripDate } from "/short-library.js";

const remoteId = (code, job) => `${job.origin === "local-render" ? "asset" : "job"}:${code}:${job.id}`;
const clock = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const button = (label, action, className = "", disabled = false) => h("button", { type: "button", onclick: action, className, disabled }, label);
const icon = (name) => {
  const paths = { back: "m15 18-6-6 6-6", plus: "M12 5v14M5 12h14", save: "M5 4h14v17l-7-4-7 4z", download: "M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4", share: "m14 3 7 7-7 7M21 10H10a7 7 0 0 0-7 7v3", play: "m8 4 12 8-12 8z", pause: "M8 4v16M16 4v16", up: "m5 15 7-7 7 7", down: "m5 9 7 7 7-7", sound: "M4 9h4l5-5v16l-5-5H4zM17 8q5 4 0 8", grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" };
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24"); el.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(el.namespaceURI, "path"); path.setAttribute("d", paths[name]); el.append(path); return el;
};
const action = (name, label, fn, disabled = false) => {
  const el = button("", fn, "reel-action", disabled); el.setAttribute("aria-label", label); el.append(icon(name), h("span", {}, label)); return el;
};

export function createShortStudio({ getTrip, getParticipant, getToken, getOwner, onLocal, onPick, onConnect }) {
  let session;
  const remoteValid = (s) => {
    const t = getTrip(), p = getParticipant();
    if (!t || !p) return false;
    return t?.code === s.code && t.generation === s.generation && t.status !== "driving" && p?.id === s.participant && t.participants.every((x) => x.consent) && getToken() === s.token;
  };
  const posterUrl = (s, item) => {
    const old = s.posterUrls.get(item.id); if (old?.blob === item.poster) return old.url;
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(item.poster); s.posterUrls.set(item.id, { blob: item.poster, url }); return url;
  };
  const clearVideo = (s) => { s.load++; s.video?.pause(); s.video?.removeAttribute("src"); s.video?.load(); if (s.url) URL.revokeObjectURL(s.url); s.url = null; s.file = null; s.video = null; };
  function close() { const s = session; if (!s) return; session = null; clearInterval(s.timer); s.model?.close(); clearVideo(s); s.posterUrls.forEach((p) => URL.revokeObjectURL(p.url)); s.dialog.close(); s.dialog.remove(); s.focus?.focus(); }
  const sync = () => {
    if (!session) return;
    const s = session;
    if (getOwner() !== s.owner || getTrip()?.status === "driving") return close();
    if (s.model && !remoteValid(s)) {
      s.model.close(); s.model = null;
      if (s.selected?.remote) { clearVideo(s); s.selected = null; }
      if (["make", "confirm"].includes(s.view)) s.view = "library";
      s.error = "여행 기록을 더 볼 수 없어요. 기기에 보관한 영상은 그대로 남아요."; paint(s);
    }
  };
  async function run(s, fn) {
    if (s.busy) return;
    s.busy = true; s.error = ""; paint(s);
    try { await fn(); }
    catch (e) { if (session === s) { s.error = e.message; if ([401, 403, 404, 409, 410].includes(e.status)) { if (s.selected?.remote) clearVideo(s); if (s.model) s.model.plan = null; } } }
    finally { s.busy = false; if (session === s) { sync(); if (session === s) paint(s); } }
  }
  const records = (s) => {
    const remote = (s.model?.items || []).filter((j) => j.state === "completed").map((job) => ({ id: remoteId(s.code, job), job, remote: true, poster: s.posters.get(job.id), title: getTrip()?.moments.find((m) => m.id === job.momentId)?.label || s.title, tripCode: s.code, tripTitle: s.title, tripCreatedAt: s.createdAt, momentId: job.momentId, seconds: job.result?.seconds || 0, subtitle: job.origin === "local-render" ? "우리 목소리 · 서버에 보관" : "AI 쇼츠 · 서버에 보관" }));
    const ids = new Set(remote.map((item) => item.id));
    return [...remote, ...s.saved.filter((item) => !ids.has(item.id)).map((item) => ({ ...item, subtitle: "이 기기에 저장한 사본" }))];
  };
  async function verify(s, item) {
    if (session !== s || getOwner() !== s.owner) throw new Error("보관함을 다시 열어 주세요.");
    if (item.remote) {
      if (!s.model || !remoteValid(s)) throw new Error("여행 기록을 다시 확인해 주세요.");
      await s.model.refresh();
      const job = s.model.items.find((entry) => entry.id === item.job.id && entry.origin === item.job.origin);
      if (job?.state !== "completed") throw Object.assign(new Error("영상이 취소되었어요."), { status: 409 });
    }
  }
  async function select(s, item) {
    if (s.busy) return;
    clearVideo(s); s.selected = item; s.view = "feed"; s.error = ""; s.loading = true; paint(s);
    const load = s.load;
    try {
      let file = item.file;
      if (item.remote) {
        const response = await fetch(s.model.filePath(item.job), { headers: { authorization: `Bearer ${s.token}` }, signal: s.model.abort.signal, cache: "no-store" });
        if (!response.ok) throw Object.assign(new Error("영상을 불러오지 못했어요. 다시 확인해 주세요."), { status: response.status });
        const type = response.headers.get("content-type")?.split(";")[0];
        if (!["video/mp4", "video/webm"].includes(type)) throw new Error("영상 형식을 확인해 주세요.");
        file = new File([await response.blob()], `gachita-short.${type === "video/mp4" ? "mp4" : "webm"}`, { type });
      }
      await verify(s, item);
      if (session !== s || s.load !== load) return;
      s.file = file; s.url = URL.createObjectURL(file); s.loading = false; paint(s);
      if (item.remote) shortPoster(file).then((poster) => { if (session === s && poster) s.posters.set(item.job.id, poster); }).catch(() => {});
      s.video?.play().catch(() => { if (session === s && s.video) { s.video.pausedLabel.hidden = false; } });
    } catch (e) { if (session === s && s.load === load) { s.loading = false; s.error = e.message; paint(s); } }
  }
  function step(s, delta) { if (s.busy) return; const all = records(s), index = all.findIndex((i) => i.id === s.selected?.id); const item = all[index + delta]; if (item) select(s, item); }
  const changeView = (s, view) => { if (s.busy) return; s.video?.pause(); s.view = view; s.error = ""; paint(s); };
  async function keepFile(file, metadata = {}) {
    const owner = getOwner(); const item = { id: metadata.id || `local:${crypto.randomUUID()}`, ...shortMetadata(metadata), subtitle: "이 기기에 보관", file, poster: await shortPoster(file).catch(() => null) };
    await metadata.verify?.();
    if (getOwner() !== owner) throw new Error("프로필이 바뀌었어요. 보관함을 다시 열어 주세요.");
    await keepLibraryShort(owner, item); return item.id;
  }
  const status = (s) => s.error || s.busy ? h("p", { className: "reel-notice", role: "status" }, s.error || "처리하고 있어요. 잠시만 기다려 주세요.") : null;
  function header(s) {
    return h("header", { className: "reel-header" }, action("back", "닫기", close),
      h("nav", { "aria-label": "쇼츠 화면" }, button("쇼츠", () => changeView(s, "feed"), s.view === "feed" ? "is-selected" : ""), button("보관함", () => changeView(s, "library"), s.view === "library" ? "is-selected" : "")),
      button("+ 만들기", () => begin(s), "reel-create"));
  }
  function feed(s) {
    const items = records(s), item = s.selected;
    if (!items.length && !s.loading) return h("div", { className: "reel-empty" },
      h("div", { className: "reel-empty-art" }, characterImage("basic"), characterImage("basic-small")),
      h("h2", {}, "다시 보고 싶은 우리 대화"), h("p", {}, "함께 만든 쇼츠가 여기에 모여요."),
      button("첫 쇼츠 만들기", () => begin(s), "reel-solid"));
    let start;
    const stage = h("section", { className: "reel-stage", tabIndex: 0, "aria-label": "세로 쇼츠 피드", onpointerdown: (e) => { if (!e.target.closest("button,input")) start = e.clientY; },
      onpointerup: (e) => { if (start == null) return; const dy = e.clientY - start; start = null; if (Math.abs(dy) > 65) step(s, dy < 0 ? 1 : -1); }, onpointercancel: () => { start = null; },
      onkeydown: (e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); step(s, e.key === "ArrowDown" ? 1 : -1); } },
      onwheel: (e) => { if (Math.abs(e.deltaY) > 40 && Date.now() > (s.wheelAt || 0) + 900) { s.wheelAt = Date.now(); step(s, e.deltaY > 0 ? 1 : -1); } } });
    if (s.file) {
      if (!s.video) {
        s.video = h("video", { src: s.url, playsInline: true, loop: true, className: "reel-video", "aria-label": item.title });
        const play = action("play", "재생", () => { s.video.play().catch((e) => toast(e.message)); }, false); play.classList.add("reel-play"); play.hidden = true;
        s.video.pausedLabel = play;
        s.video.onplay = () => { play.hidden = true; }; s.video.onpause = () => { play.hidden = false; };
        s.video.onclick = () => s.video.paused ? s.video.play().catch(() => {}) : s.video.pause();
      }
      stage.append(s.video, s.video.pausedLabel);
    } else stage.append(h("div", { className: "reel-loading", role: "status" }, s.loading ? "쇼츠를 불러오고 있어요" : button("다시 시도", () => select(s, item), "reel-secondary", !item || s.busy)));
    const isSaved = item?.remote || s.saved.some((i) => i.id === item?.id);
    const tools = h("aside", { className: "reel-tools", "aria-label": "쇼츠 작업" },
      action("sound", "소리", () => { if (s.video) { s.video.muted = !s.video.muted; toast(s.video.muted ? "소리를 껐어요" : "소리를 켰어요"); } }, !s.file),
      action("save", item?.remote ? "서버 보관" : isSaved ? "기기 사본" : "보관", () => run(s, async () => { await verify(s, item); await keepFile(s.file, { ...item, verify: () => verify(s, item) }); s.saved = await readShortLibrary(s.owner); s.selected = s.saved.find((i) => i.id === item.id); toast("이 기기 보관함에 저장했어요."); }), !s.file || isSaved || s.busy),
      action("download", "내려받기", () => run(s, async () => { await verify(s, item); const link = h("a", { href: s.url, download: s.file.name || "gachita-short.mp4" }); document.body.append(link); link.click(); link.remove(); }), !s.file || s.busy),
      action("share", "공유", () => run(s, async () => { await verify(s, item); const file = new File([s.file], s.file.name || `gachita-short.${s.file.type.startsWith("video/webm") ? "webm" : "mp4"}`, { type: s.file.type }); if (!navigator.canShare?.({ files: [file] })) throw new Error("영상을 내려받은 뒤 다른 앱에서 공유해 주세요."); try { await navigator.share({ files: [file], title: item.title }); } catch (e) { if (e.name !== "AbortError") throw e; } }), !s.file || s.busy));
    const at = items.findIndex((i) => i.id === item?.id);
    stage.append(tools, h("footer", { className: "reel-caption" }, h("p", {}, [item?.tripTitle, tripDate(item || {})].filter(Boolean).join(" · ") || (item?.remote ? "이번 여행" : "이 기기에 보관")), h("h2", {}, item?.title || "우리 여행의 쇼츠"), h("p", {}, `${item?.subtitle || "우리 목소리"} · ${clock(item?.seconds)}`)),
      h("div", { className: "reel-pager" }, action("up", "이전", () => step(s, -1), at <= 0), h("span", {}, `${Math.max(at + 1, 1)} / ${items.length}`), action("down", "다음", () => step(s, 1), at >= items.length - 1)));
    return stage;
  }
  function library(s) {
    const groups = libraryGroups(records(s), s.query), items = groups.flatMap((g) => g.items);
    const gallery = groups.map((group) => h("section", { className: "library-trip" }, h("div", { className: "library-trip-heading" }, h("h2", {}, group.title), h("p", { className: "meta" }, [group.date, `${group.items.length}편`].filter(Boolean).join(" · "))), h("div", { className: "reel-grid" }, group.items.map((item) => {
      const poster = item.poster ? h("img", { src: posterUrl(s, item), alt: item.title }) : h("div", { className: "reel-unopened" }, icon("play"), h("span", {}, item.remote ? "이번 여행" : "보관한 영상"));
      const tile = button("", () => select(s, item), "reel-tile");
      tile.append(h("div", { className: "reel-cover" }, poster, h("span", { className: "reel-duration" }, clock(item.seconds))), h("strong", {}, item.title), h("small", {}, item.remote ? "이번 여행" : "이 기기에 보관"));
      return h("article", {}, tile, (!item.remote || item.job.origin === "local-render" && item.job.createdBy === s.participant) && button("삭제", () => { s.deleting = item; changeView(s, "delete"); }, "reel-delete"));
    }))));
    return h("section", { className: "reel-library" }, h("h1", {}, "보관함"), h("p", { className: "meta" }, "같은 여행에 참여한 휴대폰과 차량에서 같은 쇼츠를 볼 수 있어요. 내려받은 기기 사본도 함께 표시합니다."),
      records(s).length ? h("input", { type: "search", placeholder: "장면·여행 이름·날짜로 찾기", value: s.query || "", onchange: (e) => { s.query = e.target.value; paint(s); }, "aria-label": "보관함 검색" }) : null,
      items.length ? gallery : h("div", { className: "reel-library-empty" }, icon("grid"), h("h2", {}, s.query ? "찾는 쇼츠가 없어요" : "아직 보관한 쇼츠가 없어요"), h("p", {}, s.query ? "다른 여행 이름이나 날짜로 찾아보세요." : "대화 장면으로 첫 쇼츠를 만들어 보세요.")),
      (s.model?.items || []).some((j) => j.state !== "completed") ? h("section", { className: "reel-work" }, h("h2", {}, "제작 현황"), s.model.items.filter((j) => j.state !== "completed").map((job) => h("div", { className: "reel-work-row" }, h("div", {}, h("strong", {}, generationState(job)), h("p", { className: "meta" }, activeGeneration(job) ? `${job.progress.completedShots}/${job.progress.totalShots} 장면` : "이번 여행")), activeGeneration(job) ? button("취소", () => run(s, () => s.model.cancel(job.id)), "reel-delete", s.busy) : null))) : null);
  }
  function begin(s) {
    if (s.busy) return;
    if (s.model?.pending) return changeView(s, "confirm");
    if (!s.model) return changeView(s, "make");
    close(); onPick();
  }
  function creation(s) {
    const m = s.model, plan = m?.plan;
    if (!m) return h("section", { className: "reel-form" }, h("h1", {}, "여행의 대화로 쇼츠 만들기"), h("p", {}, "차에 연결하고 대화 기록에 동의하면 남긴 장면을 고를 수 있어요."), button("동승 연결 확인", () => { close(); onConnect(); }, "reel-solid"));
    if (s.view === "confirm") return h("section", { className: "reel-form" }, button("뒤로", () => changeView(s, "make"), "reel-back"),
      h("h1", {}, m.pending ? "이전 요청 접수 확인" : "이 장면을 쇼츠로 만들까요?"),
      h("p", {}, m.pending ? "같은 요청 번호로 확인해 중복 제작을 막아요." : `${Math.round(plan?.seconds || 0)}초의 대화를 원래 목소리로 담아요.`),
      h("div", { className: "reel-confirm-data" }, h("h2", {}, "영상 제작에 쓰는 자료"), h("p", {}, (plan?.externalData || ["캐릭터 이미지", "발화 시각과 반응 지시", ...(m.pending?.audioReference ? ["장면별 원음"] : [])]).join(" · ")), h("p", { className: "meta" }, "Higgsfield에 이 자료를 보내 영상을 만들어요. 이름과 자막 원문은 보내지 않아요.")),
      button(m.pending ? "같은 요청으로 접수 확인" : "동의하고 만들기", () => run(s, async () => { await m.submit(true); s.view = "library"; }), "reel-solid", s.busy || !m.catalog?.enabled));
    return h("section", { className: "reel-form" }, button("뒤로", () => changeView(s, "feed"), "reel-back"), h("h1", {}, "새 쇼츠 만들기"),
      h("div", { className: "reel-templates", role: "group", "aria-label": "영상 스타일" }, (m?.catalog?.templates || []).map((t) => {
        const b = button("", () => { s.template = t.id; run(s, () => m.preview(t.id, s.audio, s.momentId)); }, `reel-template ${s.template === t.id ? "is-selected" : ""}`, s.busy || !!m.pending);
        b.setAttribute("aria-pressed", String(s.template === t.id)); b.append(characterImage(t.id === "car-sitcom-v1" ? "basic" : "travel"), h("strong", {}, t.name), h("span", {}, t.description)); return b;
      })),
      plan ? h("section", { className: "reel-plan" }, h("span", { className: "meta" }, `선택한 장면 · ${Math.round(plan.seconds)}초`), h("h2", {}, plan.title), h("p", { className: "meta" }, s.title), h("div", { className: "scene-cast" }, plan.cast.map((person) => h("div", {}, characterImage(person.character), h("span", {}, person.name)))), h("p", { className: "reel-quote" }, plan.cues[0]?.text),
        h("details", {}, h("summary", {}, "대화와 장면 구성"), h("ol", {}, plan.cues.map((c) => h("li", {}, `${clock(c.start)}  ${c.text}`))), h("p", { className: "meta" }, plan.warnings.join(" ")))) : h("p", { className: "meta" }, m?.pending ? "접수 결과를 못 받은 요청이 있어요. 같은 요청으로 확인해 주세요." : s.busy ? "대화에서 장면을 고르고 있어요." : "여행에서 15~45초의 원음과 자막이 있는 장면을 남겨 주세요."),
      m && h("details", { className: "reel-options" }, h("summary", {}, "추가 설정"),
        h("div", { className: "reel-option" }, h("div", {}, h("strong", {}, "원음으로 동작 참고"), h("p", { className: "meta" }, "켜면 원음도 외부 영상 제작에 보내요.")),
          h("button", { type: "button", role: "switch", "aria-checked": String(s.audio), "aria-label": "원음으로 동작 참고", className: `reel-switch ${s.audio ? "is-on" : ""}`, disabled: s.busy || !!m.pending, onclick: () => { s.audio = !s.audio; run(s, () => m.preview(s.template, s.audio, s.momentId)); } }, h("span")))),
      m?.catalog?.enabled ? button(m.pending ? "이전 요청 확인" : "이 구성으로 만들기", () => changeView(s, "confirm"), "reel-solid", s.busy || (!plan && !m.pending)) : h("p", { className: "reel-inline-note" }, "AI 제작은 준비 중이에요. 지금은 기본 영상으로 남길 수 있어요."),
      button("기본 영상으로 만들기", () => { const id = s.momentId; close(); onLocal(id); }, "reel-secondary", s.busy || !s.momentId || !!m.pending),
      button("원음·자막 다시 확인", () => { const id = s.momentId; close(); onPick(id); }, "reel-back", s.busy || !!m.pending),
      button("다른 장면 고르기", () => { close(); onPick(); }, "reel-back", s.busy || !!m.pending));
  }
  function paint(s) {
    if (session !== s) return;
    const keys = new Set(records(s).map((i) => i.id));
    for (const [key, poster] of s.posterUrls) if (!keys.has(key)) { URL.revokeObjectURL(poster.url); s.posterUrls.delete(key); }
    s.dialog.classList.toggle("is-feed", s.view === "feed");
    const body = s.view === "feed" ? feed(s) : s.view === "library" ? library(s) : s.view === "delete" ? h("section", { className: "reel-form" }, h("h1", {}, "보관한 쇼츠를 삭제할까요?"), h("p", {}, s.deleting.title), h("p", { className: "meta" }, s.deleting.remote ? "서버 보관함에서 삭제하면 같은 여행의 모든 기기에서 사라져요. 내려받은 사본은 남습니다." : "이 기기 사본을 삭제해요. 서버 보관함은 그대로예요."), button(s.deleting.remote ? "서버에서 삭제" : "이 기기에서 삭제", () => run(s, async () => { if (s.deleting.remote) await s.model.cancel(s.deleting.job.id); else await removeLibraryShort(s.owner, s.deleting.id); if (s.selected?.id === s.deleting.id) { clearVideo(s); s.selected = null; } s.saved = await readShortLibrary(s.owner); s.view = "library"; }), "reel-danger", s.busy), button("돌아가기", () => changeView(s, "library"), "reel-secondary")) : creation(s);
    s.body.replaceChildren(header(s), body, ...(status(s) ? [status(s)] : []));
    if (s.view === "feed" && !s.selected && records(s).length && !s.loading) select(s, records(s)[0]);
  }
  async function open({ selectedId, momentId, view = "feed" } = {}) {
    close(); const t = getTrip(), p = getParticipant();
    const s = { owner: getOwner(), code: t?.code, generation: t?.generation, participant: p?.id, token: getToken(), title: t?.title || "우리 여행의 쇼츠", createdAt: t?.createdAt, momentId, saved: [], posters: new Map(), posterUrls: new Map(), template: "car-sitcom-v1", audio: false, view: momentId ? "make" : view, load: 0, loading: true, focus: document.activeElement };
    if (t?.status === "driving") return toast("주차한 뒤 쇼츠를 볼 수 있어요.");
    if (remoteValid(s)) {
      const key = `gachita:short-request:${s.code}:${p.id}:${s.generation}`;
      let pending; try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { toast("이전 제작 요청을 확인하지 못했어요."); }
      if (pending) { s.template = pending.templateId; s.audio = pending.audioReference; s.momentId = pending.momentId; if (momentId) s.view = "confirm"; }
      s.model = new ShortGeneration({ code: s.code, generation: s.generation, pending, canRead: () => session === s && remoteValid(s), savePending: (v) => v ? sessionStorage.setItem(key, JSON.stringify(v)) : sessionStorage.removeItem(key), request: async (method, path, body, signal) => {
        const request = new AbortController(), abort = () => request.abort();
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
        const timeout = setTimeout(abort, 10000);
        try { return await api(method, path, body, s.token, request.signal); }
        finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
      } });
    }
    s.body = h("div", { className: "reel-body" }); s.dialog = h("dialog", { className: "short-studio", "aria-label": "우리 쇼츠", oncancel: (e) => { e.preventDefault(); close(); } }, s.body);
    session = s; document.body.append(s.dialog); s.dialog.showModal(); paint(s);
    const local = readShortLibrary(s.owner).then((saved) => {
      if (session === s) { s.saved = saved; const first = saved.find((i) => i.id === selectedId) || saved[0]; if (first && s.view === "feed") { s.loading = false; select(s, first); } }
      return saved;
    });
    const results = await Promise.allSettled([local, s.model?.load()]);
    if (session !== s) return;
    if (results[0].status === "fulfilled") s.saved = results[0].value; else s.error = results[0].reason.message;
    if (results[1].status === "rejected") s.error = results[1].reason.message;
    s.loading = false; const initial = records(s).find((i) => i.id === selectedId) || records(s)[0]; if (initial && !s.selected && s.view === "feed") select(s, initial); else if (!s.file) paint(s);
    if (s.view === "make" && s.momentId && s.model && !s.model.pending) await run(s, () => s.model.preview(s.template, s.audio, s.momentId));
    if (session !== s) return;
    s.timer = setInterval(async () => {
      sync(); if (session !== s || !s.model || s.busy || s.polling || document.hidden) return;
      s.polling = true; const before = JSON.stringify(s.model.items);
      try { await s.model.refresh(); if (s.selected?.remote) await verify(s, s.selected); if (session === s && before !== JSON.stringify(s.model.items)) paint(s); }
      catch (e) { if (session === s) { if (s.selected?.remote) clearVideo(s); s.error = e.message; paint(s); } }
      finally { s.polling = false; }
    }, 5000);
  }
  return { open, sync, close, keepFile };
}
