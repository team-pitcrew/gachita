// 선택한 장면 공유(T81). 목록은 프로필 토큰으로, 공유 실행은 이 폰의 참가자 토큰으로만 한다.
import { api, h, toast } from "./shared.js";
import { shareCardPng } from "./share-card.js";

const KEEP_MS = 48 * 3600 * 1000;
const button = (label, onclick, className = "") => h("button", { type: "button", className, onclick }, label);
const when = (at) => new Date(at).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
const hasLocation = (item) => Number.isFinite(item.lat) && Number.isFinite(item.lng);
const errorText = (e) => e.status === 0 ? "연결을 확인하지 못해 공유 내용을 닫았어요. 다시 연결한 뒤 확인해 주세요." : e.status === 401 ? "이 폰의 프로필 연결을 다시 확인해 주세요." : e.message;

export function shareIconButton(kind, label, onclick, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", kind === "download" ? "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" : "M9 8V4l-6 6 6 6v-4h5a6 6 0 0 1 6 6v2-9a3 3 0 0 0-3-3Z");
  if (kind === "share") path.setAttribute("transform", "translate(24 0) scale(-1 1)");
  svg.append(path);
  return h("button", { type: "button", className: `share-icon ${className}`, "aria-label": label, title: label, onclick }, svg);
}

// 공개 여행의 장면 목록만으로는 소유권을 알 수 없다. 내 앨범과 같은 여행의 교집합만 표시한다.
// 앨범은 GET /profiles/me/moments?trip=<코드>(#216)로 그 여행 것만 자르지 않고 받는다 — 발화와 섞어 100개로
// 자르는 피드에서 고르면 장면 뒤에 발화가 쌓일 때 내 장면이 사라졌다(Astra #206).
export function shareOptions(trip, items, profileId) {
  const ids = new Set(trip.moments.map((m) => m.id));
  return {
    moments: items.filter((m) => m.tripCode === trip.code && ids.has(m.id)),
    recipients: trip.participants.filter((p) => p.profileId && p.profileId !== profileId && p.consent),
  };
}

