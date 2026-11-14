import { api, h, toast, SEAT } from "./shared.js";
import { characterImage } from "./short-film.js";
import { meEnd } from "./ride.js";

const button = (label, onclick, disabled = false, className = "") => h("button", { type: "button", onclick, disabled, className }, label);
const time = (at) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const duration = (seconds) => `${Math.round(seconds)}초`;
export const sceneRevision = (scene) => JSON.stringify(scene && [scene.momentId, scene.startAt, scene.seconds, scene.clip, scene.cues]);
export function sceneClipPath(code, scene) {
  const path = `/api/trips/${encodeURIComponent(code)}/recordings/${encodeURIComponent(scene.momentId)}`;
  if (scene.clip !== path) throw new Error("장면의 원음 주소를 확인하지 못했어요.");
  return path;
}

export function createScenePicker({ getTrip, getParticipant, getToken, onChoose, onLocal, onCandidates, onCaptions, onShare }) {
  let state;
  const valid = (s) => state === s && getTrip()?.code === s.code && getTrip()?.generation === s.generation && getTrip()?.status !== "driving" && getParticipant()?.id === s.participantId && getParticipant()?.consent && getToken() === s.token;
  const clearAudio = (s) => { s.audioRequest?.abort(); s.audioRequest = null; s.audio?.pause(); s.audio?.removeAttribute("src"); s.audio?.load(); s.audio = null; if (s.url) URL.revokeObjectURL(s.url); s.url = null; s.audioLoading = false; };
  function close() { const s = state; if (!s) return; state = null; clearInterval(s.timer); s.read?.abort(); clearAudio(s); s.dialog.close(); s.dialog.remove(); }
  addEventListener("hashchange", close);
  function sync() { if (state && !valid(state)) { close(); toast("여행이나 기록 동의가 바뀌어 장면을 닫았어요."); } }
  const current = (s) => s.data?.scenes.find((scene) => scene.momentId === s.momentId);
  async function read(s) {
    if (!valid(s) || s.reading) return sync();
    s.reading = true; let changed = false;
    const controller = s.read = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const data = await api("GET", `/trips/${s.code}/shortform`, null, s.token, controller.signal);
      if (!valid(s)) return sync();
      if (data.generation !== s.generation) { close(); return toast("기록 동의가 바뀌었어요. 여행에서 다시 확인해 주세요."); }
      const before = sceneRevision(current(s));
      changed = JSON.stringify(s.data) !== JSON.stringify(data) || !!s.error;
      s.data = data; s.error = "";
      if (before !== sceneRevision(current(s))) clearAudio(s);
    } catch (e) {
      if (!valid(s)) return;
      s.error = e.message; s.data = null; clearAudio(s); changed = true;
    } finally {
      clearTimeout(timeout); s.reading = false;
      if (valid(s) && changed) paint(s);
    }
  }
  async function listen(s, scene) {
    if (!valid(s) || s.audioLoading) return;
    clearAudio(s); s.audioLoading = true; s.error = "";
    const revision = sceneRevision(scene), controller = s.audioRequest = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    paint(s);
    try {
      const response = await fetch(sceneClipPath(s.code, scene), { headers: { authorization: `Bearer ${s.token}` }, signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw Object.assign(new Error("원음을 불러오지 못했어요. 장면을 다시 확인해 주세요."), { status: response.status });
      const blob = await response.blob();
      if (!valid(s) || controller.signal.aborted || s.audioRequest !== controller) return sync();
      // 다운로드 중 철회·삭제·자막 변경이 생겼다면 받은 소리를 재생하지 않는다.
      const latest = await api("GET", `/trips/${s.code}/shortform`, null, s.token, controller.signal);
      if (!valid(s) || controller.signal.aborted || s.audioRequest !== controller) return;
      if (latest.generation !== s.generation) { close(); return toast("기록 동의가 바뀌었어요. 여행에서 다시 확인해 주세요."); }
      s.data = latest;
      if (revision !== sceneRevision(latest.scenes.find((x) => x.momentId === scene.momentId))) throw new Error("장면이 바뀌었어요. 다시 확인한 뒤 들어 주세요.");
      s.url = URL.createObjectURL(blob);
      s.audio = h("audio", { src: s.url, controls: true, preload: "metadata", "aria-label": `${scene.label || "선택 장면"} 원음` });
      s.audio.play().catch(() => {});
    } catch (e) {
      if (valid(s) && s.audioRequest === controller) {
        if ([401, 403, 410].includes(e.status)) { close(); toast("기록 동의와 이 폰의 연결을 다시 확인해 주세요."); }
        else s.error = controller.signal.aborted ? "원음을 받지 못했어요. 연결을 확인한 뒤 다시 들어 주세요." : e.message;
      }
    }
    finally { clearTimeout(timeout); if (s.audioRequest === controller) { s.audioLoading = false; if (valid(s)) paint(s); } }
  }
  function choose(s, id) { clearAudio(s); s.momentId = id; s.view = "detail"; s.error = ""; paint(s); }
  function paint(s) {
    if (!valid(s)) return;
    const trip = getTrip(), scene = current(s), moment = trip.moments.find((m) => m.id === s.momentId);
    const top = h("header", { className: "mobile-heading" }, button(s.view === "detail" ? "장면 목록" : "닫기", () => { if (s.view === "detail") { clearAudio(s); s.view = "list"; paint(s); } else close(); }, false, "plain"), h("span", { className: "meta" }, trip.title || "함께한 여행"), meEnd());
    let body;
    if (s.view === "detail") {
      const cast = s.data?.cast || [];
      const aiLength = scene && scene.seconds >= 15 && scene.seconds <= 45;
      const start = scene?.startAt ?? moment?.from ?? moment?.at;
      const end = scene ? start + scene.seconds * 1000 : moment?.to;
      body = h("section", { className: "scene-detail" }, h("p", { className: "eyebrow" }, "원음과 자막 확인"), h("h1", {}, scene?.label || moment?.label || "선택한 장면"),
        Number.isFinite(start) && h("p", { className: "meta" }, `${time(start)}${Number.isFinite(end) ? ` — ${time(end)}` : ""}${scene ? ` · ${duration(scene.seconds)}` : ""}`),
        !s.data ? h("p", { role: "status" }, s.error || "장면을 불러오고 있어요.") : scene ? h("div", {},
          h("section", { className: "scene-audio" }, h("h2", {}, "그때의 목소리"), s.audio || button(s.audioLoading ? "원음 불러오는 중" : "원음 듣기", () => listen(s, scene), s.audioLoading, "primary")),
          h("ol", { className: "scene-dialogue" }, scene.cues.map((cue) => {
            const person = cast.find((p) => p.participantId === cue.participantId);
            return h("li", {}, characterImage(person?.character || "basic"), h("div", {}, h("p", { className: "meta" }, `${person?.name || "말한 사람 미확인"}${person?.seat ? ` · ${SEAT[person.seat] || person.seat}` : ""} · ${time(scene.startAt + cue.start * 1000)}`), h("p", {}, cue.text)));
          })),
          button("이 장면 자막 수정", () => {
            const id = scene.momentId, code = s.code, generation = s.generation, token = s.token; close();
            onCaptions({ cues: scene.cues, onReturn: () => { if (getTrip()?.code === code && getTrip()?.generation === generation && getToken() === token && getParticipant()?.consent) open({ momentId: id }); } });
          }, false, "scene-text-action"),
          scene.cues.some((cue) => !cue.participantId) && h("p", { className: "meta" }, "말한 사람이 맞는지 확인해 주세요. 화자는 차의 대화 기록에서 고칠 수 있어요."),
          h("div", { className: "scene-next" }, button(aiLength ? "이 장면으로 쇼츠 만들기" : "기본 영상으로 만들기", () => { if (valid(s)) { close(); (aiLength ? onChoose : onLocal)(scene.momentId); } }, !scene.cues.length, "primary"),
            !scene.cues.length && h("p", { className: "meta" }, "자막이 준비되면 이 장면을 영상으로 만들 수 있어요."),
            !aiLength && h("p", { className: "meta" }, "이 장면은 기본 영상으로 남길 수 있어요. AI 쇼츠는 15~45초 장면을 골라 주세요."),
            onShare && button("장면 카드 나누기", () => { close(); onShare(scene.momentId); }, false, "scene-text-action")))
          : h("div", { className: "scene-waiting" }, h("h2", {}, moment ? "아직 준비된 원음이 없어요" : "이 장면을 찾을 수 없어요"), h("p", {}, moment ? "이 장면은 원음이 준비되면 쇼츠로 만들 수 있어요." : "장면 목록에서 다른 순간을 골라 주세요."), moment && button("다시 확인", () => read(s), s.reading)),
      );
    } else {
      const moments = trip.moments || [], ready = new Map((s.data?.scenes || []).map((x) => [x.momentId, x]));
      body = h("section", { className: "scene-list" }, h("p", { className: "eyebrow" }, "대화에서 영상으로"), h("h1", {}, "어떤 순간을 남길까요?"),
        h("p", { className: "meta" }, "원래 목소리와 자막을 확인하고 쇼츠로 만들어요."),
        moments.length ? h("div", { className: "scene-rows" }, [...moments].reverse().map((m) => {
          const clip = ready.get(m.id);
          return button(h("span", {}, h("strong", {}, m.label || "이름 없는 장면"), h("span", { className: "meta" }, `${time(m.at)} · ${clip ? duration(clip.seconds) : "원음 준비 중"}`), clip?.cues[0] && h("span", { className: "scene-excerpt" }, clip.cues[0].text)), () => choose(s, m.id), !s.data, "scene-row");
        })) : h("div", { className: "scene-empty" }, h("h2", {}, "아직 고른 장면이 없어요"), h("p", {}, "함께 나눈 대화에서 남길 순간을 골라 보세요.")),
        button("대화에서 새 장면 고르기", () => { close(); onCandidates(); }, false, "primary"));
    }
    s.dialog.replaceChildren(...[top, body, s.error && s.data ? h("p", { role: "alert", className: "scene-error" }, s.error) : null,
      !s.data && s.error ? h("div", { className: "scene-error" }, h("p", { role: "alert" }, s.error), button("다시 불러오기", () => read(s), s.reading)) : null].filter(Boolean));
  }
  async function open({ momentId } = {}) {
    close(); const trip = getTrip(), me = getParticipant(), token = getToken();
    if (!trip || !me?.consent || !token) return toast("동승 연결과 기록 동의를 먼저 확인해 주세요.");
    if (trip.status === "driving") return toast("주차한 뒤 장면을 확인할 수 있어요.");
    const s = { code: trip.code, generation: trip.generation, participantId: me.id, token, momentId, view: momentId ? "detail" : "list" };
    s.dialog = h("dialog", { className: "scene-picker", "aria-label": "쇼츠로 남길 장면", oncancel: (e) => { e.preventDefault(); close(); } });
    state = s; document.body.append(s.dialog); s.dialog.showModal(); paint(s); await read(s);
    if (valid(s)) s.timer = setInterval(() => { sync(); if (valid(s) && !document.hidden && !s.audioLoading) read(s); }, 5000);
  }
  return { open, close, sync };
}
