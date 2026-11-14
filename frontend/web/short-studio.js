import { api, h, toast } from "/shared.js";
import { ShortGeneration, activeGeneration, generationState } from "/short-generation.js";
import { characterImage } from "/short-film.js";

export function createShortStudio({ getTrip, getParticipant, getToken, onLocal }) {
  let session;
  const valid = (s) => {
    const t = getTrip(), p = getParticipant();
    return t?.code === s.code && t.generation === s.generation && t.status !== "driving" &&
      Date.now() < t.createdAt + 48 * 3600 * 1000 && p?.id === s.participant &&
      t.participants.every((x) => x.consent) && getToken() === s.token;
  };
  const clearVideo = (s) => { s.video?.pause(); s.video?.removeAttribute("src"); if (s.url) URL.revokeObjectURL(s.url); s.url = null; s.file = null; s.video = null; };
  function close() {
    const s = session; if (!s) return;
    session = null; clearInterval(s.timer); s.model.close(); clearVideo(s); s.dialog.close(); s.dialog.remove();
    s.focus?.focus();
  }
  const sync = () => { if (session && !valid(session)) { close(); toast("여행 또는 기록 상태가 바뀌어 쇼츠를 닫았어요."); } };
  async function run(s, action) {
    if (s.working) return;
    s.working = true; s.error = ""; paint(s);
    try { await action(); }
    catch (e) { if (session === s) { s.error = e.message; if ([401, 403, 404, 409, 410].includes(e.status)) { clearVideo(s); s.model.plan = null; } } }
    finally { s.working = false; if (session === s) { sync(); if (session === s) paint(s); } }
  }
  async function receive(s, job) {
    clearVideo(s);
    const response = await fetch(s.model.filePath(job), { headers: { authorization: `Bearer ${s.token}` }, signal: s.model.abort.signal, cache: "no-store" });
    if (!response.ok) throw Object.assign(new Error("영상을 받지 못했어요. 상태를 다시 확인해 주세요."), { status: response.status });
    if (!response.headers.get("content-type")?.startsWith("video/mp4")) throw new Error("영상 형식을 확인하지 못했어요.");
    const blob = await response.blob();
    s.model.check();
    // 느린 다운로드 중 자막·캐릭터 변경도 서버에 다시 확인합니다.
    const verified = await s.model.call("GET", s.model.path(`/short-generations/${encodeURIComponent(job.id)}`));
    if (verified.state !== "completed") throw Object.assign(new Error("영상이 취소되었어요."), { status: 409 });
    s.file = new File([blob], "gachita-short.mp4", { type: "video/mp4" }); s.url = URL.createObjectURL(s.file); s.selected = job.id;
  }
  const button = (text, action, disabled = false, className = "") => h("button", { type: "button", onclick: action, disabled, className }, text);
  function paint(s) {
    if (session !== s) return;
    const m = s.model, plan = m.plan, locked = s.working || !!m.pending;
    const status = h("p", { className: "studio-status", role: "status" }, s.error || (s.working ? "잠시만요. 장면을 확인하고 있어요." : ""));
    const select = h("select", { "aria-label": "쇼츠 템플릿", disabled: locked, onchange: (e) => { s.template = e.target.value; s.consent = false; run(s, () => m.preview(s.template, s.audio)); } },
      (m.catalog?.templates || []).map((t) => h("option", { value: t.id, selected: s.template === t.id }, t.name)));
    const toggle = (label, checked, change, disabled = locked) => h("label", { className: "studio-check" }, h("input", { type: "checkbox", checked, disabled, onchange: (e) => change(e.target.checked) }), h("span", {}, label));
    const jobs = h("section", { className: "studio-jobs" }, h("h3", {}, "만든 쇼츠"),
      m.items.length ? m.items.map((job) => h("article", { className: "studio-job" },
        h("div", {}, h("strong", {}, m.catalog?.templates.find((t) => t.id === job.templateId)?.name || "우리 여행"),
          h("p", { className: "meta" }, generationState(job), activeGeneration(job) ? ` · ${job.progress.completedShots}/${job.progress.totalShots} 장면` : "")),
        job.state === "completed" ? button("영상 열기", () => run(s, () => receive(s, job)), s.working) :
          activeGeneration(job) ? button("제작 취소", () => run(s, () => m.cancel(job.id)), s.working) : null)) : h("p", { className: "meta" }, "완성한 쇼츠가 여기에 모여요."));
    let player;
    if (s.file) {
      // 다시 그릴 때에도 재생 중인 video 요소와 위치를 유지합니다.
      s.video ??= h("video", { controls: true, playsInline: true, src: s.url, className: "studio-video", "aria-label": "완성된 쇼츠" });
      player = h("section", { className: "studio-result" }, s.video,
        h("div", { className: "studio-actions" },
          button("영상 저장", () => run(s, async () => { const job = m.items.find((j) => j.id === s.selected); if (!job) throw new Error("영상 상태를 다시 확인해 주세요."); await receive(s, job); const a = h("a", { href: s.url, download: s.file.name }); document.body.append(a); a.click(); a.remove(); }), s.working, "primary"),
          button("공유", async () => { try {
            const job = await m.call("GET", m.path(`/short-generations/${encodeURIComponent(s.selected)}`));
            if (job.state !== "completed") throw new Error("영상이 취소되었어요.");
            await navigator.share({ files: [s.file], title: "우리 여행의 쇼츠" });
          } catch (e) { if (e.name !== "AbortError") { clearVideo(s); toast(e.message); if (session === s) paint(s); } } }, s.working || !navigator.canShare?.({ files: [s.file] }))),
        h("p", { className: "meta" }, "저장한 영상은 동의를 꺼도 기기에 남아요. 파일 공유가 없는 브라우저에서는 저장한 뒤 공유해 주세요."));
    }
    s.body.replaceChildren(
      h("p", { className: "studio-kicker" }, "우리 목소리, 하나의 짧은 이야기"),
      h("div", { className: "studio-heading" }, h("h2", {}, "우리 여행의 쇼츠"), button("닫기", close)),
      h("p", { className: "meta" }, "남겨 둔 대화에서 장면을 추천해요. 원래 목소리와 자막을 함께 담아요."),
      h("div", { className: "studio-template" }, select, button("장면 다시 추천", () => { s.consent = false; run(s, () => m.preview(s.template, s.audio)); }, locked || !m.catalog)),
      plan ? h("section", { className: "studio-plan" },
        h("div", { className: "studio-cast", "aria-label": "등장 캐릭터 두 명" }, plan.cast.map((c) => Object.assign(characterImage(c.character), { alt: c.name }))),
        h("h3", {}, plan.title), h("p", { className: "meta" }, `${Math.round(plan.seconds)}초 · 세로 영상 · ${plan.shots.length}개 장면`),
        h("p", { className: "studio-quote" }, plan.cues[0]?.text || "우리의 대화"),
        h("details", {}, h("summary", {}, "전체 자막과 장면 구성"),
          h("ol", { className: "studio-cues" }, plan.cues.map((c) => h("li", {}, `${c.start.toFixed(1)}초 · ${c.text}`))),
          h("p", { className: "meta" }, plan.warnings.join(" ")))) : h("p", { className: "meta" }, m.items.length ? "제작한 쇼츠를 아래에서 확인하거나 새 장면을 추천받으세요." : "15~45초의 원음과 자막이 있는 장면을 준비해 주세요."),
      toggle("원음을 외부 영상 제작에도 사용해요 (선택)", s.audio, (value) => { s.audio = value; s.consent = false; run(s, () => m.preview(s.template, value)); }),
      h("p", { className: "meta" }, "최종 영상에는 이 선택과 관계없이 원래 목소리가 들어가요."),
      toggle(`캐릭터 이미지와 반응 시각${s.audio ? ", 선택한 원음" : ""}을 Higgsfield에 보내 영상 제작에 사용하는 데 동의해요.`, s.consent, (value) => { s.consent = value; paint(s); }, s.working || !m.catalog?.enabled),
      h("div", { className: "studio-actions" }, button(m.pending ? "이전 요청 접수 확인" : "AI 쇼츠 만들기", () => run(s, () => m.submit(s.consent)), s.working || !m.catalog?.enabled || !s.consent || (!plan && !m.pending), "primary"),
        button("기본 영상으로 만들기", () => { close(); onLocal(); }, s.working)),
      !m.catalog?.enabled ? h("p", { className: "studio-notice" }, "AI 영상 제작을 준비하고 있어요. 지금은 구성을 미리 보거나 기본 영상을 만들 수 있어요.") : h("p", { className: "meta" }, "제작은 화면을 닫아도 이어져요. 같은 여행에서 다시 확인할 수 있어요."),
      status, ...(player ? [player] : []), jobs,
      button("제작 상태 새로고침", () => run(s, () => m.refresh()), s.working));
  }
  function open() {
    close();
    const t = getTrip(), p = getParticipant();
    if (!t || !p || !getToken()) return toast("먼저 여행에 연결해 주세요.");
    const s = { code: t.code, generation: t.generation, participant: p.id, token: getToken(), template: "car-sitcom-v1", audio: false, consent: false, focus: document.activeElement };
    if (!valid(s)) return toast("주차한 뒤 모두의 기록 동의를 확인해 주세요.");
    const key = `gachita:short-request:${s.code}:${p.id}:${s.generation}`;
    let pending;
    try { pending = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return toast("제작 요청 보관함을 읽지 못했어요."); }
    if (pending) { s.template = pending.templateId; s.audio = pending.audioReference; }
    s.model = new ShortGeneration({ code: s.code, generation: s.generation, pending, canRead: () => session === s && valid(s),
      savePending: (value) => value ? sessionStorage.setItem(key, JSON.stringify(value)) : sessionStorage.removeItem(key),
      request: (method, path, body, signal) => api(method, path, body, s.token, signal) });
    s.body = h("div", { className: "studio-body" });
    s.dialog = h("dialog", { className: "short-studio", "aria-label": "쇼츠 제작", oncancel: (e) => { e.preventDefault(); close(); } }, s.body);
    session = s; document.body.append(s.dialog); s.dialog.showModal();
    run(s, async () => { await s.model.load(); if (!pending) await s.model.preview(s.template); });
    s.timer = setInterval(() => {
      sync();
      if (session === s && !s.working && !s.polling && !document.hidden) {
        s.polling = true;
        const before = JSON.stringify(s.model.items);
        s.model.refresh().then(async () => {
          if (s.file) {
            const job = await s.model.call("GET", s.model.path(`/short-generations/${encodeURIComponent(s.selected)}`));
            if (job.state !== "completed") clearVideo(s);
          }
          if (session === s && before !== JSON.stringify(s.model.items)) paint(s);
        }).catch((e) => { if (session === s) { clearVideo(s); s.error = e.message; paint(s); } }).finally(() => { s.polling = false; });
      }
    }, 5000);
  }
  return { open, sync, close };
}
