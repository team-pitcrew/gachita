// 수동 자막(T80). 원문·자동 결과는 읽기만 하고, 버전이 맞는 수정본만 별도로 저장한다.
import { h, toast } from "./shared.js";

const key = (row) => `${row.device}\n${row.seq}`;
export function captionSelection(rows, cues) {
  if (!cues) return rows;
  const keys = new Set(cues.map(key));
  return rows.filter((row) => keys.has(key(row)));
}
const shown = (row) => row.editedText ?? row.asrText ?? row.text;
const button = (text, onclick, className = "") => h("button", { type: "button", onclick, className }, text);
const when = (at) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function captionPatch(row, text, generation) {
  if (!Number.isInteger(row.editVersion)) throw new Error("자막 편집을 준비하고 있어요. 잠시 뒤 다시 열어 주세요.");
  if (text !== null && (!text.trim() || text.trim().length > 500)) throw new Error("자막은 1자부터 500자까지 적어 주세요.");
  return { text: text === null ? null : text.trim(), expectedVersion: row.editVersion, generation };
}

export function createCaptions({ getTrip, getParticipant, request, refreshTrip }) {
  const dialog = h("dialog", { className: "captions-dialog", "aria-labelledby": "captions-title" });
  document.body.append(dialog);
  let state = null;
  let pollTimer;
  const dirty = (s) => !!s?.selected && s.draft !== shown(s.selected);
  function close(force = false) {
    if (!force && dirty(state) && !confirm("저장하지 않은 자막을 버리고 닫을까요?")) return false;
    clearTimeout(pollTimer);
    state?.readController?.abort();
    state = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    return true;
  }
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  dialog.addEventListener("close", () => { if (!dialog.open) close(true); });
  addEventListener("hashchange", () => close(true));
  addEventListener("beforeunload", (e) => { if (dirty(state)) { e.preventDefault(); e.returnValue = ""; } });

  const valid = (s) => {
    const trip = getTrip();
    const me = getParticipant();
    return state === s && trip?.code === s.code && trip.generation === s.generation && me?.id === s.participantId && me.consent;
  };
  const sync = () => {
    if (state && !valid(state)) {
      close(true);
      toast("여행이나 기록 동의가 바뀌어 자막 화면을 닫았어요.");
    }
  };
  const shell = (s, ...children) => {
    if (!valid(s)) return;
    dialog.replaceChildren(
      h("div", { className: "between captions-heading" }, h("h1", { id: "captions-title" }, "자막 확인하기"), button("닫기", () => close(), "plain")),
      ...children.flat().filter((child) => child || child === 0),
    );
  };
  async function fail(s, e) {
    if (!valid(s)) return sync();
    if ([401, 403, 404].includes(e.status)) {
      close(true);
      toast(e.status === 404 ? "지워졌거나 찾을 수 없는 기록이에요." : "기록 동의와 이 폰의 연결을 다시 확인해 주세요.");
      await refreshTrip();
      return;
    }
    if (!s.selected) s.rows = [];
    s.error = e.status === 0 ? (s.selected ? "연결이 끊겨 마지막으로 받은 자막을 보여 드려요. 입력은 그대로 두었으니 다시 연결한 뒤 저장해 주세요." : "자막을 읽지 못했어요. 다시 연결한 뒤 눌러 주세요.") : e.message;
  }
  async function open({ cues, onReturn } = {}) {
    if (state && !close()) return;
    const trip = getTrip();
    const me = getParticipant();
    if (!trip || !me?.consent) return toast("기록에 동의한 참가자만 자막을 확인할 수 있어요.");
    const s = state = { code: trip.code, generation: trip.generation, participantId: me.id, rows: [], cues, onReturn, selected: null, draft: "", busy: false, error: "", conflict: false, revision: 0 };
    shell(s, h("p", { role: "status" }, "자막을 불러오고 있어요."));
    dialog.showModal();
    await load(s);
  }
  const pollLater = (s) => {
    if (state !== s) return;
    clearTimeout(pollTimer);
    if (valid(s)) pollTimer = setTimeout(() => load(s, false, true), 5000);
  };
  async function load(s, preserveDraft = false, background = false) {
    if (!valid(s)) return sync();
    if (s.reading && preserveDraft) { s.queuedCompare = true; return; }
    if (s.busy || s.reading) return pollLater(s);
    const revision = s.revision;
    const controller = s.readController = new AbortController();
    const interrupted = new Promise((resolve, reject) => controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("자막 읽기를 멈췄어요."), { status: 0 })), { once: true }));
    const timeout = setTimeout(() => controller.abort(), 10000);
    s.reading = true;
    if (!background) s.busy = true;
    if (!background && s.selected) editor(s);
    let repaint = !background;
    try {
      const data = await Promise.race([request(s.code, "GET", "/transcript", null, controller.signal), interrupted]);
      if (!valid(s)) return sync();
      if (revision !== s.revision) return;
      if (data.generation !== s.generation) { close(true); return toast("기록 동의가 바뀌었어요. 여행 화면에서 다시 확인해 주세요."); }
      const previousError = s.error;
      const rows = captionSelection(data.utterances, s.cues);
      repaint ||= !s.selected && JSON.stringify(s.rows) !== JSON.stringify(rows);
      s.error = "";
      s.rows = rows;
      const selectedKey = s.selected && key(s.selected);
      if (selectedKey) {
        const latest = s.rows.find((row) => key(row) === selectedKey);
        if (!latest) { close(true); return toast("이 자막이 지워졌어요."); }
        if (preserveDraft) {
          s.selected = latest;
          s.conflict = false;
          s.latest = null;
          s.notice = "내 입력은 유지했어요. 최신 자막과 비교한 뒤 다시 저장해 주세요.";
        } else if (latest.editVersion !== s.selected.editVersion) {
          repaint ||= !s.conflict || JSON.stringify(s.latest) !== JSON.stringify(latest);
          s.latest = latest;
          s.conflict = true;
          s.error = "다른 사람이 자막을 고쳤어요. 내 입력은 유지했어요. 최신 자막을 읽고 비교해 주세요.";
        } else if (JSON.stringify(latest) !== JSON.stringify(s.selected)) {
          if (!dirty(s)) s.draft = shown(latest);
          s.selected = latest;
          repaint = true;
        }
      }
      repaint ||= previousError !== s.error;
    } catch (e) {
      if (revision === s.revision) { const previousError = s.error; await fail(s, e); repaint ||= previousError !== s.error; }
    }
    finally {
      clearTimeout(timeout);
      s.reading = false;
      if (s.readController === controller) s.readController = null;
      if (!background) s.busy = false;
      if (valid(s) && revision === s.revision && repaint) s.selected ? editor(s) : list(s);
      if (valid(s) && s.queuedCompare) { s.queuedCompare = false; void load(s, true); }
      else pollLater(s);
    }
  }
  function list(s) {
    shell(s,
      h("p", { className: "meta" }, "받아쓴 원문과 자동 재전사는 남겨 두고, 화면에 보일 자막만 고쳐요. 말한 사람의 이름은 바꾸지 않아요."),
      s.error && h("p", { role: "alert" }, s.error),
      s.rows.length ? h("ul", { className: "captions-list" }, s.rows.map((row) => h("li", { className: "card" },
        h("p", { className: "meta" }, when(row.at), row.editedText != null ? " · 수동 수정" : row.asrText != null ? " · 자동 재전사" : " · 받아쓴 원문"),
        h("p", { className: "what" }, shown(row)),
        Number.isInteger(row.editVersion) ? button("자막 고치기", () => { s.selected = row; s.draft = shown(row); s.conflict = false; s.latest = null; s.error = ""; s.notice = ""; editor(s); }) : h("p", { className: "meta" }, "자막 편집을 준비하고 있어요."),
      ))) : !s.error && h("p", { className: "empty" }, "아직 받아쓴 자막이 없어요."),
      h("div", { className: "row" }, button("새로 읽기", () => load(s)), s.onReturn && button("장면으로 돌아가기", () => { const back = s.onReturn; if (close()) back(); }, "primary")),
    );
  }
  function editor(s) {
    const row = s.selected;
    const previous = dialog.querySelector("textarea");
    const focused = previous === document.activeElement;
    const selection = focused ? [previous.selectionStart, previous.selectionEnd] : null;
    const status = h("p", { className: "meta", role: "status" }, dirty(s) ? "저장하지 않은 변경이 있어요." : "저장된 자막이에요.");
    const notice = h("p", { role: "status", hidden: !s.notice }, s.notice || "");
    const save = button("변경 저장", () => saveCaption(s, s.draft), "primary");
    save.disabled = s.busy || s.conflict || !dirty(s);
    const input = h("textarea", { rows: 5, maxLength: 500, value: s.draft, disabled: s.busy, oninput: (e) => {
      s.draft = e.target.value;
      s.notice = "";
      notice.hidden = true;
      status.textContent = dirty(s) ? "저장하지 않은 변경이 있어요." : "저장된 자막이에요.";
      save.disabled = s.busy || s.conflict || !dirty(s);
    } });
    const cancel = button("취소", () => { s.selected = null; s.error = ""; s.notice = ""; list(s); });
    cancel.disabled = s.busy;
    const reset = button("수동 수정 지우기", () => confirm("수동 수정본을 지우고 자동 재전사 또는 받아쓴 원문을 표시할까요?") && saveCaption(s, null), "plain");
    reset.disabled = s.busy || s.conflict || row.editedText == null;
    const reload = button("최신 자막 다시 읽기", () => load(s, true));
    reload.disabled = s.busy;
    shell(s,
      h("p", { className: "meta" }, when(row.at)),
      h("section", { className: "card" }, h("h2", {}, "받아쓴 원문"), h("p", {}, row.text)),
      row.asrText != null && h("section", { className: "card" }, h("h2", {}, "자동 재전사"), h("p", {}, row.asrText)),
      h("section", { className: "card" }, h("h2", {}, "현재 저장된 자막"), h("p", {}, shown(row))),
      h("label", { className: "field" }, h("span", {}, "수정할 자막"), input), status,
      s.error && h("p", { role: "alert" }, s.error),
      notice,
      s.conflict && s.latest && h("section", { className: "card" }, h("h2", {}, "서버의 최신 자막"), h("p", {}, shown(s.latest))),
      s.conflict && reload,
      h("div", { className: "row" }, save, cancel), reset,
      s.onReturn && button("장면으로 돌아가기", () => { const back = s.onReturn; if (close()) back(); }),
    );
    if (focused && !input.disabled) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
  }
  async function saveCaption(s, text) {
    if (!valid(s) || s.busy || s.conflict) return;
    let body;
    try { body = captionPatch(s.selected, text, s.generation); }
    catch (e) { s.error = e.message; editor(s); return; }
    const selectedKey = key(s.selected);
    // 저장 전에 시작한 읽기는 뒤늦게 도착해도 새 버전을 되돌리지 못한다.
    s.revision++;
    s.readController?.abort();
    clearTimeout(pollTimer);
    s.busy = true;
    s.error = "";
    s.notice = "";
    s.latest = null;
    editor(s);
    try {
      const data = await request(s.code, "PATCH", `/captions/${encodeURIComponent(s.selected.device)}/${s.selected.seq}`, body);
      if (!valid(s)) return sync();
      if (data.generation !== s.generation) { close(true); return toast("기록 동의가 바뀌어 자막 화면을 닫았어요."); }
      s.rows = s.rows.map((row) => key(row) === selectedKey ? data.utterance : row);
      s.selected = data.utterance;
      s.latest = null;
      s.draft = shown(data.utterance);
      s.notice = text === null ? "수동 수정본을 지웠어요." : "변경을 저장했어요.";
      // 여행 재조회는 기다리지 않는다: 늦어져도 편집 잠금은 바로 풀고 자막 폴링(삭제·권한 확인)은 이어 간다.
      // 동의 세대가 바뀌었으면 재조회가 끝난 뒤 앱의 render()가 sync()로 이 화면을 닫는다.
      refreshTrip().catch(() => {});
    } catch (e) {
      if (e.status === 409 && valid(s)) {
        s.conflict = true;
        s.error = "다른 사람이 고쳤거나 기록 동의가 바뀌었어요. 내 입력은 유지했어요. 최신 자막을 읽고 비교해 주세요.";
        refreshTrip().catch(() => {});
      } else await fail(s, e);
    } finally {
      s.busy = false;
      if (valid(s)) editor(s);
      pollLater(s);
    }
  }
  return { open, close, sync };
}
