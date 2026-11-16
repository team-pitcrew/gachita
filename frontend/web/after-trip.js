// 여행 마무리 → 추천 장면 고르기 → 생성 → 완성(최종 시안 P22–P32). 화면은 대화상자 하나이고 머리와 세 탭은 ride.js를 쓴다.
// 값은 서버가 준 것만 쓰고 지어내지 않는다. 장소(도착한 곳)는 앱이 읽는 GET /places(getPlaces), 없으면 기록본의 places(공개 여행 문서에는 없음).
// - 전체 음성 올리기 진행률: GET /trips/{code}/audio(T132, ADR-0024). 여행을 마치면 차가 전체 음성을 올리고 서버는 다 올린 때부터 2일 둔다.
//   받은 바이트 / 차가 알린 전체 바이트만 퍼센트로 보이고, 경로가 없거나(404) 차가 아직 시작하지 않았으면 기다린다고만 말한다.
// - 추천 장면: GET /scene-suggestions의 점수 상위 3개(서버 규칙, 전체 음성이 있으면 소리가 있는 구간만). 제목은 장면의 발화에서 규칙으로 뽑는다(LLM 없음).
// - 생성: 고른 장면마다 POST /moments → 장면 소리가 생기면(차가 올리거나, A4가 붙으면 서버가 전체 음성에서 자름) → 기존 기본 영상
//   (short-film.js exportShortFilm, 장면 길이만큼 실제로 재생하며 녹화) → POST /short-assets 보관. 서버가 만들어 주는 길은 없다.
//   그래서 앱을 나가면(화면이 가려지면) 녹화가 멈춘다. 남은 일은 이 폰에 적어 두고 돌아오면 남은 장면부터 이어 만든다.
import { h, toast } from "./shared.js";
import { appBar, hhmm, journeyTabs, placesOf } from "./ride.js";
import { transcriptLines } from "./conversations.js";
import { exportShortFilm, recordingFormat } from "./short-film.js";
import { sceneClipPath } from "./short-scenes.js";
import { mediaResponse } from "./media.js";

// ---- 순수 함수(after-trip.test.mjs) ----

const graphemes = (text) => [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(String(text ?? ""))].map((s) => s.segment);
export const clip = (text, max) => { const g = graphemes(String(text ?? "").trim()); return g.length > max ? `${g.slice(0, max - 1).join("").trim()}…` : g.join(""); };
const said = (line) => String(line?.displayText ?? line?.text ?? "").trim();
const pad = (n) => String(n).padStart(2, "0");

// 여행 시작에서 잰 시각 'HH:MM:SS'. 시작 전은 0으로 본다.
export function clock(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
export const spanLabel = (from, to, origin) => `${clock(from - origin)}–${clock(to - origin)}`;
// 파형 아래 눈금: '34:12', 시간이 넘으면 '1:08:24'(시안 v2)
export function axisLabel(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000)), hours = Math.floor(s / 3600);
  return `${hours ? `${hours}:` : ""}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
// 시간축 위 자리(0~100%)
export const offsetPct = (at, origin, end) => (end > origin ? Math.max(0, Math.min(100, ((at - origin) / (end - origin)) * 100)) : 0);

// 주행 시간: '1시간 8분', '8분', '40초'. 모르면 빈 글.
export function durationLabel(seconds) {
  if (!(seconds > 0)) return "";
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}시간${minutes ? ` ${minutes}분` : ""}`;
  return minutes ? `${minutes}분` : `${Math.round(seconds)}초`;
}

// '11월 14일 09:20–10:28'. 날을 넘기면 양쪽에 날짜를 붙인다.
export function dayRange(from, to) {
  if (!Number.isFinite(from)) return "";
  const day = (at) => new Date(at).toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
  if (!Number.isFinite(to) || to < from) to = from;
  if (day(from) !== day(to)) return `${day(from)} ${hhmm(from)} – ${day(to)} ${hhmm(to)}`;
  return `${day(from)} ${hhmm(from)}${hhmm(to) !== hhmm(from) ? `–${hhmm(to)}` : ""}`;
}

// 여행의 시간축. 시작은 전체 음성의 첫 표본 시각, 없으면 처음 출발한 때(trip.startedAt)와 첫 발화 중 이른 것, 둘 다 없으면 여행을 만든 때.
// 길이는 전체 음성 길이, 없으면 마지막 발화까지.
// 그 밖의 구간(추천 장면)이 축을 넘으면 축을 늘린다(장면이 막대 밖에 그려지지 않게).
export function tripClock(trip, audio, lines = [], spans = []) {
  // 다시 출발해 새로 올리는 중이면 시작 시각을 아직 모를 수 있다 — 그때는 앞서 다 올린 전체 음성(previous)을 쓴다.
  const sound = [["ready", "uploading"].includes(audio?.state) ? audio : null, audio?.previous].find((a) => Number.isFinite(a?.startedAt)) ?? null;
  const first = lines.find((l) => Number.isFinite(l.at))?.at;
  const known = [trip?.startedAt, first].filter(Number.isFinite);
  const origin = Number.isFinite(sound?.startedAt) ? sound.startedAt : known.length ? Math.min(...known) : trip?.createdAt ?? 0;
  const last = Math.max(-Infinity, ...lines.map((l) => (Number.isFinite(l.endAt) ? l.endAt : l.at)).filter(Number.isFinite));
  let end = sound?.seconds > 0 ? origin + sound.seconds * 1000 : Number.isFinite(last) ? last : origin;
  for (const s of spans) if (Number.isFinite(s.to)) end = Math.max(end, s.to);
  return { origin, end, seconds: Math.max(0, (end - origin) / 1000), fromAudio: Boolean(sound?.seconds > 0) };
}

