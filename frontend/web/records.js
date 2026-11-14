// 내 기록본과 장면 후보(T43). 앱 상태는 읽는 함수로 받고, 닫힌 화면에는 늦게 온 응답을 그리지 않는다.
import { api, h, toast } from "./shared.js";

const FEED_POLL_MS = 5000;
const button = (label, onclick, className = "") => h("button", { type: "button", className, onclick }, label);
const when = (at) => new Date(at).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
const errorText = (e) => e.status === 0 ? "연결이 끊겨서 기록을 읽지 못했어요. 다시 연결한 뒤 눌러 주세요." : e.status === 401 ? "이 폰의 연결을 다시 확인해 주세요." : e.status === 403 ? "기록에 동의한 참가자만 볼 수 있어요." : e.message;

// 저장할 때는 후보의 구간·위치만 전달한다. 표시용 발화·화자·점수는 보내지 않는다.
export function chosenMoment(candidate, label) {
  return {
    at: candidate.at,
    from: candidate.from,
    to: candidate.to,
    label: label.trim() || "함께 남긴 장면",
    ...(Number.isFinite(candidate.lat) && Number.isFinite(candidate.lng) ? { lat: candidate.lat, lng: candidate.lng } : {}),
  };
}

export function createRecords({ getProfile, getProfileToken, getTrip, getParticipant, getParticipantToken, participantRequest, onSaved, onProfile }) {
  const dialog = h("dialog", { className: "records-dialog", "aria-labelledby": "records-title" });
  document.body.append(dialog);
  let state = null;
  let feedTimer;
  const stopFeed = () => {
    clearTimeout(feedTimer);
    state?.controller?.abort();
  };
  const close = () => {
    stopFeed();
    state = null;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
  };
  dialog.addEventListener("close", () => { if (!dialog.open) close(); });
  addEventListener("hashchange", close);

  // 동의 철회/다른 여행을 폴링에서 확인하면 이미 받은 글도 화면에서 걷는다.
  const valid = (s) => {
    if (state !== s) return false;
    if (s.mode === "feed") return getProfile()?.id === s.profileId && getProfileToken() === s.token;
    const trip = getTrip();
    const me = getParticipant();
    return trip?.code === s.code && trip.generation === s.generation && me?.id === s.participantId && me.consent;
  };
  const sync = () => {
    if (state && !valid(state)) {
      close();
      toast("프로필이나 기록 동의가 바뀌어 기록 화면을 닫았어요.");
    }
  };
  // 저장·삭제의 결과와 오류는 모달 안에 둔다(모달이 최상위 레이어라 #toast는 그 뒤에 가려진다).
  const shell = (s, ...content) => {
    if (!valid(s)) return;
    dialog.replaceChildren(
      h("div", { className: "between records-heading" }, h("h1", { id: "records-title" }, s.mode === "feed" ? "내 기록본" : "장면 후보"), button("닫기", close, "plain")),
      ...[s.note && h("p", { role: s.note.alert ? "alert" : "status", className: s.note.alert ? "records-note alert" : "records-note" }, s.note.text), ...content].filter(Boolean),
    );
  };
  const note = (s, text, alert = false) => (s.note = { text, alert });
  const show = (s) => {
    stopFeed();
    state = s;
    shell(s, h("p", { role: "status" }, "기록을 불러오고 있어요."));
    if (!dialog.open) dialog.showModal();
  };
  const failed = (s, e, retry) => shell(s,
    h("p", { role: "alert" }, errorText(e)),
    e.status === 401 && s.mode === "feed" ? button("프로필 확인", () => (close(), onProfile())) : button("다시 보기", retry),
  );

  async function openFeed() {
    const profile = getProfile();
    const token = getProfileToken();
    if (!profile || !token) return onProfile();
    const s = { mode: "feed", profileId: profile.id, token, items: [], pending: new Set(), deleted: new Set(), controls: new Map() };
    show(s);
    await loadFeed(s);
  }
  async function loadFeed(s) {
    if (!valid(s)) return sync();
    if (s.loading) return;
    s.loading = true;
    const controller = s.controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const { items } = await api("GET", "/profiles/me/feed", null, s.token, controller.signal);
      if (!valid(s)) return;
      // 삭제 직전에 시작한 조회가 늦게 끝나도 이 화면에서 지운 장면을 되살리지 않는다.
      s.items = items.filter((item) => item.kind !== "moment" || !s.deleted.has(item.id));
      const snapshot = JSON.stringify(s.items);
      if (snapshot !== s.snapshot) { s.snapshot = snapshot; feedView(s); }
    } catch (e) {
      if (valid(s)) {
        s.items = [];
        s.snapshot = undefined;
        s.stopped = e.status === 401 || e.status === 403;
        failed(s, e, openFeed); // 오래된 개인 발화를 오류 화면 뒤에 남겨 두지 않는다.
      }
    } finally {
      clearTimeout(timeout);
      s.loading = false;
      if (state === s) {
        sync();
        if (valid(s) && !s.stopped) feedTimer = setTimeout(() => loadFeed(s), FEED_POLL_MS);
      }
    }
  }
  async function erase(s, item, control) {
    if (!valid(s) || s.pending.has(item.id) || !confirm("내 앨범에서 이 장면을 지울까요? 다른 사람의 앨범과 여행의 장면은 그대로예요.")) return;
    s.pending.add(item.id);
    s.note = null;
    control.disabled = true;
    try {
      await api("DELETE", `/profiles/me/moments/${encodeURIComponent(item.id)}`, null, s.token).catch((e) => { if (e.status !== 404) throw e; });
      if (!valid(s)) return;
      s.deleted.add(item.id);
      s.items = s.items.filter((entry) => entry.kind !== "moment" || entry.id !== item.id);
      s.snapshot = JSON.stringify(s.items);
      note(s, "내 앨범에서 장면을 지웠어요.");
      feedView(s);
    } catch (e) { if (valid(s)) (note(s, errorText(e), true), feedView(s)); }
    finally {
      s.pending.delete(item.id);
      if (valid(s) && s.controls.has(item.id)) s.controls.get(item.id).disabled = false;
    }
  }
  function feedView(s) {
    s.controls.clear();
    shell(s,
      h("p", { className: "meta" }, "내 이름이 붙은 대화와 내가 고른 장면을 모았어요. 최근 기록 100개를 보여 드려요."),
      s.items.length ? h("ul", { className: "records-list" }, s.items.map((item) => {
        const remove = button("내 앨범에서 지우기", () => erase(s, item, remove), "plain");
        remove.disabled = s.pending.has(item.id);
        s.controls.set(item.id, remove);
        return h("li", { className: "card" },
          h("div", { className: "between" }, h("span", { className: "pill" }, item.kind === "moment" ? "남긴 장면" : "내가 한 말"), h("time", { className: "meta", dateTime: new Date(item.at).toISOString() }, when(item.at))),
          h("p", { className: "what" }, item.kind === "moment" ? item.label || "이름 없는 장면" : item.text),
          item.kind === "moment" && h("p", { className: "meta" }, "이 장면은 내 앨범에 남아요. 소리를 지우거나 기록 동의를 거두면 원음은 들을 수 없어요."),
          item.kind === "moment" && remove,
        );
      })) : h("p", { className: "empty", role: "status" }, "아직 쌓인 기록이 없어요. 여행에서 장면을 고르면 내 앨범에 남아요."),
      button("새로 고침", openFeed),
    );
  }

  async function reloadScenes(s, text) {
    try {
      const { items } = await participantRequest("GET", "/scene-suggestions");
      if (!valid(s)) return;
      s.items = items;
      note(s, text, true);
    } catch (e) {
      if (!valid(s)) return;
      s.items = []; // 확인되지 않은 후보를 다시 누르지 않게 비운다
      note(s, `${text} (후보도 읽지 못했어요: ${errorText(e)})`, true);
    }
    scenesView(s);
    await onSaved();
  }

  async function openScenes() {
    const trip = getTrip();
    const me = getParticipant();
    if (!trip || !me?.consent || !getParticipantToken()) return toast("기록에 동의한 이 폰의 참가자만 장면을 고를 수 있어요.");
    const s = { mode: "scenes", code: trip.code, generation: trip.generation, participantId: me.id, items: [], labels: new Map(), pending: new Set(), controls: new Map() };
    show(s);
    try {
      const { items } = await participantRequest("GET", "/scene-suggestions");
      if (!valid(s)) return;
      s.items = items;
      scenesView(s);
    } catch (e) {
      if (e.status === 404 || e.status === 503) e = new Error("지금은 장면 후보를 준비하지 못했어요. 잠시 뒤 다시 눌러 주세요.");
      failed(s, e, openScenes);
    }
  }
  async function choose(s, item, label, control) {
    if (!valid(s) || s.pending.has(item)) return;
    s.pending.add(item);
    s.note = null;
    control.disabled = true;
    try {
      await participantRequest("POST", "/moments", chosenMoment(item, label));
      if (!valid(s)) return;
      s.items = s.items.filter((entry) => entry !== item);
      s.labels.delete(item);
      note(s, "장면을 남겼어요. 차가 연결되면 그 구간의 소리를 준비해요.");
      scenesView(s);
      await onSaved();
    } catch (e) {
      if (!valid(s)) return;
      // 서버가 저장하고 응답만 잃었을 수 있다(끊김·5xx). 후보를 다시 읽으면 이미 남은 구간은 서버가 빼 주므로,
      // 그대로 다시 누르게 두지 않고 새 후보로 바꾼다(같은 구간이 두 번 저장되지 않게).
      if (e.status === 0 || e.status >= 500) await reloadScenes(s, "저장 결과를 확인하지 못했어요. 후보를 다시 읽었어요. 남은 장면은 여행 화면에서 확인해 주세요.");
      else (note(s, errorText(e), true), scenesView(s));
    }
    finally {
      s.pending.delete(item);
      if (valid(s) && s.controls.has(item)) s.controls.get(item).disabled = false;
    }
  }
  function scenesView(s) {
    s.controls.clear();
    shell(s,
      h("p", { className: "meta" }, "대화가 오간 구간을 추천해요. 원하는 장면만 직접 남겨 주세요. 소리는 차가 연결돼 있을 때 준비돼요."),
      s.items.length ? h("div", { className: "stack" }, s.items.map((item) => {
        const label = h("input", { value: s.labels.get(item) ?? (item.lines[0]?.text.slice(0, 60) || "함께 남긴 장면"), maxLength: 60, oninput: (e) => s.labels.set(item, e.target.value) });
        const pick = h("button", { type: "submit", className: "primary", disabled: s.pending.has(item) }, "이 장면 남기기");
        s.controls.set(item, pick);
        return h("form", { className: "card", onsubmit: (e) => (e.preventDefault(), choose(s, item, label.value, pick)) },
          h("h2", {}, when(item.at)),
          h("p", { className: "meta" }, item.why),
          h("ul", {}, item.lines.slice(0, 3).map((line) => h("li", {}, line.text))),
          h("label", { className: "field" }, h("span", {}, "장면 이름"), label),
          !Number.isFinite(item.lat) && h("p", { className: "meta" }, "위치 정보가 없어요. 장면 목록에는 남길 수 있어요."),
          pick,
        );
      })) : h("p", { className: "empty", role: "status" }, "추천할 장면이 없어요. 이미 남긴 장면은 여행 화면에서 볼 수 있어요."),
      button("후보 다시 보기", openScenes),
    );
  }
  return { openFeed, openScenes, close, sync };
}
