// 현재 참가 권한이 있는 여행의 녹취. 개인 피드나 앨범을 여행 전문으로 쓰지 않는다.
import { h, SEAT } from "./shared.js";

const date = (at) => new Date(at).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
const time = (at) => new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
const button = (text, onclick, className = "") => h("button", { type: "button", className, onclick }, text);

export function conversationAccess(session, trip, participant, token) {
  if (!trip || trip.code !== session.code) return "여행이 바뀌어 이 대화를 표시할 수 없어요.";
  if (!participant?.consent || participant.id !== session.participantId || trip.generation !== session.generation) return "기록 동의가 바뀌어 이 대화를 표시할 수 없어요.";
  if (!token) return "이 폰의 동승 연결을 다시 확인해 주세요.";
  return "";
}

export function transcriptLines(data) {
  return (Array.isArray(data?.utterances) ? data.utterances : [])
    .filter((line) => typeof (line.displayText ?? line.editedText ?? line.asrText ?? line.text) === "string")
    .map((line) => ({ ...line, shown: line.displayText ?? line.editedText ?? line.asrText ?? line.text }))
    .filter((line) => line.shown.trim())
    .sort((a, b) => a.at - b.at || a.seq - b.seq || String(a.device).localeCompare(String(b.device)));
}

export function createConversations({ getTrip, getParticipant, getToken, request, avatar, onCaptions, onShorts, onScenes }) {
  const dialog = h("dialog", { className: "conversations-dialog", "aria-labelledby": "conversation-title" });
  document.body.append(dialog);
  let state = null;
  let timer;
  let controller;
  const stop = () => { clearTimeout(timer); controller?.abort(); };
  const close = () => {
    stop();
    state = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
  };
  dialog.addEventListener("close", close);
  addEventListener("hashchange", close);

  const invalid = (s) => state !== s ? "" : conversationAccess(s, getTrip(), getParticipant(), getToken());
  const unavailable = (message) => {
    stop();
    const s = state;
    if (!s) return;
    s.lines = [];
    s.unavailable = message;
    paint(s);
  };
  const sync = () => { if (state && !state.unavailable) { const reason = invalid(state); if (reason) unavailable(reason); } };

  const who = (s, line) => getTrip()?.participants.find((person) => person.id === line.participantId);
  const speaker = (s, line) => who(s, line)?.name ?? SEAT[line.seatArea] ?? (line.seatArea?.startsWith("ROW_1") ? "앞줄" : line.seatArea?.startsWith("ROW_2") ? "뒷줄" : "말한 사람 미확인");
  const nav = (s) => h("nav", { className: "journey-tabs", "aria-label": "여행 메뉴" },
    button("여행", close),
    h("button", { type: "button", className: "selected", "aria-current": "page", onclick: () => { s.view = "list"; paint(s); } }, "대화"),
    button("쇼츠", () => { close(); onShorts(); }),
  );
  const bodyStatus = (message, retry) => h("div", { className: "conversation-empty", role: "status" },
    h("span", { className: "conversation-mark", "aria-hidden": "true" }, "“"),
    h("p", { className: "what" }, message),
    retry && button("다시 불러오기", retry),
  );

  function paint(s) {
    if (state !== s) return;
    const previous = dialog.querySelector(".conversation-body");
    const oldTop = previous?.scrollTop ?? 0;
    const nearEnd = previous && previous.scrollHeight - previous.clientHeight - oldTop < 80;
    const trip = getTrip();
    const participants = trip?.participants ?? [];
    const title = s.view === "thread" ? s.title : "대화 기록";
    const top = h("header", { className: "conversation-heading" },
      button(s.view === "thread" ? "이전" : "닫기", () => { if (s.view === "thread" && !s.unavailable) { s.view = "list"; paint(s); } else close(); }, "plain"),
      h("div", { className: "grow" }, h("h1", { id: "conversation-title" }, title), h("p", { className: "meta" }, s.view === "thread" ? `${date(s.createdAt)} · ${participants.length}명` : "차 안에서 함께 나눈 이야기")),
      h("span", { className: "record-state" }, getParticipant()?.consent ? "내 기록 동의 켜짐" : "내 기록 동의 꺼짐"),
    );
    let body;
    if (s.unavailable) body = bodyStatus(s.unavailable);
    else if (s.error) body = bodyStatus(s.error, () => load(s));
    else if (!s.ready) body = bodyStatus("대화를 불러오고 있어요");
    else if (s.view === "list") {
      const last = s.lines.at(-1);
      body = h("div", { className: "conversation-list" },
        h("p", { className: "section-label" }, "지금 연결된 여행"),
        h("button", { type: "button", className: "conversation-session", onclick: () => { s.view = "thread"; paint(s); } },
          h("span", { className: "session-faces", "aria-hidden": "true" }, participants.slice(0, 3).map((person) => avatar(person))),
          h("span", { className: "session-copy" }, h("strong", {}, s.title), h("span", { className: "session-preview" }, last ? `${speaker(s, last)} · ${last.shown}` : "첫 이야기를 기다리고 있어요"), h("span", { className: "meta" }, `${date(s.createdAt)} · 대화 ${s.lines.length}개`)),
          h("span", { className: "session-chevron", "aria-hidden": "true" }, "›"),
        ),
        h("p", { className: "conversation-footnote" }, "이 폰이 참여하고 기록에 동의한 여행만 볼 수 있어요."),
      );
    } else {
      body = h("div", { className: "conversation-thread" },
        h("p", { className: "conversation-date" }, date(s.createdAt)),
        s.lines.length ? s.lines.map((line, index) => {
          const person = who(s, line);
          const self = person?.id === s.participantId;
          const previous = s.lines[index - 1];
          const identity = (item) => item.participantId ?? item.seatArea ?? item.device;
          const grouped = previous && identity(previous) === identity(line) && line.at - previous.at < 60000;
          return h("article", { className: `conversation-message${self ? " mine" : ""}${grouped ? " grouped" : ""}` },
            h("span", { className: "message-face", "aria-hidden": "true" }, !grouped && avatar(person)),
            h("div", { className: "message-content" }, !grouped && h("p", { className: "message-name" }, speaker(s, line)), h("p", { className: "message-bubble" }, line.shown), h("time", { className: "message-time", dateTime: new Date(line.at).toISOString() }, time(line.at))),
          );
        }) : bodyStatus("아직 받아 적은 대화가 없어요"),
      );
    }
    const scroll = h("div", { className: "conversation-body" }, body);
    dialog.replaceChildren(top, nav(s), scroll,
      h("footer", { className: "conversation-bottom" },
        h("span", { className: "meta" }, s.unavailable ? "기록은 화면에 남기지 않았어요" : "차에서 받아 적은 대화예요"),
        !s.unavailable && s.view === "thread" && s.lines.length > 0 && button("자막 수정", () => { close(); onCaptions(); }, "plain"),
        !s.unavailable && s.view === "thread" && s.lines.length > 0 && onScenes && button("장면 고르기", () => { close(); onScenes(); }, "primary"),
      ),
    );
    if (s.view === "thread") scroll.scrollTop = s.enteredThread && !nearEnd ? oldTop : scroll.scrollHeight;
    s.enteredThread = s.view === "thread";
  }

  async function load(s) {
    if (state !== s || s.loading || s.unavailable) return;
    clearTimeout(timer);
    const reason = invalid(s);
    if (reason) return unavailable(reason);
    s.loading = true;
    controller = new AbortController();
    const activeController = controller;
    const timeout = setTimeout(() => activeController.abort(), 10000);
    try {
      const data = await request(s.code, activeController.signal);
      if (state !== s || s.unavailable) return;
      const changed = invalid(s);
      if (changed || data.generation !== s.generation) return unavailable(changed || "기록 동의가 바뀌어 이 대화를 표시할 수 없어요.");
      s.error = "";
      s.lines = transcriptLines(data);
      s.ready = true;
      const snapshot = JSON.stringify(s.lines);
      if (snapshot !== s.snapshot) { s.snapshot = snapshot; paint(s); }
    } catch (e) {
      if (state !== s || s.unavailable) return;
      // 연결이 끊겼을 때 원문을 계속 노출하지 않는다. 뒤늦은 철회도 폴링 재개 때 다시 검증한다.
      s.lines = [];
      s.snapshot = null;
      if (e.status === 401 || e.status === 403 || e.status === 404) return unavailable(e.status === 404 ? "지워졌거나 찾을 수 없는 대화예요." : "지금은 이 대화를 볼 수 없어요. 기록 동의와 동승 연결을 확인해 주세요.");
      s.error = "연결이 끊겨 대화를 불러오지 못했어요.";
      paint(s);
    } finally {
      clearTimeout(timeout);
      s.loading = false;
      if (state === s && !s.unavailable) timer = setTimeout(() => load(s), 4000);
    }
  }

  function open() {
    close();
    const trip = getTrip();
    const participant = getParticipant();
    if (!trip || !participant) return;
    const s = state = { code: trip.code, title: trip.title || "함께 탄 여행", createdAt: trip.createdAt, generation: trip.generation, participantId: participant.id, lines: [], view: "list" };
    paint(s);
    dialog.showModal();
    const reason = invalid(s);
    if (reason) unavailable(reason);
    else { s.loading = false; load(s); }
  }
  return { open, close, sync };
}
