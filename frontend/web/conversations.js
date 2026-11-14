// 현재 참가 권한이 있는 여행의 녹취(최종 시안 P44 '대화 기록'). 개인 피드나 앨범을 여행 전문으로 쓰지 않는다.
// 시간·장소 머리로 묶고, 장소별 할 일의 원발화는 '○○의 부탁' 카드로 보인다. 묶는 규칙은 ride.js(transcriptSections).
// 장소는 전사 응답의 places(동의한 참가자만 받음, #370)에서 읽는다. 여행 문서는 읽지 않고, 없으면 시각만 보인다.
import { h, SEAT } from "./shared.js";
import { appBar, askKeys, dateRange, hhmm, journeyTabs, transcriptSections } from "./ride.js";

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

export function createConversations({ getTrip, getParticipant, getToken, request, avatar, isOnline = () => true, onHome, onCaptions, onShorts, onScenes }) {
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
    s.asks = new Set();
    s.places = [];
    s.unavailable = message;
    paint(s);
  };
  // 화면을 다시 그릴 때마다 부른다: 권한이 바뀌면 닫고, 연결 상태가 바뀌면 머리를 다시 그린다.
  const sync = () => {
    if (!state) return;
    if (!state.unavailable) { const reason = invalid(state); if (reason) return unavailable(reason); }
    if (isOnline() !== state.online) paint(state);
  };

  const who = (line) => getTrip()?.participants.find((person) => person.id === line.participantId);
  const speaker = (line) => who(line)?.name ?? (line.speakerLabel ? `화자 ${Number(line.speakerLabel.split(":")[1]) + 1} · 이 구간` : null) ?? SEAT[line.seatArea] ?? (line.seatArea?.startsWith("ROW_1") ? "앞줄" : line.seatArea?.startsWith("ROW_2") ? "뒷줄" : "말한 사람 미확인");
  const identity = (item) => item.participantId ?? (item.speakerScope && item.speakerLabel ? `${item.speakerScope}:${item.speakerLabel}` : null) ?? item.seatArea ?? item.device;
  const bodyStatus = (message, retry) => h("div", { className: "conversation-empty", role: "status" },
    h("span", { className: "conversation-mark", "aria-hidden": "true" }, "“"),
    h("p", { className: "what" }, message),
    retry && button("다시 불러오기", retry),
  );
  // 말풍선(시안 P44 'Conversation / Phone', eZ2xs): 남은 왼쪽(얼굴·이름·회색 풍선, 시각은 풍선 오른쪽 아래),
  // 이 폰의 참가자가 한 말은 오른쪽('이름 (나)', 민트 옅은 풍선, 시각은 왼쪽). 1분 안에 같은 사람이 이어 말하면 이름·얼굴을 한 번만.
  const message = (line, previous) => {
    const grouped = previous && identity(previous) === identity(line) && line.at - previous.at < 60000;
    const mine = Boolean(line.participantId) && line.participantId === getParticipant()?.id;
    return h("article", { className: `conversation-message${mine ? " me" : ""}${grouped ? " grouped" : ""}` },
      !mine && h("span", { className: "message-face", "aria-hidden": "true" }, !grouped && avatar(who(line))),
      h("div", { className: "message-col" },
        !grouped && h("p", { className: "message-name" }, mine ? `${speaker(line)} (나)` : speaker(line)),
        h("div", { className: "message-row" }, h("p", { className: "message-bubble message-text" }, line.shown), h("span", { className: "message-time" }, hhmm(line.at)))),
    );
  };

  function paint(s) {
    if (state !== s) return;
    s.online = isOnline();
    const previous = dialog.querySelector(".conversation-body");
    const oldTop = previous?.scrollTop ?? 0;
    const nearEnd = previous && previous.scrollHeight - previous.clientHeight - oldTop < 80;
    let body;
    if (s.unavailable) body = bodyStatus(s.unavailable);
    else if (s.error) body = bodyStatus(s.error, () => load(s));
    else if (!s.ready) body = bodyStatus("대화를 불러오고 있어요");
    else if (!s.lines.length) body = bodyStatus("아직 받아 적은 대화가 없어요");
    else {
      // 시안 P44(eZ2xs)는 부탁도 따로 카드로 떼지 않고 대화 흐름 안의 말풍선으로 둔다(부탁 목록은 함께 타는 중·도착 화면).
      const sections = transcriptSections(s.lines, { places: s.places });
      body = h("div", { className: "conversation-thread" }, sections.map((part) => h("section", { className: "conversation-group" },
        h("h2", { className: "conversation-time" }, [hhmm(part.at), part.place].filter(Boolean).join("  ")),
        part.lines.map((line, i) => message(line, part.lines[i - 1])))));
    }
    const range = !s.unavailable && s.lines.length ? dateRange(s.lines[0].at, s.lines.at(-1).at) : "";
    // 제목은 여행 이름, 부제는 날짜와 시간(시안 P44 '강릉 가족 여행 / 11월 14일 09:20–10:28'). 탭이 이미 '대화 기록'이다.
    const scroll = h("div", { className: "conversation-body" },
      h("div", { className: "conversation-title" }, h("h1", { id: "conversation-title" }, s.title || "대화 기록"), range && h("p", { className: "sub" }, range.replace(" / ", "  "))),
      body,
    );
    const ready = !s.unavailable && s.ready && s.lines.length > 0;
    dialog.replaceChildren(
      appBar({ online: isOnline(), onHome: () => { close(); onHome?.(); } }),
      journeyTabs("talk", { ride: close, contents: () => { close(); onShorts(); } }),
      scroll,
      h("footer", { className: "conversation-bottom" },
        s.unavailable ? h("span", { className: "meta" }, "기록은 화면에 남기지 않았어요") : !ready && h("span", { className: "meta" }, "차에서 받아 적은 대화예요"),
        ready && button("자막 수정", () => { close(); onCaptions(); }),
        ready && onScenes && button("추천 장면 고르기", () => { close(); onScenes(); }, "primary"),
      ),
    );
    // 처음에는 위(제목·날짜)부터 보이고, 이미 글을 보던 사람이 끝에 있었으면 새 말을 따라 내려간다.
    scroll.scrollTop = s.hadLines && nearEnd ? scroll.scrollHeight : oldTop;
    s.hadLines = ready;
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
      s.asks = askKeys(data.todos);
      s.places = Array.isArray(data.places) ? data.places : [];
      s.ready = true;
      const snapshot = JSON.stringify([s.lines, [...s.asks], s.places]);
      if (snapshot !== s.snapshot) { s.snapshot = snapshot; paint(s); }
    } catch (e) {
      if (state !== s || s.unavailable) return;
      // 연결이 끊겼을 때 원문을 계속 노출하지 않는다. 뒤늦은 철회도 폴링 재개 때 다시 검증한다.
      s.lines = [];
      s.asks = new Set();
      s.places = [];
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
    const s = state = { code: trip.code, title: trip.title || "함께 탄 여행", generation: trip.generation, participantId: participant.id, lines: [], asks: new Set(), places: [] };
    paint(s);
    dialog.showModal();
    const reason = invalid(s);
    if (reason) unavailable(reason);
    else { s.loading = false; load(s); }
  }
  return { open, close, sync };
}