export function createShares({ getProfile, getProfileToken, getTrip, getParticipant, getParticipantToken, onProfile }) {
  const dialog = h("dialog", { className: "shares-dialog", "aria-labelledby": "shares-title" });
  document.body.append(dialog);
  let state = null;
  let timer;
  let expiryTimer;
  const stop = () => {
    clearTimeout(timer);
    clearInterval(expiryTimer);
    state?.read?.abort();
    state?.write?.abort();
    state?.download?.abort();
  };
  const close = () => {
    stop();
    state = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
  };
  dialog.addEventListener("close", () => { if (!dialog.open) close(); });
  addEventListener("hashchange", close);
  const valid = (s) => {
    if (state !== s || getProfile()?.id !== s.profileId || getProfileToken() !== s.profileToken) return false;
    if (s.mode === "list") return true;
    const trip = getTrip();
    const me = getParticipant();
    return trip?.code === s.code && trip.generation === s.generation && me?.id === s.participantId && me.profileId === s.profileId && me.consent && getParticipantToken() === s.participantToken && Date.now() < trip.createdAt + KEEP_MS;
  };
  const sync = () => {
    if (state && !valid(state)) {
      close();
      toast("프로필이나 기록 동의가 바뀌어 공유 화면을 닫았어요.");
    } else if (state?.mode === "list" && state.items.some((item) => Date.now() >= item.expiresAt)) {
      state.items = state.items.filter((item) => Date.now() < item.expiresAt);
      state.snapshot = JSON.stringify(state.items);
      listView(state);
    }
  };
  // 보내기·회수의 결과와 오류는 모달 안에 둔다(모달이 최상위 레이어라 #toast는 그 뒤에 가려진다).
  // 결과가 불명확하면(응답 유실) 다시 보내 중복 공유를 만들지 않게 '보낸 공유 확인'을 함께 준다.
  const shell = (s, title, ...content) => {
    if (!valid(s)) return sync();
    dialog.replaceChildren(
      h("div", { className: "between" }, h("h1", { id: "shares-title" }, title), button("닫기", close, "plain")),
      ...[s.note && h("div", { role: s.note.alert ? "alert" : "status", className: s.note.alert ? "shares-note alert" : "shares-note" }, h("p", {}, s.note.text), s.note.checkSent && button("보낸 공유 확인", () => openList("sent"))), ...content].filter(Boolean),
    );
  };
  const note = (s, text, { alert = false, checkSent = false } = {}) => (s.note = { text, alert, checkSent });
  const show = (s) => {
    stop();
    state = s;
    expiryTimer = setInterval(sync, 1000);
    shell(s, "장면 공유", h("p", { role: "status" }, "공유할 수 있는 내용을 확인하고 있어요."));
    if (state === s && !dialog.open) dialog.showModal();
  };
  const profileState = () => ({ profileId: getProfile()?.id, profileToken: getProfileToken() });

  async function openList(direction = "received", message = "") {
    const identity = profileState();
    if (!identity.profileId || !identity.profileToken) return onProfile();
    const s = { ...identity, mode: "list", direction, items: [], removed: new Set(), pending: new Set(), note: message ? { text: message } : null };
    show(s);
    await load(s);
  }
  async function openCompose() {
    const trip = getTrip();
    const me = getParticipant();
    const identity = profileState();
    if (!identity.profileId || !identity.profileToken) return onProfile();
    if (!trip || me?.profileId !== identity.profileId || !me.consent || !getParticipantToken()) return toast("이 폰의 프로필로 참가하고 기록에 동의해야 공유할 수 있어요.");
    if (Date.now() >= trip.createdAt + KEEP_MS) return toast("이 여행의 공유 기간이 지났어요.");
    const s = { ...identity, mode: "compose", code: trip.code, generation: trip.generation, participantId: me.id, participantToken: getParticipantToken(), stage: "pick", selected: new Set(), caption: "", includeLocation: false };
    show(s);
    await load(s);
  }
  async function load(s) {
    if (!valid(s)) return sync();
    if (s.loading || s.saving) return;
    clearTimeout(timer);
    s.loading = true;
    const controller = s.read = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      if (s.mode === "list") {
        const { items } = await api("GET", "/profiles/me/shares", null, s.profileToken, controller.signal);
        if (!valid(s) || s.read !== controller) return;
        s.items = items.filter((item) => !s.removed.has(item.id) && Date.now() < item.expiresAt);
        const snapshot = JSON.stringify(s.items);
        if (snapshot !== s.snapshot) { s.snapshot = snapshot; listView(s); }
      } else {
        const [trip, album] = await Promise.all([
          api("GET", `/trips/${encodeURIComponent(s.code)}`, null, undefined, controller.signal),
          api("GET", `/profiles/me/moments?trip=${encodeURIComponent(s.code)}`, null, s.profileToken, controller.signal),
        ]);
        if (!valid(s) || s.read !== controller) return;
        if (trip.generation !== s.generation || Date.now() >= trip.createdAt + KEEP_MS || !trip.participants.some((p) => p.id === s.participantId && p.profileId === s.profileId && p.consent)) {
          close();
          return toast("기록 동의나 보관 기간이 바뀌어 공유할 수 없어요.");
        }
        const options = shareOptions(trip, album.items, s.profileId);
        const snapshot = JSON.stringify(options);
        s.expiresAt = trip.createdAt + KEEP_MS;
        if (snapshot !== s.snapshot) {
          s.snapshot = snapshot;
          s.options = options;
          s.selected = new Set([...s.selected].filter((id) => options.recipients.some((p) => p.id === id)));
          if (!options.moments.some((m) => m.id === s.momentId)) s.stage = "pick";
          else if (s.stage === "preview") s.stage = "edit"; // 대상·원본이 바뀌면 다시 확인한다.
          composeView(s);
        }
      }
      s.stopped = false;
      s.authError = false;
    } catch (e) {
      if (valid(s) && s.read === controller) {
        s.items = [];
        s.options = null;
        s.snapshot = undefined;
        if (s.stage === "preview") s.stage = "edit";
        s.stopped = e.status === 401 || e.status === 403 || (s.mode === "compose" && e.status === 404);
        shell(s, "공유 내용을 확인할 수 없어요", h("p", { role: "alert" }, errorText(e)), button(e.status === 401 ? "프로필 확인" : "다시 확인", () => e.status === 401 ? (close(), onProfile()) : load(s)));
      }
    } finally {
      clearTimeout(timeout);
      if (s.read === controller) {
        s.read = null;
        s.loading = false;
        sync();
        if (valid(s) && !s.stopped) timer = setTimeout(() => load(s), 5000);
      }
    }
  }

  function listView(s) {
    const items = s.items.filter((item) => item.direction === s.direction && Date.now() < item.expiresAt);
    shell(s, s.direction === "received" ? "받은 공유" : "보낸 공유",
      h("p", { className: "meta" }, "여행을 만든 뒤 48시간까지 볼 수 있어요. 회수·동의 철회·원본 삭제 뒤에는 보이지 않아요. 다운로드한 이미지는 회수해도 남아요."),
      h("div", { className: "shares-actions" }, button("받은 공유", () => openList("received")), button("보낸 공유", () => openList("sent"))),
      items.length ? h("ul", { className: "shares-list" }, items.map((item) => {
        const revokeButton = shareIconButton("revoke", "공유 회수", () => revoke(s, item));
        revokeButton.disabled = s.pending.has(item.id) || s.saving === item.id;
        const downloadButton = shareIconButton("download", s.saving === item.id ? "이미지 준비 중" : "공유 이미지 다운로드", () => download(s, item));
        downloadButton.disabled = !!s.saving || s.pending.has(item.id);
        downloadButton.setAttribute("aria-busy", String(s.saving === item.id));
        return h("li", { className: "card" },
          h("h2", {}, item.label || "이름 없는 장면"),
          h("p", { className: "meta" }, `${item.sender.name} 님이 보냄 · ${when(item.at)}`),
          item.direction === "sent" && h("p", { className: "meta" }, `받는 사람: ${item.recipients.map((p) => p.name).join(", ")}`),
          h("p", { className: "shares-caption" }, item.caption || "추가 문구 없음"),
          h("p", { className: "meta" }, hasLocation(item) ? `함께 보낸 위치: ${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}` : "위치는 공유하지 않았어요."),
          h("p", { className: "meta" }, `${when(item.expiresAt)}까지`),
          h("div", { className: "shares-actions shares-tools" }, downloadButton, item.direction === "sent" && revokeButton),
        );
      })) : h("p", { className: "empty", role: "status" }, s.direction === "received" ? "아직 받은 공유가 없어요." : "아직 보낸 공유가 없어요."),
      Object.assign(button(s.authError ? "프로필 확인" : "새로 고침", () => s.authError ? (close(), onProfile()) : load(s)), { disabled: !!s.saving }),
    );
  }
  async function download(s, item) {
    if (!valid(s) || s.saving || s.pending.has(item.id) || Date.now() >= item.expiresAt) return sync();
    // 앞선 폴링의 늦은 200이 권한 재확인 실패 뒤 내용을 되살리지 못하게 한다.
    clearTimeout(timer);
    s.read?.abort();
    s.read = null;
    s.loading = false;
    s.saving = item.id;
    s.note = null;
    listView(s);
    const controller = s.download = new AbortController();
    let timeout;
    const current = () => valid(s) && !controller.signal.aborted && !s.removed.has(item.id);
    const fresh = async () => {
      const { items } = await api("GET", "/profiles/me/shares", null, s.profileToken, controller.signal);
      const found = items.find((entry) => entry.id === item.id && Date.now() < entry.expiresAt);
      if (!current()) throw new Error("공유 화면을 닫았어요.");
      if (!found) {
        s.items = s.items.filter((entry) => entry.id !== item.id);
        s.removed.add(item.id);
        throw new Error("회수·동의 변경·삭제·기간 만료로 다운로드할 수 없어요.");
      }
      return found;
    };
    try {
      // 열린 화면의 옛 내용으로 저장하지 않는다. 변환 전과 저장 직전에 서버 권한을 확인한다.
      const result = await Promise.race([
        (async () => {
          const allowed = await fresh();
          const blob = await shareCardPng(allowed);
          const latest = await fresh();
          return { blob, expiresAt: latest.expiresAt };
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("이미지 저장을 준비하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.")); }, 10000); }),
      ]);
      if (!current() || Date.now() >= result.expiresAt) return sync();
      const url = URL.createObjectURL(result.blob);
      const link = h("a", { href: url, download: `gachita-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.png` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      note(s, "이미지 다운로드를 시작했어요. 저장한 파일은 공유를 회수해도 남아요.");
    } catch (e) {
      if (valid(s)) {
        s.items = [];
        s.snapshot = undefined;
        s.authError = e.status === 401 || e.status === 403;
        s.stopped = s.authError;
        note(s, e.status ? errorText(e) : e.message, { alert: true });
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
      s.saving = null;
      if (valid(s)) {
        listView(s);
        if (!s.stopped) timer = setTimeout(() => load(s), 5000);
      }
    }
  }
  async function revoke(s, item) {
    if (!valid(s) || s.pending.has(item.id) || s.saving === item.id || !confirm("이 공유를 회수할까요? 앱에서는 더 이상 보이지 않지만, 이미 다운로드한 파일은 남아요.")) return;
    s.pending.add(item.id);
    s.note = null;
    listView(s);
    const controller = s.write = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      await api("DELETE", `/profiles/me/shares/${encodeURIComponent(item.id)}`, null, s.profileToken, controller.signal).catch((e) => { if (e.status !== 404) throw e; });
      if (!valid(s)) return;
      s.removed.add(item.id);
      s.items = s.items.filter((entry) => entry.id !== item.id);
      s.snapshot = JSON.stringify(s.items);
      note(s, "공유를 회수했어요.");
      listView(s);
    } catch (e) { if (valid(s)) note(s, e.status === 0 ? "회수 결과를 확인하지 못했어요. 보낸 공유를 새로 고쳐 확인해 주세요." : errorText(e), { alert: true }); }
    finally { clearTimeout(timeout); s.pending.delete(item.id); if (valid(s)) listView(s); }
  }
  function composeView(s) {
    if (!s.options) return;
    if (s.stage === "pick") {
      shell(s, "내 장면 공유", h("p", { className: "meta" }, "이 여행에서 내 앨범에 남긴 장면만 고를 수 있어요. 대화 원문이나 소리는 보내지 않아요."),
        s.options.moments.length ? h("ul", { className: "shares-list" }, s.options.moments.map((m) => h("li", { className: "card" }, h("h2", {}, m.label || "이름 없는 장면"), h("p", { className: "meta" }, when(m.at)), shareIconButton("share", "이 장면 공유", () => { s.momentId = m.id; s.stage = "edit"; s.selected.clear(); s.caption = ""; s.includeLocation = false; composeView(s); })))) : h("p", { className: "empty", role: "status" }, "공유할 내 장면이 없어요. 먼저 장면을 내 앨범에 남겨 주세요."));
      return;
    }
    const moment = s.options.moments.find((m) => m.id === s.momentId);
    if (!moment) { s.stage = "pick"; return composeView(s); }
    const recipients = s.options.recipients.filter((p) => s.selected.has(p.id));
    if (!hasLocation(moment)) s.includeLocation = false;
    if (s.stage === "preview") {
      shell(s, "보내기 전에 확인해 주세요",
        h("section", { className: "card" }, h("h2", {}, moment.label || "이름 없는 장면"), h("p", { className: "meta" }, when(moment.at)), h("p", { className: "shares-caption" }, s.caption.trim() || "추가 문구 없음"), h("p", {}, `받는 사람: ${recipients.map((p) => p.name).join(", ")}`), h("p", {}, s.includeLocation ? `위치 포함: ${moment.lat.toFixed(5)}, ${moment.lng.toFixed(5)}` : "위치 제외"), h("p", { className: "meta" }, `${when(s.expiresAt)}까지 볼 수 있어요.`)),
        h("p", { className: "meta" }, "위 내용만 선택한 동승자에게 보냅니다. 대화 원문과 원음은 포함하지 않아요. 받는 사람은 이미지로 다운로드할 수 있고, 저장한 파일은 공유를 회수해도 남아요."),
        h("div", { className: "shares-actions" }, Object.assign(button("수정하기", () => { s.stage = "edit"; composeView(s); }), { disabled: !!s.sending }), Object.assign(shareIconButton("share", s.sending ? "공유 중" : "이 내용으로 공유", () => send(s), "primary"), { disabled: !!s.sending || !recipients.length })),
      );
      return;
    }
    const preview = h("button", { type: "submit", className: "primary", disabled: !recipients.length }, "내용 미리보기");
    shell(s, "장면 공유 내용 고르기",
      h("h2", {}, moment.label || "이름 없는 장면"),
      h("form", { onsubmit: (e) => { e.preventDefault(); if (s.selected.size) { s.stage = "preview"; composeView(s); } } },
        h("label", { className: "field" }, h("span", {}, "함께 보낼 문구 · 500자 이내"), h("textarea", { value: s.caption, maxLength: 500, rows: 4, placeholder: "전하고 싶은 말을 직접 확인해 주세요.", oninput: (e) => { s.caption = e.target.value; } })),
        h("fieldset", {}, h("legend", {}, "받는 동승자"), s.options.recipients.length ? s.options.recipients.map((p) => h("label", { className: "shares-target" }, h("input", { type: "checkbox", checked: s.selected.has(p.id), onchange: (e) => { e.target.checked ? s.selected.add(p.id) : s.selected.delete(p.id); preview.disabled = !s.selected.size; } }), `${p.name} 님`)) : h("p", { className: "empty" }, "지금 받을 수 있는 동승자가 없어요. 같은 여행에서 프로필로 참가하고 기록에 동의해야 해요.")),
        h("label", { className: "shares-target" }, h("input", { type: "checkbox", checked: s.includeLocation, disabled: !hasLocation(moment), onchange: (e) => { s.includeLocation = e.target.checked; } }), hasLocation(moment) ? "이 장면의 위치도 함께 보내기" : "이 장면에는 위치 정보가 없어요."),
        preview,
      ),
      button("다른 장면 고르기", () => { s.stage = "pick"; composeView(s); }, "plain"),
    );
  }
  async function send(s) {
    if (!valid(s) || s.sending || s.stage !== "preview" || !s.options) return sync();
    const recipients = s.options.recipients.filter((p) => s.selected.has(p.id));
    if (!recipients.length || !s.options.moments.some((m) => m.id === s.momentId)) return;
    s.sending = true;
    composeView(s);
    const controller = s.write = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      await api("POST", `/trips/${encodeURIComponent(s.code)}/shares`, { momentId: s.momentId, recipientIds: recipients.map((p) => p.id), caption: s.caption.trim(), includeLocation: s.includeLocation, generation: s.generation }, s.participantToken, controller.signal);
      if (!valid(s)) return;
      await openList("sent", "선택한 동승자에게 공유했어요.");
    } catch (e) {
      if (valid(s)) {
        s.sending = false;
        s.stage = "edit";
        const unclear = e.status === 0;
        note(s, unclear ? "공유 결과를 확인하지 못했어요. 다시 보내기 전에 보낸 공유에서 먼저 확인해 주세요." : errorText(e), { alert: true, checkSent: unclear });
        await load(s);
        if (valid(s) && s.options) composeView(s);
      }
    } finally { clearTimeout(timeout); }
  }
  return { openList, openCompose, close, sync };
}
