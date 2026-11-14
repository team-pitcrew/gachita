import { api, h, SEAT } from "./shared.js";
import qrcode from "./qrcode.js";
import { characterImage } from "./short-film.js";

const KEY = "gachita:ride";
const button = (label, onclick, className = "", disabled = false) => h("button", { type: "button", onclick, className, disabled }, label);
export const remainingTime = (expiresAt, now = Date.now()) => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
function qrSvg(text) {
  const qr = qrcode(0, "M"); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), d = [];
  for (let row = 0; row < n; row++) for (let column = 0; column < n; column++) if (qr.isDark(row, column)) d.push(`M${column + 4} ${row + 4}h1v1h-1z`);
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => Object.entries(attrs).reduce((node, [key, value]) => (node.setAttribute(key, value), node), document.createElementNS(ns, tag));
  const svg = el("svg", { viewBox: `0 0 ${n + 8} ${n + 8}`, class: "boarding-qr", role: "img", "aria-label": "참석 QR", "shape-rendering": "crispEdges", "data-payload": text });
  svg.append(el("rect", { width: n + 8, height: n + 8, fill: "#fff" }), el("path", { d: d.join(""), fill: "#000" }));
  return svg;
}

// 프로필 토큰은 조회·발급에, 폰에만 발급된 참가자 토큰은 본인 동의에 쓴다.
export function createBoarding({ getProfile, getToken, consentText, consentOffMessage, onLinked, onDecision, onLeave }) {
  let state;
  const readSaved = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } };
  const save = (s, ride) => {
    s.ride = ride;
    if (ride) sessionStorage.setItem(KEY, JSON.stringify({ ...ride, profileId: s.profileId }));
    else sessionStorage.removeItem(KEY);
  };
  const valid = (s) => state === s && getProfile()?.id === s.profileId && getToken() === s.profileToken;
  function close() { const s = state; if (!s) return; state = null; clearInterval(s.timer); s.controller.abort(); s.dialog.close(); s.dialog.remove(); s.focus?.focus(); }
  const sync = () => { if (state && !valid(state)) close(); };
  async function request(s, method, path, body, token = s.profileToken) {
    if (!valid(s)) throw new Error("프로필을 다시 확인해 주세요.");
    const controller = new AbortController(), abort = () => controller.abort();
    s.controller.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 10000);
    try {
      const result = await api(method, path, body, token, controller.signal);
      if (!valid(s)) throw new Error("프로필이 바뀌었어요.");
      return result;
    } finally { clearTimeout(timeout); s.controller.signal.removeEventListener("abort", abort); }
  }
  function begin() {
    close(); const profile = getProfile();
    if (!profile || !getToken()) return null;
    const s = { profileId: profile.id, profileToken: getToken(), controller: new AbortController(), phase: "qr", busy: false, checking: false, error: "", focus: document.activeElement };
    s.dialog = h("dialog", { className: "boarding-dialog", "aria-label": "참석 QR과 동승 연결", oncancel: (event) => { event.preventDefault(); dismiss(s); } });
    state = s; document.body.append(s.dialog); s.dialog.showModal();
    return s;
  }
  async function connection(s) {
    s.phase = "connecting"; paint(s);
    const trip = await request(s, "GET", `/trips/${s.joined.code}`);
    const me = trip.participants.find((person) => person.id === s.joined.participant.id && person.profileId === s.profileId);
    if (!me) throw new Error("연결된 자리를 찾지 못했어요. 차에서 동승자 설정을 확인해 주세요.");
    s.trip = trip; s.joined.participant = me; s.phase = me.consent ? "complete" : "consent";
  }
  async function linked(s, result) {
    const ride = s.ride;
    const joined = { code: result.tripCode, participant: result.participant, token: ride.token };
    onLinked(joined); // 저장이 끝나기 전에는 1회 연결의 토큰을 지우지 않는다.
    s.joined = joined;
    save(s, null); s.qr = null; s.error = "";
    await connection(s);
  }
  async function poll(s, duringWrite = false) {
    if (!valid(s) || !s.ride || s.checking || (s.busy && !duringWrite)) return;
    s.checking = true;
    try {
      const result = await request(s, "GET", `/ride-links/${s.ride.id}`);
      s.error = ""; s.checked = true;
      if (result.status === "linked") await linked(s, result);
    } catch (error) {
      if (!valid(s)) return;
      if (error.status === 404 && !s.joined) { save(s, null); s.qr = null; s.phase = "expired"; s.error = ""; }
      else { s.checked = false; s.error = error.status === 0 ? "연결 상태를 확인하지 못했어요. 다시 확인해 주세요." : error.message; }
    } finally { s.checking = false; if (valid(s)) paint(s); }
  }
  async function withdraw(s) {
    if (!s.ride) return true;
    try { await request(s, "DELETE", `/ride-links/${s.ride.id}`); }
    catch (error) {
      if (error.status === 409) { await poll(s, true); return false; }
      if (error.status !== 404) throw error;
    }
    save(s, null); s.qr = null; return true;
  }
  async function generate(s) {
    if (!valid(s) || s.busy || s.checking) return;
    s.busy = true; s.error = ""; paint(s);
    try {
      if (!(await withdraw(s))) return;
      const result = await request(s, "POST", "/ride-links", {});
      save(s, { id: result.id, qr: result.qr, expiresAt: result.expiresAt, token: result.participantToken });
      s.phase = "qr"; s.checked = true;
    } catch (error) { if (valid(s)) s.error = error.status === 0 ? "QR을 만들지 못했어요. 연결을 확인한 뒤 다시 눌러 주세요." : error.message; }
    finally { s.busy = false; if (valid(s)) paint(s); }
  }
  async function retry(s) {
    if (!valid(s) || s.busy || s.checking) return;
    if (!s.joined) return s.ride ? poll(s) : generate(s);
    s.busy = true; s.error = ""; paint(s);
    try { await connection(s); }
    catch (error) { if (valid(s)) s.error = error.message; }
    finally { s.busy = false; if (valid(s)) paint(s); }
  }
  function finish(s) { const joined = s.joined; close(); if (joined) onLeave(joined); }
  async function dismiss(s) {
    if (!valid(s) || s.busy || s.checking) return;
    if (s.joined) return finish(s);
    s.busy = true; s.error = ""; paint(s);
    try { if (await withdraw(s)) close(); }
    catch (error) { if (valid(s)) s.error = "QR을 닫지 못했어요. 연결을 확인한 뒤 다시 눌러 주세요."; }
    finally { s.busy = false; if (valid(s)) paint(s); }
  }
  async function decide(s, consent) {
    if (!valid(s) || s.busy || !s.joined || s.phase !== "consent") return;
    if (!consent && s.joined.participant.consent && !confirm(consentOffMessage)) return;
    s.busy = true; s.error = ""; paint(s);
    try {
      await request(s, "PATCH", `/trips/${s.joined.code}/participants/${s.joined.participant.id}`, { consent }, s.joined.token);
      await connection(s);
      if (s.joined.participant.consent !== consent) throw new Error("동의 상태가 바뀌었어요. 다시 확인해 주세요.");
      onDecision(s.joined); s.phase = "complete";
    } catch (error) { if (valid(s)) { s.error = error.status === 0 ? "동의 결과를 확인하지 못했어요. 다시 확인해 주세요." : error.message; s.phase = "connecting"; } }
    finally { s.busy = false; if (valid(s)) paint(s); }
  }
  function paint(s) {
    if (!valid(s)) return;
    const profile = getProfile(), me = s.joined?.participant;
    const ready = s.phase === "qr" && s.checked && s.ride && s.ride.expiresAt > Date.now();
    const expired = s.phase === "expired" || (s.ride && s.ride.expiresAt <= Date.now());
    const title = s.phase === "consent" ? "탔어요" : s.phase === "complete" ? "연결 완료" : "참석 QR";
    const heading = h("header", { className: "boarding-heading" }, button("닫기", () => dismiss(s), "plain", s.busy || s.checking), h("strong", {}, title));
    let body;
    if (s.phase === "consent") {
      body = h("section", { className: "boarding-content" }, h("h1", {}, `${profile.name} 님,`, h("br"), "이 자리에 앉았나요?"),
        h("div", { className: "boarding-seat" }, characterImage(profile.character), h("h2", {}, SEAT[me.seat] || "연결한 자리"), h("p", {}, s.trip.title || "함께한 여행")),
        h("h2", {}, "대화를 기록할까요?"), h("p", {}, "함께 나눈 목소리를 받아 적고, 고른 장면을 쇼츠로 남겨요. 모두 동의한 동안만 기록할 수 있어요."),
        h("p", { className: "meta" }, "내 동의는 기록을 허락하는 설정이에요. 실제 녹음은 차에서 따로 시작해요."),
        h("details", { className: "boarding-consent" }, h("summary", {}, "기록에 쓰는 정보와 보관·삭제 안내"), h("ul", {}, consentText.map((line) => h("li", {}, line)))),
        h("div", { className: "boarding-actions" }, button("동의하고 함께 타기", () => decide(s, true), "primary", s.busy), button("기록 없이 함께 타기", () => decide(s, false), "boarding-secondary", s.busy)),
        h("p", { className: "meta" }, "자리가 다르면 차의 동승자 설정에서 다시 골라 주세요."));
    } else if (s.phase === "complete") {
      body = h("section", { className: "boarding-content boarding-complete" }, characterImage(profile.character), h("h1", {}, `${profile.name} 님이`, h("br"), "함께 타고 있어요"),
        h("p", { className: "meta" }, `${SEAT[me.seat] || "연결한 자리"} · ${s.trip.title || "함께한 여행"}`),
        h("div", { className: "boarding-status" }, h("strong", {}, `내 기록 동의 ${me.consent ? "켜짐" : "꺼짐"}`), h("p", {}, me.consent ? "기록을 허락했어요. 실제 녹음은 모두 동의한 뒤 차에서 시작해요." : "기록에 동의하지 않고 함께 타고 있어요. 부탁과 여행 정보는 그대로 이용할 수 있어요.")),
        h("div", { className: "boarding-actions" }, button("여행으로 돌아가기", () => finish(s), "primary"), button("내 동의 설정", () => { s.phase = "consent"; paint(s); }, "boarding-secondary")));
    } else if (s.phase === "connecting") {
      body = h("section", { className: "boarding-content" }, h("h1", {}, "내 자리를 확인하고 있어요"), h("p", {}, "차에 연결했어요. 여행과 내 동의 상태를 확인해요."));
    } else {
      const code = ready ? s.qr ||= qrSvg(s.ride.qr) : null;
      s.countdown = h("p", { className: "boarding-countdown" }, ready ? `${remainingTime(s.ride.expiresAt)} 뒤 만료` : expired ? "QR이 만료됐어요" : "");
      body = h("section", { className: "boarding-content" }, h("h1", {}, "차에 QR을", h("br"), "보여 주세요"),
        h("div", { className: "boarding-person" }, characterImage(profile.character), h("div", {}, h("strong", {}, profile.name), h("p", {}, "오늘 함께 탈 사람"))),
        h("div", { className: "boarding-code" }, code || h("p", { role: "status" }, expired ? "새 QR로 다시 연결해 주세요." : s.error ? "연결을 확인해 주세요." : "QR을 준비하고 있어요.")),
        s.countdown, h("p", { className: "meta" }, "차에서 동승자 설정 → 참석 QR 읽기를 눌러 주세요."),
        button("QR 새로 만들기", () => generate(s), expired ? "primary" : "boarding-secondary", s.busy || s.checking),
        h("p", { className: "boarding-hint meta" }, "차가 읽으면 자동으로 다음 화면으로 넘어가요."));
    }
    s.dialog.replaceChildren(heading, body, ...[s.error && h("div", { className: "boarding-error", role: "alert" }, h("p", {}, s.error), button("다시 확인", () => retry(s), "boarding-secondary", s.busy || s.checking))].filter(Boolean));
  }
  async function open() {
    if (state && valid(state)) return;
    const s = begin(); if (!s) return;
    const saved = readSaved();
    if (saved && (!saved.profileId || saved.profileId === s.profileId)) s.ride = saved;
    else sessionStorage.removeItem(KEY);
    paint(s);
    if (s.ride) await poll(s); else await generate(s);
    if (!valid(s)) return;
    s.timer = setInterval(() => {
      sync(); if (!valid(s)) return;
      if (s.ride?.expiresAt <= Date.now() && s.qr) { s.qr = null; paint(s); }
      else if (s.countdown && s.ride?.expiresAt > Date.now()) s.countdown.textContent = `${remainingTime(s.ride.expiresAt)} 뒤 만료`;
      if (!document.hidden && !s.joined && Date.now() - (s.polledAt || 0) >= 2000) { s.polledAt = Date.now(); poll(s); }
    }, 1000);
  }
  function openConsent(trip, participant, token) {
    if (!token || participant.profileId !== getProfile()?.id) return;
    if (state?.joined?.code === trip.code && valid(state)) return;
    const s = begin(); if (!s) return;
    s.joined = { code: trip.code, participant, token }; s.trip = trip; s.phase = "consent"; paint(s);
  }
  return { open, openConsent, close, sync, resume: () => readSaved() && open() };
}