// 올리기 상태(GET /audio)를 화면 글과 퍼센트로. audio가 null이면 경로가 없거나(404) 차가 아직 시작하지 않은 것.
// 퍼센트는 받은 바이트 / 차가 알린 전체 바이트일 때만, 합치기 전에는 99%를 넘기지 않는다.
export function audioStep(audio) {
  const waiting = { kind: "waiting", percent: null, label: "차에서 음성을 올리기를 기다리고 있어요" };
  if (!audio || audio.state === "none") return audio?.deleted ? { kind: "deleted", percent: null, label: "전체 음성을 지웠어요" } : waiting;
  if (audio.state === "ready") return { kind: "ready", percent: 100, label: "전체 음성 업로드 완료" };
  // 다 올린 뒤 2일이 지나 서버가 지움. 다시 올리지 않는다(고른 장면의 소리와 만든 콘텐츠는 따로 남음).
  if (audio.state === "expired") return { kind: "expired", percent: 100, label: "전체 음성 보관 기간(2일)이 지났어요" };
  if (audio.state !== "uploading") return waiting;
  const total = Number(audio.expectedBytes), got = Number(audio.receivedBytes) || 0;
  const percent = total > 0 ? Math.max(0, Math.min(99, Math.floor((got / total) * 100))) : null;
  return { kind: "uploading", percent, label: percent == null ? `전체 음성 업로드 중 · 조각 ${Number(audio.receivedParts) || 0}개 받음` : `전체 음성 업로드 중  ${percent}%` };
}

// 추천 장면: 서버 점수 상위 n개를 시각 순으로. 같은 점수면 앞선 장면.
export function topScenes(items, n = 3) {
  const ok = (Array.isArray(items) ? items : []).filter((s) => Number.isFinite(s?.from) && Number.isFinite(s?.to) && s.to > s.from);
  return [...ok].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.from - b.from).slice(0, n).sort((a, b) => a.from - b.from);
}

// 장면에서 가장 힘 있는 한 줄: 글자 수(20자까지만 쳐서 긴 말이 이기지 않게), 물음표·느낌표로 끝남, 화자가 확인된 줄에 점수. 같으면 앞선 줄.
export function strongestLine(lines, participants = []) {
  let best = null, top = -Infinity;
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = said(line);
    if (!text) continue;
    const score = Math.min(20, graphemes(text).length) + (/[?!？！]$/.test(text) ? 8 : 0) + (participants.some((p) => p.id === line.participantId) ? 4 : 0);
    if (score > top) { best = line; top = score; }
  }
  return best;
}

// 카드 제목·대사. 힘 있는 한 줄이 6자 이상이면(또는 화자를 모르면) 그 말이 제목이고 대사는 그 장면의 다른 첫 줄,
// 너무 짧고 화자가 확인됐으면 '{이름}의 한마디'가 제목이고 대사는 그 줄. 이름은 서버가 확인한 화자만 붙인다.
export function sceneTitle(scene, participants = []) {
  const line = strongestLine(scene?.lines, participants);
  if (!line) return { title: "함께 나눈 이야기", quote: "", speakerId: null };
  const who = (l) => participants.find((p) => p.id === l?.participantId) ?? null;
  const person = who(line), text = said(line), asText = graphemes(text).length >= 6 || !person;
  const title = asText ? clip(text, 24) : `${person.name}의 한마디`;
  const other = asText ? scene.lines.find((l) => l !== line && said(l)) : line; // 제목이 그 말이면 대사는 다른 첫 줄
  const quote = other ? `${who(other) ? `${who(other).name} ` : ""}“${clip(said(other), 30)}”` : "";
  return { title, quote, speakerId: person?.id ?? null };
}

// 시간축 막대: 칸마다 받아 적은 말의 수(최대 칸 대비 제곱근, 0~1). 말이 없던 칸은 0(높이를 지어내지 않음).
export function densityBars(lines, origin, end, count = 36) {
  const bins = new Array(count).fill(0), width = (end - origin) / count;
  if (!(width > 0)) return bins;
  for (const l of lines) if (Number.isFinite(l.at) && l.at >= origin && l.at <= end) bins[Math.min(count - 1, Math.floor((l.at - origin) / width))]++;
  const max = Math.max(...bins);
  return bins.map((n) => (max ? Math.round(Math.sqrt(n / max) * 100) / 100 : 0));
}

