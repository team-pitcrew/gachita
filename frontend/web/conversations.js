// 현재 참가 권한이 있는 여행의 녹취(최종 시안 P44 '대화 기록'). 개인 피드나 앨범을 여행 전문으로 쓰지 않는다.
// 시간·장소 머리로 묶고, 장소별 할 일의 원발화는 '○○의 부탁' 카드로 보인다. 묶는 규칙은 ride.js(transcriptSections).
import { h, SEAT } from "./shared.js";
import { appBar, askKeys, dateRange, hhmm, journeyTabs, placesOf, transcriptSections } from "./ride.js";

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
    s.unavailable = message;
    paint(s);
  };
  // 화면을 다시 그릴 때마다 부른다: 권한이 바뀌면 닫고, 연결 상태·장소 기록이 바뀌면 다시 그린다.
  const sync = () => {
    if (!state) return;
    if (!state.unavailable) { const reason = invalid(state); if (reason) return unavailable(reason); }
    const look = JSON.stringify([isOnline(), getTrip()?.places ?? null]);
    if (look !== state.look) paint(state);
  };

  const who = (line) => getTrip()?.participants.find((person) => person.id === line.participantId);
  const speaker = (line) => who(line)?.name ?? (line.speakerLabel ? `화자 ${Number(line.speakerLabel.split(":")[1]) + 1} · 이 구간` : null) ?? SEAT[line.seatArea] ?? (line.seatArea?.startsWith("ROW_1") ? "앞줄" : line.seatArea?.startsWith("ROW_2") ? "뒷줄" : "말한 사람 미확인");
  const identity = (item) => item.participantId ?? (item.speakerScope && item.speakerLabel ? `${item.speakerScope}:${item.speakerLabel}` : null) ?? item.seatArea ?? item.device;
  const bodyStatus = (message, retry) => h("div", { className: "conversation-empty", role: "status" },
    h("span", { className: "conversation-mark", "aria-hidden": "true" }, "“"),
    h("p", { className: "what" }, message),
    retry && button("다시 불러오기", retry),
  );
  const message = (line, previous) => {
    const grouped = previous && identity(previous) === identity(line) && line.at - previous.at < 60000;
    return h("article", { className: `conversation-message${grouped ? " grouped" : ""}` },
      h("span", { className: "message-face", "aria-hidden": "true" }, !grouped && avatar(who(line))),
      h("div", { className: "message-bubble" }, !grouped && h("p", { className: "message-name" }, speaker(line)), h("p", { className: "message-text", title: hhmm(line.at) }, line.shown)),
    );
  };
  // 부탁 카드: '10:05 / 엄마의 부탁'. 화자를 모르면 이름을 지어내지 않는다.
  const ask = (line) => h("article", { className: "conversation-ask" },
    h("p", { className: "meta" }, `${hhmm(line.at)} / ${who(line) ? `${who(line).name}의 부탁` : "부탁"}`),
    h("p", { className: "ask-quote" }, `“${line.shown}”`),
  );

  function paint(s) {
    if (state !== s) return;
    s.look = JSON.stringify([isOnline(), getTrip()?.places ?? null]);
    const previous = dialog.querySelector(".conversation-body");
    const oldTop = previous?.scrollTop ?? 0;
    const nearEnd = previous && previous.scrollHeight - previous.clientHeight - oldTop < 80;
    let body;
    if (s.unavailable) body = bodyStatus(s.unavailable);
    else if (s.error) body = bodyStatus(s.error, () => load(s));
    else if (!s.ready) body = bodyStatus("대화를 불러오고 있어요");
    else if (!s.lines.length) body = bodyStatus("아직 받아 적은 대화가 없어요");
    else {
      const sections = transcriptSections(s.lines, { places: placesOf(getTrip()), asks: s.asks });
      body = h("div", { className: "conversation-thread" }, sections.map((part) => part.kind === "ask" ? ask(part.line)
        : h("section", { className: "conversation-group" },
          h("h2", { className: "conversation-time" }, [hhmm(part.at), part.place].filter(Boolean).join(" / ")),
          part.lines.map((line, i) => message(line, part.lines[i - 1])))));
    }
    const range = !s.unavailable && s.lines.length ? dateRange(s.lines[0].at, s.lines.at(-1).at) : "";
    const scroll = h("div", { className: "conversation-body" },
      h("div", { className: "conversation-title" }, h("h1", { id: "conversation-title" }, "대화 기록"), h("p", { className: "sub" }, s.title)),
      range && h("p", { className: "conversation-range" }, range),
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
      s.ready = true;
      const snapshot = JSON.stringify([s.lines, [...s.asks]]);
      if (snapshot !== s.snapshot) { s.snapshot = snapshot; paint(s); }
    } catch (e) {
      if (state !== s || s.unavailable) return;
      // 연결이 끊겼을 때 원문을 계속 노출하지 않는다. 뒤늦은 철회도 폴링 재개 때 다시 검증한다.
      s.lines = [];
      s.asks = new Set();
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
    const s = state = { code: trip.code, title: trip.title || "함께 탄 여행", generation: trip.generation, participantId: participant.id, lines: [], asks: new Set() };
    paint(s);
    dialog.showModal();
    const reason = invalid(s);
    if (reason) unavailable(reason);
    else { s.loading = false; load(s); }
  }
  return { open, close, sync };
}