// 장면 하나의 진행: 장면 남김 0.1 → 소리 준비 0.25 → 녹화 0.25~0.85 → 보관 0.9 → 완성 1.
export function itemProgress(item) {
  if (item.assetId || item.phase === "done") return 1;
  if (item.phase === "save") return 0.9;
  if (item.phase === "render") return 0.25 + 0.6 * Math.max(0, Math.min(1, item.progress || 0));
  if (item.momentId) return item.ready ? 0.25 : 0.1;
  return 0;
}

// 생성 화면(P31)의 세 줄과 전체 진행률. paused는 멈춘 까닭(없으면 진행 중).
export function generationStages(items, paused = "") {
  const n = items.length, ready = items.filter((i) => i.assetId || i.ready || ["render", "save", "done"].includes(i.phase)).length;
  const done = items.filter((i) => i.assetId || i.phase === "done").length;
  const failed = items.filter((i) => i.phase === "failed").length;
  const overall = n ? items.reduce((sum, i) => sum + itemProgress(i), 0) / n : 0;
  const at = items.findIndex((i) => ["moment", "voice", "render", "save"].includes(i.phase));
  const now = items[at];
  const step = paused || (done === n ? "모두 만들었어요"
    : now?.phase === "render" ? `캐릭터 배치와 자막 생성 중 · ${at + 1}/${n}`
    : now?.phase === "save" ? `콘텐츠 기록에 저장 중 · ${at + 1}/${n}`
    : now?.phase === "voice" ? "차에서 음성 구간이 올라오기를 기다리고 있어요"
    : now?.phase === "moment" ? "고른 장면을 남기는 중" : failed ? `${failed}개를 만들지 못했어요` : "준비 중");
  return { voice: ready === n ? "음성 구간 준비 완료" : `음성 구간 준비 중 · ${ready}/${n}`, step, content: `콘텐츠 생성 중  ${Math.floor(overall * 100)}%`, overall, done, failed, total: n };
}

// ---- 화면 ----

const button = (text, onclick, className = "", disabled = false) => h("button", { type: "button", className, onclick, disabled }, text);
const keyed = (el, key) => (el.setAttribute("data-key", key), el);
const sleep = (ms, signal) => new Promise((ok, no) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); no(signal.reason ?? new DOMException("멈췄어요.", "AbortError")); }, { once: true });
});

// getTrip/getParticipant/getToken: 지금 여행·이 폰의 참가자·참가자 토큰. request(method, path, body, signal): 이 폰의 참가자 토큰으로 /trips/{code}{path}.
// remember(key, value?): 이 폰에 남긴 생성 계획 읽기·쓰기(null이면 지움). avatar(person): 얼굴. onContents(selectedId?): 콘텐츠 기록(쇼츠 보관함).
// onTalk(): 대화 기록. (옛 '직접 고르기'·장면 고르기 입구는 11/15 시안 수렴에서 뺐다)
export function createAfterTrip({ getTrip, getParticipant, getToken, request, remember, avatar, getPlaces = () => [], isOnline = () => true, onHome, onTalk, onContents, onRide = () => {} }) {
  const dialog = h("dialog", { className: "after-dialog", "aria-labelledby": "after-title" });
  document.body.append(dialog);
  let view = null; // 보고 있는 화면 { code, generation, participantId, step: upload|select|make|done, audio, audioMissing, lines, picks, chosen, error }
  let run = null; // 만드는 일 { code, generation, participantId, items, active, paused, hidden, controller }
  let timer = null, poll = null;

  const parkedNow = (t) => t && ["parked", "ended"].includes(t.status);
  // 이 화면과 일이 아직 유효한가: 같은 여행·동의 세대·참가자, 주차·종료 상태, 이 폰의 토큰이 있음.
  const valid = (s) => { const t = getTrip(), p = getParticipant(); return !!(s && t && p && t.code === s.code && (t.generation ?? 1) === s.generation && p.id === s.participantId && getToken() && parkedNow(t)); };
  const canMake = (s) => valid(s) && getParticipant()?.consent;
  const planKey = (code, id) => `after:${code}:${id}`;
  const crew = () => "우리 가족"; // 시안 P22·P31·P32의 글. 여행 문서에는 그룹 종류가 없어 동승 그룹에도 같은 글을 쓴다

  const stop = () => { clearTimeout(timer); poll?.abort(); poll = null; };
  // 닫을 때 다 만든 계획은 이 폰에서 지운다(완성 화면을 본 뒤). 만들던 일은 닫아도 계속한다.
  function dismiss() {
    stop(); view = null; dialog.replaceChildren();
    if (run && !run.active && run.items.every((i) => i.assetId)) { forget(run); run = null; }
  }
  function close() { if (dialog.open) dialog.close(); dismiss(); } // 'close' 이벤트는 나중에 오고 그때는 view가 비어 있다
  dialog.addEventListener("close", () => { if (view) dismiss(); });
  addEventListener("hashchange", close);

  // ---- 읽기 ----
  async function readAudio(s, signal) {
    try { s.audio = await request("GET", "/audio", null, signal); s.audioMissing = false; }
    catch (e) { if (e.status === 404) { s.audio = null; s.audioMissing = true; } else if (e.name !== "AbortError") s.audioError = e.status === 0 ? "연결이 끊겨 올리기 상태를 확인하지 못했어요." : e.message; }
  }
  async function readTalk(s, signal) {
    if (!getParticipant()?.consent) return;
    try {
      const [talk, found] = await Promise.all([request("GET", "/transcript", null, signal), request("GET", "/scene-suggestions", null, signal)]);
      if (talk.generation !== s.generation) return close(), toast("기록 동의가 바뀌어 장면 고르기를 닫았어요.");
      s.lines = transcriptLines(talk);
      s.places = Array.isArray(talk.places) ? talk.places : []; // 장소는 공개 여행 문서에 없고 기록본에만 온다(동의한 참가자)
      s.picks = topScenes(found.items);
      s.error = "";
    } catch (e) { if (e.name !== "AbortError") s.error = e.status === 0 ? "연결이 끊겨 추천 장면을 불러오지 못했어요." : e.message; }
  }
  // 올리기 화면에서는 3초마다 진행률을, 그 밖에는 처음 한 번만 읽는다. 다 올리면 고르기로 넘어간다.
  async function tick(s) {
    if (view !== s) return;
    if (!valid(s)) return close(), toast("여행이나 기록 동의가 바뀌어 화면을 닫았어요.");
    poll?.abort(); poll = new AbortController();
    const signal = poll.signal, timeout = setTimeout(() => poll?.abort(), 10000);
    try {
      await readAudio(s, signal);
      if (s.step === "upload" || !s.lines) {
        if (!s.lines || Date.now() - (s.talkAt || 0) > 15000) { s.talkAt = Date.now(); await readTalk(s, signal); }
      }
    } finally { clearTimeout(timeout); }
    if (view !== s) return;
    if (s.step === "upload" && s.audio?.state === "ready" && s.picks) s.step = "select";
    paint();
    if (view === s && s.step === "upload" && s.audio?.state !== "expired") timer = setTimeout(() => tick(s), 3000); // 지난 것은 다시 묻지 않는다
  }

  // ---- 그리기 ----
  const wave = (bars, on, mark = () => false) => h("div", { className: "trip-wave", "aria-hidden": "true" },
    bars.map((v, i) => h("i", { className: on(i) ? "on" : mark(i) ? "mark" : "", style: `--v:${v}` })));
  const axis = (total) => h("div", { className: "wave-axis", "aria-hidden": "true" }, h("span", {}, "00:00"), h("span", {}, clock(total * 1000)));
  const people = () => getTrip()?.participants ?? [];
  const timeline = (s) => tripClock(getTrip(), s.audio, s.lines ?? [], s.picks ?? []);
  // 보일 올리기 상태: 서버 값. 아직 묻는 중이면 undefined, 경로가 없으면(404) null.
  const shown = (s) => (s.audio === undefined && !s.audioMissing ? undefined : s.audio ?? null);

  function uploadView(s) {
    const trip = getTrip(), time = timeline(s), audio = shown(s), step = audioStep(audio);
    const known = getPlaces();
    const arrived = [...placesOf(known.length ? known : s.places)].reverse().find((p) => p.kind === "arrived")?.name;
    const bars = densityBars(s.lines ?? [], time.origin, time.end);
    const ratio = (step.percent ?? 0) / 100;
    const canGo = getParticipant()?.consent && (s.picks?.length > 0 || step.kind === "ready" || step.kind === "expired");
    return {
      title: "오늘의 주행을 기록했어요",
      sub: [arrived && `${arrived} 도착`, trip.status === "ended" ? "여행을 마쳤어요" : "주차 후 여행 마무리"].filter(Boolean).join(" / "),
      body: [
        h("section", { className: "after-summary" },
          h("strong", {}, [crew(), durationLabel(time.seconds)].filter(Boolean).join(" / ")),
          s.lines?.length ? h("p", {}, dayRange(time.origin, time.end)) : h("p", {}, s.lines ? "받아 적은 대화가 아직 없어요" : getParticipant()?.consent ? "대화를 불러오고 있어요" : "기록에 동의한 사람만 대화 시간을 볼 수 있어요")),
        h("section", { className: "after-card", role: "status" },
          h("p", { className: "after-label" }, audio === undefined ? "올리기 상태를 확인하고 있어요" : step.label),
          wave(bars, (i) => i < Math.round(ratio * bars.length)), axis(time.seconds),
          s.audioError && h("p", { className: "meta" }, s.audioError)),
        h("p", { className: "after-note" }, step.kind === "ready" ? "전체 음성을 다 올렸어요. 남기고 싶은 장면을 골라 주세요."
          : step.kind === "uploading" ? "여행 음성을 업로드하고 추천 장면을 준비하고 있어요."
          : step.kind === "deleted" ? "전체 음성이 지워져 받아 적은 대화로만 장면을 추천해요."
          : step.kind === "expired" ? "전체 음성은 지웠어요. 이미 고른 장면의 소리와 만든 콘텐츠는 그대로 남아요."
          : "차가 여행 음성을 올리기 시작하면 여기에 진행률이 보여요. 그동안은 받아 적은 대화로 추천 장면을 준비해요."),
        !getParticipant()?.consent && h("p", { className: "after-note" }, "장면 고르기와 만들기는 기록에 동의한 사람만 할 수 있어요."),
      ],
      actions: [button("추천 장면 보기", () => { s.step = "select"; stop(); paint(); }, "primary", !canGo)],
    };
  }

  function selectView(s) {
    const trip = getTrip(), time = timeline(s), picks = s.picks ?? [];
    const chosen = picks.filter((p) => s.chosen.has(p.from));
    const bars = densityBars(s.lines ?? [], time.origin, time.end);
    const fromAudio = s.audio?.state === "ready"; // 시안 '전체 음성에서 찾은 추천 장면 3개'는 실제로 다 올렸을 때만
    // 파형 위 번호 표식과 목록이 같은 선택을 바꾼다(시안 v2: 추천 3개는 파형과 목록에서 선택 가능)
    const flip = (key, on, focus) => { if (on) s.chosen.add(key); else s.chosen.delete(key); paint(focus); };
    const at = (ms) => offsetPct(ms, time.origin, time.end);
    const marks = picks.flatMap((p, i) => {
      const on = s.chosen.has(p.from), left = at(p.from), width = Math.max(0, at(p.to) - left);
      return [
        h("span", { className: `wave-span${on ? " on" : ""}`, style: `left:${left}%;width:${width}%`, "aria-hidden": "true" }),
        keyed(h("button", { type: "button", className: `wave-mark${on ? " on" : ""}`, style: `left:${Math.max(5, Math.min(95, left + width / 2))}%`, "aria-pressed": String(on), "aria-label": `${i + 1}번 장면 ${spanLabel(p.from, p.to, time.origin)}`, onclick: () => flip(p.from, !on, `m${p.from}`) }, String(i + 1)), `m${p.from}`),
      ];
    });
    const card = (pick, i) => {
      const { title } = sceneTitle(pick, people());
      const on = s.chosen.has(pick.from);
      return h("section", { className: `scene-pick${on ? " on" : ""}` },
        h("label", {},
          keyed(h("input", { type: "checkbox", checked: on, onchange: (e) => flip(pick.from, e.target.checked, String(pick.from)) }), pick.from),
          h("span", { className: "pick-copy" }, h("strong", {}, `${i + 1}. ${title}`), h("span", { className: "pick-time" }, spanLabel(pick.from, pick.to, time.origin)))));
      // 시안 P23–P30: 장면 카드는 번호·제목·구간만(대사 미리 보기는 뺐다 — 11/15 오너 '시안에 맞춰 수렴')
    };
    return {
      title: "남기고 싶은 순간을 골라요",
      sub: !s.picks ? "추천 장면을 찾고 있어요" : picks.length ? `${fromAudio ? "전체 음성" : "받아 적은 대화"}에서 찾은 추천 장면 ${picks.length}개` : "아직 추천할 장면을 찾지 못했어요",
      body: [
        h("section", { className: "after-card" },
          h("p", { className: "after-label" }, `${trip.title || "함께 탄 여행"} / 전체 ${clock(time.seconds * 1000)}`),
          h("div", { className: "wave-pick" }, wave(bars, () => false, () => true), marks),
          h("div", { className: "wave-axis", "aria-hidden": "true" }, h("span", {}, "00:00"), h("span", {}, axisLabel(time.seconds * 500)), h("span", {}, axisLabel(time.seconds * 1000)))),
        ...picks.map(card),
        s.picks && !picks.length && h("p", { className: "after-note" }, "대화가 더 쌓이면 다시 찾아요."),
        s.error && h("p", { className: "after-note", role: "alert" }, s.error),
      ],
      actions: [chosen.length ? button(`선택한 ${chosen.length}개 생성`, () => start(s, chosen), "primary") : button("장면을 선택해 주세요", null, "primary", true)],
    };
  }

  function makeView(s) {
    const r = run, stage = generationStages(r.items, r.paused);
    const time = timeline(s), bars = densityBars(s.lines ?? [], time.origin, time.end);
    return {
      title: `${crew()}의 콘텐츠를 만들어요`,
      sub: "선택한 장면에 캐릭터와 자막을 입히는 중",
      body: [
        h("section", { className: "after-summary", role: "status" }, h("strong", {}, stage.voice), h("p", {}, stage.step)),
        h("section", { className: "after-card" },
          h("p", { className: "after-label" }, stage.content),
          wave(bars, (i) => i < Math.round(stage.overall * bars.length)), axis(time.seconds)),
        // 시안 P31: 장면별 진행 줄·'멈추기'는 뺐다(11/15 수렴). 만들다 멈춘 계획은 이 폰에 남아 다시 열면 남은 장면부터 잇는다.
        h("p", { className: "after-note" }, "이 화면을 나가도 완성되면 알려드려요."),
      ],
      actions: [
        r.paused && !r.active && button("이어서 만들기", () => go(r), "primary"),
        button("콘텐츠 기록으로", () => { close(); onContents(); }, r.paused && !r.active ? "secondary" : "primary"),
        !r.active && button("다른 장면 새로 고르기", () => { forget(r); run = null; s.step = "select"; s.chosen.clear(); paint(); tick(s); }, "plain"), // 멈추거나 실패했을 때만(상태 화면)
      ],
    };
  }

  function doneView() {
    const r = run, made = r.items.filter((i) => i.assetId), missed = r.items.filter((i) => !i.assetId);
    return {
      title: `${crew()}의 순간이 완성됐어요`,
      sub: made.length ? "선택한 장면을 콘텐츠 기록에 저장했어요." : "콘텐츠를 만들지 못했어요.",
      body: [
        // 시안 P32(eZ2xs): 두 줄 칸 — 장면 표지(콘텐츠 기록 갤러리와 같은 'Archive / 썸네일', style.css .content-poster) 아래 제목 15/22
        made.length > 0 && h("div", { className: "content-grid" }, made.map((item, i) => {
          const d = new Date(item.at), s = Math.round(item.seconds || 0);
          return h("button", { type: "button", className: "content-tile", "aria-label": `${item.label} 콘텐츠 기록에서 보기`, onclick: () => { close(); forget(r); onContents(`asset:${r.code}:${item.assetId}`); } },
            h("span", { className: "content-poster", "aria-hidden": "true" }, h("span", { className: `poster-card tone-${i % 2}` },
              h("span", { className: "poster-top" }, `${d.getMonth() + 1}.${d.getDate()}  ${getTrip()?.title || "함께 탄 여행"}`),
              h("strong", { className: "poster-title" }, item.label),
              h("span", { className: "poster-cast" }, h("span", { className: "content-face" }, avatar(people().find((p) => p.id === item.speakerId) ?? {}))),
              h("span", { className: "poster-caption" }, "캐릭터 자막형"),
              h("span", { className: "poster-foot" }, h("span", {}, "가치타"), h("span", {}, `▶ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`)))),
            h("strong", {}, item.label));
        })),
        ...missed.map((item) => h("section", { className: "after-card" }, h("strong", {}, item.label), h("p", { className: "meta" }, item.error || "만들지 못했어요."))),
        missed.length > 0 && button("못 만든 장면 다시 만들기", () => { for (const i of missed) Object.assign(i, { phase: i.momentId ? "voice" : "moment", error: "" }); r.paused = ""; if (view) view.step = "make"; go(r); }, "plain after-pick"),
        made.length > 0 && h("p", { className: "after-note" }, "같은 계정의 폰에서도 바로 볼 수 있어요."),
      ],
      actions: [button("콘텐츠 기록 보기", () => { close(); forget(r); onContents(made[0] && `asset:${r.code}:${made[0].assetId}`); }, "primary")],
    };
  }

  function paint(focusKey) {
    const s = view;
    if (!s) return;
    if (s.step === "make" && !run) s.step = "select";
    if (s.step === "make" && !run.active && run.items.every((i) => i.assetId || i.phase === "failed")) s.step = "done";
    const page = { upload: uploadView, select: selectView, make: makeView, done: doneView }[s.step](s);
    const old = dialog.querySelector(".after-body")?.scrollTop ?? 0;
    const body = h("div", { className: "after-body" },
      h("div", { className: "ride-title" }, h("h1", { id: "after-title" }, page.title), page.sub && h("p", { className: "sub" }, page.sub)),
      ...page.body);
    // 진행률은 1초마다 다시 그린다. 머리·탭과 아래 단추가 같으면 그 요소를 그대로 두고 속성만 바꾼다 —
    // 누르는 사이 단추가 갈아 끼워져 탭이 사라지지 않게.
    const actions = page.actions.filter(Boolean), footer = dialog.querySelector(".after-bottom");
    const same = footer && dialog.dataset.step === s.step && footer.children.length === actions.length && actions.every((b, i) => footer.children[i].textContent === b.textContent);
    if (same && dialog.querySelector(".app-bar .link-state")?.classList.contains("is-offline") === !isOnline()) {
      actions.forEach((b, i) => Object.assign(footer.children[i], { disabled: b.disabled, className: b.className, onclick: b.onclick }));
      dialog.querySelector(".after-body").replaceWith(body);
    } else dialog.replaceChildren(
      appBar({ online: isOnline(), onHome: () => { close(); onHome?.(); } }),
      // 탭: '함께 타는 중'은 진행 중 여행(P17), 끝났으면 내 동승 그룹(P16) — app.js goRide. '콘텐츠 기록'은 갤러리(P33).
      journeyTabs("contents", { ride: () => { close(); onRide(); }, talk: () => { close(); onTalk(); }, contents: () => { close(); onContents(); } }),
      body,
      h("footer", { className: "after-bottom" }, actions),
    );
    dialog.dataset.step = s.step;
    body.scrollTop = old;
    if (focusKey) dialog.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  // ---- 만들기 ----
  const forget = (r) => remember(planKey(r.code, r.participantId), null);
  const keep = (r) => remember(planKey(r.code, r.participantId), JSON.stringify({ generation: r.generation, items: r.items.map(({ key, at, from, to, label, lat, lng, speakerId, momentId, assetId, seconds, saveKey }) => ({ key, at, from, to, label, lat, lng, speakerId, momentId, assetId, seconds, saveKey })) }));

  function start(s, chosen) {
    if (!canMake(s)) return toast("기록에 동의하고 이 폰에서 연결한 사람만 만들 수 있어요.");
    if (!recordingFormat()) return toast("이 브라우저는 영상 만들기를 지원하지 않아요.");
    if (run?.active) { s.step = "make"; return paint(); }
    const items = chosen.map((p) => {
      const { title, speakerId } = sceneTitle(p, people());
      const where = p.lines?.find((l) => Number.isFinite(l.lat));
      return { key: String(p.from), at: Math.max(p.from, Math.min(p.at ?? p.from, p.to)), from: p.from, to: p.to, label: clip(title, 60), speakerId, ...(where ? { lat: where.lat, lng: where.lng } : {}), phase: "moment" };
    });
    run = { code: s.code, generation: s.generation, participantId: s.participantId, items, paused: "" };
    keep(run);
    s.step = "make";
    go(run);
  }

  const runValid = (r) => run === r && canMake(r) && getTrip()?.participants.every((p) => p.consent);
  const halt = (message) => Object.assign(new Error(message), { halt: true });

  // 남은 장면을 차례로 만든다. 화면이 가려져 멈추면 보이게 되었을 때 이어서 한다(이 페이지 안). 권한이 바뀌면 멈춘다.
  async function go(r) {
    if (r.active || run !== r) return;
    r.active = true; r.paused = ""; r.hidden = false;
    const controller = r.controller = new AbortController();
    paint();
    try {
      for (const item of r.items) {
        if (item.assetId) { item.phase = "done"; continue; }
        if (!runValid(r)) throw halt("여행이나 기록 동의가 바뀌어 멈췄어요.");
        if (document.hidden) throw halt("앱을 나가 만들기를 멈췄어요. 돌아오면 이어서 만들어요.");
        try { await makeOne(r, item, controller.signal); }
        catch (e) {
          if (e.halt || document.hidden || [401, 403, 410].includes(e.status) || controller.signal.aborted) throw e;
          item.phase = "failed"; item.error = e.status === 0 ? "연결이 끊겼어요." : e.message; keep(r); paint();
        }
      }
      if (view?.code === r.code && view.step === "make") paint();
      else toast(`콘텐츠 ${r.items.filter((i) => i.assetId).length}개를 만들었어요. 콘텐츠 기록에서 볼 수 있어요.`);
    } catch (e) {
      const hidden = document.hidden;
      for (const item of r.items) if (["moment", "voice", "render", "save"].includes(item.phase)) { item.phase = item.momentId ? "voice" : "moment"; item.progress = 0; }
      r.hidden = hidden && runValid(r);
      r.paused = hidden ? "앱을 나가 만들기를 멈췄어요. 돌아오면 이어서 만들어요." : r.stopped ? "만들기를 멈췄어요. 남긴 장면은 그대로예요." : e.halt ? e.message : e.status === 0 ? "연결이 끊겨 멈췄어요." : e.message;
      r.stopped = false;
      if (!view) toast(r.paused);
    } finally {
      r.active = false; controller.abort();
      if (view) paint();
    }
  }
  addEventListener("visibilitychange", () => { if (!document.hidden && run?.hidden && !run.active && runValid(run)) go(run); });

  async function makeOne(r, item, signal) {
    item.error = "";
    if (!item.momentId) {
      item.phase = "moment"; paint();
      const moment = await request("POST", "/moments", { at: item.at, from: item.from, to: item.to, label: item.label, ...(Number.isFinite(item.lat) ? { lat: item.lat, lng: item.lng } : {}) }, signal);
      item.momentId = moment.id; keep(r);
    }
    // 장면 소리: 숏폼 구성(GET /shortform)에 그 장면이 보일 때까지 기다린다. A4가 붙은 서버는 이 읽기에서 전체 음성을 잘라 둔다.
    item.phase = "voice"; paint();
    let source = null;
    while (!source) {
      if (!runValid(r)) throw halt("여행이나 기록 동의가 바뀌어 멈췄어요.");
      const form = await request("GET", "/shortform", null, signal);
      if (form.generation !== r.generation) throw halt("기록 동의가 바뀌어 멈췄어요.");
      if (form.scenes.some((x) => x.momentId === item.momentId)) source = await request("GET", `/short-assets/source?moment=${encodeURIComponent(item.momentId)}`, null, signal).catch((e) => (e.status === 409 ? null : Promise.reject(e)));
      if (!source) await sleep(4000, signal);
    }
    if (source.generation !== r.generation) throw halt("기록 동의가 바뀌어 멈췄어요.");
    item.ready = true; item.seconds = source.seconds; item.phase = "render"; item.progress = 0; keep(r); paint();
    const scene = source.source.scenes[0];
    const check = async (sig) => {
      const latest = await request("GET", `/short-assets/source?moment=${encodeURIComponent(item.momentId)}`, null, AbortSignal.any([sig, AbortSignal.timeout(8000)]));
      if (latest.generation !== r.generation || latest.sourceHash !== source.sourceHash) throw new Error("원음·자막·화자가 바뀌었어요. 다시 만들어 주세요.");
    };
    const file = await exportShortFilm({ title: item.label, cast: source.source.cast, scene: { ...scene, label: item.label }, signal,
      canRead: () => runValid(r) && !signal.aborted,
      checkAccess: check,
      getAudio: async (sig) => {
        // 이 장면(보관할 원본과 같은 것)에 서명 주소(mediaUrl, T178)가 있을 때만 거기서 받는다. 없으면 전처럼 머리말 인증으로.
        const res = await mediaResponse({ url: scene.mediaUrl, signal: sig, direct: () => fetch(sceneClipPath(r.code, scene), { signal: sig, headers: { authorization: `Bearer ${getToken()}` } }) });
        if (!res.ok) throw Object.assign(new Error(`장면 소리를 받지 못했어요(${res.status}).`), { status: res.status });
        return res.arrayBuffer();
      },
      onProgress: (p) => { if (run === r && Math.floor(p * 100) !== Math.floor(item.progress * 100)) { item.progress = p; paint(); } else item.progress = p; },
    });
    item.phase = "save"; item.saveKey ||= crypto.randomUUID(); keep(r); paint();
    const query = new URLSearchParams({ moment: item.momentId, generation: r.generation, sourceHash: source.sourceHash, key: item.saveKey });
    const asset = await request("POST", `/short-assets?${query}`, file, AbortSignal.any([signal, AbortSignal.timeout(150000)]));
    item.assetId = asset.id; item.phase = "done"; keep(r); paint();
  }

  // ---- 여닫기 ----
  // 이 폰에 남은 생성 계획(지금 여행·참가자·동의 세대)을 되살린다. 없거나 세대가 바뀌었으면 지운다.
  function restore() {
    const t = getTrip(), p = getParticipant();
    if (!t || !p) return null;
    if (run?.code === t.code && run.participantId === p.id && run.generation === (t.generation ?? 1)) return run;
    let saved = null;
    try { saved = JSON.parse(remember(planKey(t.code, p.id)) || "null"); } catch {}
    if (!saved?.items?.length) return null;
    if (saved.generation !== (t.generation ?? 1)) { remember(planKey(t.code, p.id), null); return null; }
    run = { code: t.code, generation: saved.generation, participantId: p.id, paused: "", items: saved.items.map((i) => ({ ...i, phase: i.assetId ? "done" : i.momentId ? "voice" : "moment" })) };
    run.paused = run.items.every((i) => i.assetId) ? "" : "멈췄던 만들기가 있어요. '이어서 만들기'를 누르면 남은 장면부터 만들어요.";
    return run;
  }

  // step: 처음 보일 화면(upload: 여행을 마친 직후, select: 대화 기록의 '추천 장면 고르기'). 만들던 일이 있으면 그 화면을 먼저 보인다.
  function open({ step = "upload" } = {}) {
    const t = getTrip(), p = getParticipant();
    if (!t || !p || !getToken()) return toast("이 폰의 동승 연결을 먼저 확인해 주세요.");
    if (!parkedNow(t)) return toast("주차한 뒤 장면을 고를 수 있어요.");
    if (step === "select" && !p.consent) return toast("기록에 동의한 사람만 장면을 고를 수 있어요.");
    stop();
    let r = restore();
    // 대화 기록의 '추천 장면 고르기'(P44 → P23): 다 만들었거나 실패만 남은 지난 계획은 고르기를 막지 않는다(전에는 P32가 다시 열렸다).
    if (step === "select" && r && !r.active && !r.items.some((i) => !i.assetId && i.phase !== "failed")) { forget(r); run = r = null; }
    view = { code: t.code, generation: t.generation ?? 1, participantId: p.id, step: r ? "make" : step, chosen: new Set(), audio: undefined };
    paint();
    if (!dialog.open) dialog.showModal();
    tick(view);
  }

  // 앱이 화면을 다시 그릴 때마다: 권한이 바뀌면 닫고, 연결 상태를 다시 그린다.
  function sync() {
    if (view && !valid(view)) { close(); toast("여행이나 기록 동의가 바뀌어 화면을 닫았어요."); return; }
    if (view && dialog.querySelector(".link-state")?.classList.contains("is-offline") === isOnline()) paint();
  }
  // 이 여행에 끝나지 않은 만들기가 있는가(멈췄거나 아직 도는 중). 돌아왔을 때 앱이 이 화면을 다시 연다.
  const pending = () => { const r = restore(); return !!r && r.items.some((i) => !i.assetId && i.phase !== "failed"); };
  return { open, close, sync, pending, isOpen: () => !!view };
}
