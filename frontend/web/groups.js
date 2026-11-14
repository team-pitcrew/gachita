// 가족·동승 그룹(흐름 F2, T133): P09–P16, P39–P43, 폰 QR 참여(phoneJoin·phoneJoined·phoneGuestJoin·phoneGuestJoined),
// 초대 링크 공유·복사. 서버 계약은 docs/api/groups.md. 화면은 앱 위에 겹치는 전체 화면 대화 상자다(주소의 #는 바꾸지 않음).
// 사용자가 쓴 글은 textContent로만 넣는다(innerHTML 금지).
import { api, h, SEAT, SEATS, toast } from "./shared.js";
import { CHARACTER_OPTIONS, characterImage, characterKey } from "./short-film.js";
import { qrcode } from "./qrcode.js";

const PENDING = "gachita:group-pending"; // 프로필을 만들기 전에 연 초대 링크의 코드(이 탭에서만)
const CODE = /^(FAMILY|TRIP)-[0-9]{4}$/;
const button = (label, onclick, className = "", disabled = false) => h("button", { type: "button", className, onclick, disabled }, label);
const face = (person) => h("span", { className: "group-face", "aria-hidden": "true" }, characterImage(characterKey(person?.character)));

// 초대 링크(같은 출처의 /?group=코드)에서 코드를 읽는다. 다른 출처·다른 경로는 읽지 않는다.
export function groupCode(url, origin) {
  try {
    const target = new URL(url, origin);
    const code = (target.searchParams.get("group") ?? "").toUpperCase();
    return target.origin === origin && target.pathname === "/" && CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

// 자리 둘을 맞바꾼 결과(P14). 바꾸지 않은 사람은 그대로.
// 빈자리(또는 남의 자리)에 앉힌다: 그 자리에 있던 사람은 옮긴 사람의 원래 자리(없으면 자리 없음)로.
export function seatTo(members, who, seat) {
  const from = members.find((m) => m.profileId === who)?.seat ?? null;
  return members.map((m) => (m.profileId === who ? { ...m, seat } : m.seat === seat ? { ...m, seat: from } : m));
}
export function swapSeats(members, a, b) {
  const seatA = members.find((m) => m.profileId === a)?.seat ?? null;
  const seatB = members.find((m) => m.profileId === b)?.seat ?? null;
  return members.map((m) => (m.profileId === a ? { ...m, seat: seatB } : m.profileId === b ? { ...m, seat: seatA } : m));
}

// 우리 가족(P13)의 아래 줄: 모두 동의하고 목소리를 등록했으면 다음 탑승부터 자동 기록.
export function readiness(members) {
  const consent = members.filter((m) => m.consent).length;
  const voice = members.filter((m) => m.hasVoice).length;
  return consent === members.length && voice === members.length
    ? "동의와 목소리 등록 완료 / 다음 탑승부터 자동 기록 켜짐"
    : `녹음 동의 ${consent}/${members.length}명 / 목소리 등록 ${voice}/${members.length}명`;
}

// 마지막 글자에 받침이 있는지(이/가, 과/와).
const batchim = (word) => {
  const c = (word ?? "").trim().at(-1)?.charCodeAt(0) ?? 0;
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
};
const and = (word) => `${word}${batchim(word) ? "과" : "와"}`;

// 'P09·P39·P40 가족 추가'의 제목: 누가 들어왔는지에 따라 바뀐다.
export function memberHeading(group, me) {
  const others = (group?.members ?? []).filter((m) => m.profileId !== me?.id);
  const adults = others.filter((m) => m.role !== "child");
  const kids = others.filter((m) => m.role === "child");
  if (kids.length) return [`${kids.at(-1).name}까지 준비됐어요`, `${[me?.name, ...adults.map((m) => m.name), ...kids.map((m) => m.name)].filter(Boolean).join(", ")} 준비 완료 / 다음 아이를 추가해 주세요.`];
  if (adults.length) return [`${adults.at(-1).name}${batchim(adults.at(-1).name) ? "이" : "가"} 함께해요`, `${adults.at(-1).name} 계정 연결 완료 / 이제 아이를 추가해 주세요.`];
  return ["우리 가족 추가", "기존 계정 연결 또는 아이 프로필 직접 만들기"];
}

export function createGroups({ getProfile, getToken, onProfile, onTrip, onChange = () => {} }) {
  let s = null;
  const call = (method, path, body) => api(method, path, body, getToken());
  const family = () => s.groups.find((g) => g.kind === "family") ?? null;
  const current = () => s.groups.find((g) => g.id === s.groupId) ?? family();

  function close() {
    if (!s) return;
    clearInterval(s.timer);
    s.dialog.close();
    s.dialog.remove();
    s = null;
  }
  function begin(view) {
    close();
    s = { view, groups: [], groupId: null, invite: null, busy: false, draft: { name: "", character: "cap", consent: true }, seats: null, swapped: null, voice: 0 };
    s.dialog = h("dialog", { className: "groups-dialog", "aria-label": "가족과 동승 그룹", oncancel: (e) => { e.preventDefault(); back(); } });
    document.body.append(s.dialog);
    s.dialog.showModal();
  }
  async function load() {
    s.groups = (await call("GET", "/groups")).items;
  }
  async function act(fn) {
    if (!s || s.busy) return;
    s.busy = true;
    paint();
    try {
      await fn();
    } catch (e) {
      note(e.message);
    } finally {
      if (s) {
        s.busy = false;
        paint();
      }
    }
  }
  const go = (view) => {
    s.view = view;
    paint();
    s.dialog.scrollTop = 0;
  };
  const PARENT = { child: "member", childVoice: "member", seat: "group", guest: "group" };
  const back = () => (s.view === "invite" ? go(current()?.kind === "guest" ? "group" : "member") : PARENT[s.view] ? go(PARENT[s.view]) : close());
  async function ensureFamily() {
    if (family()) return family();
    const made = await call("POST", "/groups", { name: "우리 가족", kind: "family" });
    s.groups.push(made);
    return made;
  }

  // 화면 틀: 머리(가치타 · 연결됨), 탭(P13 이후), 제목, 본문, 아래 단추.
  const top = () => h("div", { className: "group-top" }, button("‹", back, "plain group-back"), h("span", { className: "brand" }, "가치타"), h("span", { className: "meta" }, navigator.onLine ? "연결됨" : "연결 끊김"));
  const tabs = () => h("nav", { className: "journey-tabs", "aria-label": "여행 메뉴" }, h("button", { type: "button", className: "selected", "aria-current": "page" }, "함께 타는 중"), button("대화 기록", close), button("콘텐츠 기록", close));
  const page = (title, sub, body, actions, withTabs = false) => [
    top(),
    withTabs && tabs(),
    h("h1", {}, title),
    sub && h("p", { className: "sub" }, sub),
    ...body,
    h("div", { className: "group-actions" }, actions),
  ];
  const meCard = (detail) => {
    const me = getProfile();
    return h("div", { className: "group-card soft row" }, face(me), h("div", {}, h("strong", {}, me?.name ?? "내 계정"), h("small", {}, detail)));
  };

  function memberView() {
    const g = family();
    const me = getProfile();
    const [title, sub] = memberHeading(g, me);
    const kids = (g?.members ?? []).filter((m) => m.role === "child");
    const adults = (g?.members ?? []).filter((m) => m.role !== "child" && m.profileId !== me?.id);
    return page(title, sub, [
      meCard(`내 계정 / ${me?.hasVoice ? "목소리 등록 완료" : "목소리 등록 전"}`),
      ...adults.map((m) => h("div", { className: "group-card row" }, face(m), h("div", {}, h("strong", {}, m.name), h("small", {}, `계정 연결 완료${m.consent ? "" : " / 동의 전"}`)))),
      ...kids.map((m) => h("div", { className: "group-card row" }, face(m), h("div", {}, h("strong", {}, m.name), h("small", {}, `아이 프로필 / ${m.hasVoice ? "목소리 등록 완료" : "목소리 등록 전"}`)))),
      button("가족 계정 초대하기", () => act(invite), "group-ghost", s.busy),
      button("아이 프로필 만들기", () => go("child"), "group-ghost", s.busy),
      h("div", { className: "group-card" }, h("strong", {}, "가족 그룹은 한 번만"), h("small", {}, "저장한 구성원과 좌석을 다음 여행에도 사용")),
    ], [
      g && g.members.length > 1 && button("우리 가족 좌석 보기", () => go("group"), "group-ghost"),
      adults.length ? button(kids.length ? "다음 아이 프로필 만들기" : "아이 프로필 만들기", () => go("child"), "primary") : button("가족 계정 초대하기", () => act(invite), "primary", s.busy),
    ]);
  }

  async function invite(groupId) {
    const g = groupId ? s.groups.find((x) => x.id === groupId) : await ensureFamily();
    s.groupId = g.id;
    s.invite = await call("POST", `/groups/${g.id}/invites`);
    go("invite");
  }
  const link = () => new URL(s.invite.url, location.origin).href;
  // 대화 상자는 맨 위 층이라 앱의 #toast가 가려진다 — 알림을 상자 안에 띄운다(2047:2313 '복사했어요').
  function note(message) {
    if (!s) return toast(message);
    s.dialog.querySelector(".group-toast")?.remove();
    const el = h("p", { className: "group-toast", role: "status" }, message);
    s.dialog.append(el);
    setTimeout(() => el.remove(), 2500);
  }
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      note("복사했어요");
    } catch {
      note("복사하지 못했어요. 길게 눌러 직접 복사해 주세요.");
    }
  }
  // QR: qrcode-generator로 칸만 읽어 SVG로 그린다(사진 없음, 외부 요청 없음).
  function qr(text) {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `-2 -2 ${n + 4} ${n + 4}`);
    svg.setAttribute("class", "group-qr");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "초대 QR");
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }
  // 공유 시트(2047:2316·2333): 카카오톡·메시지는 기기의 공유 화면으로 연다.
  function share() {
    const g = current();
    const sheet = h("dialog", { className: "group-share", "aria-label": "초대 링크 공유" });
    const done = () => (sheet.close(), sheet.remove());
    const native = async () => {
      if (!navigator.share) return copy(link());
      await navigator.share({ title: `${g.name} 초대`, text: `${g.name}에 함께 타요. 초대 코드 ${s.invite.code}`, url: link() }).catch(() => {});
    };
    sheet.append(
      h("h2", {}, "초대 링크 공유"),
      h("p", {}, `${g.name} / ${s.invite.code}`),
      h("p", { className: "sub" }, "링크를 열면 이 그룹의 참여 화면으로 연결돼요."),
      h("div", { className: "group-share-row" },
        button("카카오톡", () => native().then(done)),
        h("a", { className: "group-share-link", href: `sms:?&body=${encodeURIComponent(`${g.name} 초대 ${link()}`)}`, onclick: () => setTimeout(done) }, "메시지"),
        button("링크 복사", () => copy(link()).then(done))),
      button("닫기", done, "group-ghost"),
    );
    s.dialog.append(sheet);
    sheet.showModal();
  }
  function inviteView() {
    const g = current();
    const guest = g.kind === "guest";
    return page(guest ? "동승자 초대하기" : "가족 초대하기", "코드와 링크를 만들었어요. 편하게 공유하세요.", [
      h("div", { className: "group-card center" },
        h("small", {}, "초대 코드"),
        h("strong", { className: "group-code" }, s.invite.code),
        button("코드 복사", () => copy(s.invite.code), "group-ghost"),
        qr(link()),
        h("p", {}, "QR로도 바로 참여할 수 있어요")),
      h("small", {}, "초대 링크"),
      h("div", { className: "group-card soft" }, h("strong", {}, `${g.name} 초대 링크`), h("small", {}, `열면 앱에서 ${s.invite.code} 그룹으로 연결`)),
      button("초대 링크 공유", share, "primary"),
      h("div", { className: "group-pair" }, button("링크 복사", () => copy(link()), "group-ghost"), h("a", { className: "group-ghost group-open", href: s.invite.url }, "링크 열기")),
      h("p", { className: "meta" }, "코드 입력, QR 스캔, 초대 링크 모두 같은 그룹으로 참여해요."),
    ], [button(guest ? "참여 확인하고 그룹으로" : "참여 확인", () => act(async () => { await load(); go(guest ? "group" : "member"); }), "primary", s.busy)]);
  }

  function childView() {
    const d = s.draft;
    const ready = () => !s.busy && Boolean(d.name.trim()) && d.consent; // 서버도 보호자 동의 없이는 아이를 만들지 않는다
    const name = h("input", { className: "group-input", value: d.name, placeholder: "아이 이름", maxLength: 20, "aria-label": "아이 이름", oninput: (e) => { d.name = e.target.value; submit.disabled = !ready(); } });
    const label = CHARACTER_OPTIONS.find(([k]) => k === d.character)?.[1].split(" · ")[0] ?? "";
    const pick = () => {
      const i = CHARACTER_OPTIONS.findIndex(([k]) => k === d.character);
      d.character = CHARACTER_OPTIONS[(i + 1) % CHARACTER_OPTIONS.length][0];
      paint();
    };
    const submit = button("동의하고 목소리 등록", () => act(async () => {
      const g = await ensureFamily();
      const made = await call("POST", `/groups/${g.id}/children`, { name: d.name.trim(), character: d.character, guardianConsent: d.consent });
      s.groups = s.groups.map((x) => (x.id === made.id ? made : x));
      s.child = made.members.filter((m) => m.role === "child").at(-1);
      s.draft = { name: "", character: "cap", consent: true };
      s.voice = 0;
      go("childVoice");
      record();
    }), "primary", !ready());
    return page("아이 프로필 만들기", "보호자가 이름과 캐릭터, 목소리를 관리해요.", [
      h("small", {}, "아이 이름"),
      name,
      h("button", { type: "button", className: "group-card row group-character", onclick: pick, "aria-label": "캐릭터 바꾸기" }, face(d), h("strong", {}, `${label} ${d.name || ""}`.trim())),
      h("div", { className: "group-card" }, h("strong", {}, "아이 목소리 15초 등록"), h("small", {}, "아이에게 짧은 문장을 읽어 달라고 해주세요.")),
      h("label", { className: "group-check" }, h("input", { type: "checkbox", checked: d.consent, onchange: (e) => { d.consent = e.target.checked; submit.disabled = !ready(); } }), "보호자로서 아이의 녹음과 콘텐츠 처리에 동의해요."),
    ], [submit]);
  }

  // mock: 아이 목소리 15초 등록(P12·P42). 화면과 15초 진행만 실제이고, 값 올리기
  // (POST /groups/{id}/members/{profileId}/voice, JSON {embedder, vector[112], seconds})는 웹 임베더(흐름 F1)가 들어온 뒤 잇는다.
  function record() {
    clearInterval(s.timer);
    s.timer = setInterval(() => {
      if (!s) return;
      s.voice = Math.min(15, s.voice + 1);
      if (s.voice >= 15) clearInterval(s.timer);
      paint();
    }, 1000);
  }
  function childVoiceView() {
    const kid = s.child;
    const bars = Array.from({ length: 28 }, (_, i) => h("i", { style: `height:${i < (s.voice / 15) * 28 ? 18 + ((i * 37) % 40) : 10}px` }));
    const done = s.voice >= 15;
    return page(`${kid?.name ?? "아이"}의 목소리 등록`, `“나는 ${kid?.name ?? "아이"}${batchim(kid?.name ?? "아이") ? "이야" : "야"}. 바다에 가서 모래성을 만들 거야.”`, [
      h("div", { className: "group-card" }, h("small", {}, `아이 목소리  ${s.voice} / 15초`), h("div", { className: "group-wave", "aria-hidden": "true" }, bars), h("small", {}, `00:${String(s.voice).padStart(2, "0")}`)),
      done && h("div", { className: "group-card soft row" }, face(kid), h("div", {}, h("strong", {}, `${kid?.name ?? "아이"}의 프로필 준비 완료`), h("small", {}, "다음 아이도 같은 방법으로 추가할 수 있어요."))),
    ], [button(done ? "가족 그룹에 저장" : "녹음 중…", () => act(async () => { await load(); go("member"); }), "primary", !done || s.busy)]);
  }

  // 우리 가족(P13·P43)과 좌석 바꾸기(P14): 위가 차 앞쪽, 앞줄 둘·뒷줄 둘(뒤 가운데는 앉았을 때만).
  function seatGrid(members, onpick, picked) {
    const at = Object.fromEntries(members.filter((m) => m.seat).map((m) => [m.seat, m]));
    const seat = ([id, label]) => {
      const m = at[id];
      return h("button", { type: "button", className: `seat${m ? "" : " empty"}${id === "ROW_1_LEFT" ? " me" : ""}${m && m.profileId === picked ? " picked" : ""}`, onclick: () => onpick?.(m, id), disabled: !onpick },
        m ? face(m) : h("span", { className: "seat-blank", "aria-hidden": "true" }), h("strong", {}, m ? m.name : "빈자리"), h("small", {}, label));
    };
    const rear = SEATS.slice(2).filter(([id]) => id !== "ROW_2_CENTER" || at[id]);
    return h("section", { className: "seat-map group-seats", "aria-label": "가족 좌석" },
      h("p", { className: "seat-front" }, "차량 앞쪽 ↑"),
      h("div", { className: "seat-row" }, SEATS.slice(0, 2).map(seat)),
      h("div", { className: `seat-row${rear.length > 2 ? " three" : ""}` }, rear.map(seat)));
  }
  function groupView() {
    const g = current();
    if (!g) return memberView();
    const free = g.members.filter((m) => !m.seat);
    return page(g.kind === "guest" ? g.name : "우리 가족", s.saved ? "새 좌석을 저장했어요." : `${g.members.length}명 / ${g.kind === "guest" ? "동승 그룹" : "기본 그룹"} / 좌석을 눌러 변경`, [
      seatGrid(g.members, (m) => { s.seats = g.members; s.swapped = null; s.moved = null; s.picked = m?.profileId ?? null; s.saved = false; go("seat"); }),
      free.length > 0 && h("p", { className: "meta" }, `자리 없음: ${free.map((m) => m.name).join(", ")}`),
      h("p", { className: "group-ready" }, readiness(g.members)),
    ], [
      button("새 동승 그룹", () => { s.draft.guestName = ""; go("guest"); }, "group-ghost"),
      button(g.kind === "guest" ? "이 그룹과 출발" : "이 가족과 출발", () => act(async () => {
        const trip = await call("POST", "/trips", { groupId: g.id, title: g.name });
        const me = trip.participants.find((p) => p.profileId === getProfile()?.id);
        close();
        onTrip(trip.code, me?.id, me && trip.tokens[me.id]);
      }), "primary", s.busy),
    ], true);
  }
  function seatView() {
    const g = current();
    // 사람 → 사람은 맞바꾸고, 사람 → 빈자리는 그 자리에 앉힌다(자리 없는 아이·초대로 들어온 사람·동승자도 자리를 받게).
    const pick = (m, seat) => {
      if (!m) {
        if (!s.picked || !seat) return;
        s.moved = s.seats.find((x) => x.profileId === s.picked)?.name;
        s.seats = seatTo(s.seats, s.picked, seat);
        s.swapped = null;
        s.picked = null;
        return paint();
      }
      if (!s.picked || s.picked === m.profileId) { s.picked = m.profileId; return paint(); }
      s.seats = swapSeats(s.seats, s.picked, m.profileId);
      s.swapped = [s.seats.find((x) => x.profileId === s.picked)?.name, m.name];
      s.moved = null;
      s.picked = null;
      paint();
    };
    const changed = s.seats.some((m) => (m.seat ?? null) !== (g.members.find((x) => x.profileId === m.profileId)?.seat ?? null));
    const free = s.seats.filter((m) => !m.seat);
    const rear = s.swapped && s.seats.filter((x) => s.swapped.includes(x.name)).every((x) => x.seat?.startsWith("ROW_2"));
    const sub = s.swapped ? `${and(s.swapped[0])} ${s.swapped[1]}의 ${rear ? "뒷자리" : "자리"} 위치를 바꿨어요.` : s.moved ? `${s.moved}의 자리를 정했어요.` : s.picked ? "빈자리나 바꿀 사람을 눌러 주세요." : "사람을 누른 뒤 빈자리나 다른 사람을 눌러 주세요.";
    return page("가족 좌석 바꾸기", sub, [seatGrid(s.seats, pick, s.picked),
      free.length > 0 && h("p", { className: "meta" }, "자리 없음: 눌러서 고른 뒤 빈자리를 눌러요"),
      free.length > 0 && h("div", { className: "group-pair" }, free.map((m) => button(m.name, () => pick(m), `group-ghost${m.profileId === s.picked ? " picked" : ""}`))),
    ], [button("이 배치로 저장", () => act(async () => {
      const seats = Object.fromEntries(s.seats.filter((m) => m.seat !== g.members.find((x) => x.profileId === m.profileId)?.seat).map((m) => [m.profileId, m.seat]));
      const saved = await call("PUT", `/groups/${g.id}/seats`, { seats });
      s.groups = s.groups.map((x) => (x.id === saved.id ? saved : x));
      s.saved = true;
      go("group");
    }), "primary", s.busy || !changed)], true);
  }

  function guestView() {
    const me = getProfile();
    const input = h("input", { className: "group-input", value: s.draft.guestName ?? "", placeholder: "주말 바다 친구들", maxLength: 20, "aria-label": "그룹 이름", oninput: (e) => { s.draft.guestName = e.target.value; } });
    const make = async () => {
      const made = await call("POST", "/groups", { name: (s.draft.guestName ?? "").trim() || "동승 그룹", kind: "guest" });
      s.groups.push(made);
      s.groupId = made.id;
      return made;
    };
    return page("새 동승 그룹", "가족 외 동승자도 여행별로 함께할 수 있어요.", [
      h("small", {}, "그룹 이름"),
      input,
      h("div", { className: "group-card soft row" }, face(me), h("div", {}, h("strong", {}, "내 계정"), h("small", {}, `${me?.name ?? ""} / 운전석`))),
      button("계정 초대 링크 만들기", () => act(async () => invite((await make()).id)), "group-ghost", s.busy),
      h("p", { className: "meta" }, "새 동승자는 본인이 동의한 뒤 그룹에 참여해요."),
    ], [button("그룹 저장", () => act(async () => { await make(); s.saved = false; go("group"); }), "primary", s.busy)], true);
  }

  // 폰 QR·링크 참여(phoneJoin·phoneGuestJoin → phoneJoined·phoneGuestJoined). 토큰 없는 미리보기는 그룹·대표 이름만.
  function joinView() {
    const p = s.preview;
    const me = getProfile();
    const guest = p.kind === "guest";
    return page(guest ? `${p.groupName || "동승 그룹"}에 초대받았어요` : "우리 가족에 초대받았어요", `${p.ownerName}님의 차량 / 내 프로필로 참여`, [
      h("div", { className: "group-card" }, h("strong", {}, `${and(p.groupName)} 함께 타요`), h("small", {}, `${me?.name ?? ""} / 등록된 캐릭터와 목소리 연결`)),
      h("div", { className: "group-card" }, h("strong", {}, "대화 기록과 콘텐츠 생성"), h("small", {}, "음성과 전사록 업로드, 요약과 편집에 사용")),
      h("div", { className: "group-card" }, h("strong", {}, "내 목소리로 발화자 구분"), h("small", {}, "등록한 음성 특징으로 말하는 사람 구분")),
      h("p", { className: "meta" }, "함께 타는 성인은 직접 동의하고, 아이의 프로필과 녹음은 보호자가 관리해요."),
    ], [button("동의하고 그룹 참여", () => act(async () => {
      await call("PATCH", "/profiles/me", { consent: true });
      const g = await call("POST", `/group-invites/${s.code}`);
      s.groups = [g];
      s.groupId = g.id;
      sessionStorage.removeItem(PENDING);
      onChange();
      go("joined");
    }), "primary", s.busy)]);
  }
  function joinedView() {
    const g = current();
    const me = g.members.find((m) => m.profileId === s.meId);
    return page(g.kind === "guest" ? `${g.name || "동승 그룹"}에 참여했어요` : "우리 가족에 참여했어요", "차량과 폰에서 같은 프로필을 사용해요.", [
      h("div", { className: "group-card soft row" }, face(me), h("div", {}, h("strong", {}, `${me?.name ?? ""} / ${g.kind === "guest" ? "동승자" : me?.seat ? SEAT[me.seat] : "자리 정하기 전"}`), h("small", {}, me?.hasVoice ? "내 프로필과 등록된 목소리 연결 완료" : "내 프로필 연결 완료 / 목소리는 내 프로필에서 등록"))),
      h("div", { className: "group-card" }, h("strong", {}, "이제 함께 출발해요"), h("small", {}, "차량에서 내 캐릭터와 참여 상태를 확인해 주세요.")),
    ], [button("차량에서 참여 확인", () => act(async () => { await load(); go("group"); }), "primary", s.busy)]);
  }

  function paint() {
    if (!s) return;
    const view = { member: memberView, invite: inviteView, child: childView, childVoice: childVoiceView, group: groupView, seat: seatView, guest: guestView, join: joinView, joined: joinedView }[s.view]();
    const kept = [...s.dialog.querySelectorAll(":scope > .group-share, :scope > .group-toast")]; // 공유 시트와 알림은 다시 그려도 남긴다
    s.dialog.replaceChildren(h("div", { className: "group-content" }, view.flat().filter(Boolean)), ...kept);
  }

  return {
    // 가족을 연다: 모두 자리가 정해진 가족이면 좌석 지도(P13), 아직 모으는 중이면 가족 추가(P09·P39·P40).
    async open() {
      if (!getToken()) return onProfile();
      begin("member");
      await act(async () => {
        await load();
        const members = family()?.members ?? [];
        s.view = members.length > 1 && members.every((m) => m.seat) ? "group" : "member";
      });
    },
    // 초대 링크(/?group=코드)로 들어온 폰: 코드를 이 탭에 남기고 주소에서 지운다. 프로필을 읽으면(없으면 만든 뒤) resume이 연다.
    remember() {
      const code = groupCode(location.href, location.origin);
      if (!code) return;
      sessionStorage.setItem(PENDING, code);
      const url = new URL(location.href);
      url.searchParams.delete("group");
      history.replaceState(null, "", url);
    },
    async join(code) {
      begin("join");
      s.code = code;
      s.meId = getProfile()?.id;
      try {
        s.preview = await api("GET", `/group-invites/${code}`);
        paint();
      } catch (e) {
        close();
        sessionStorage.removeItem(PENDING);
        toast(e.status === 410 ? "만료됐거나 바뀐 초대예요. 새 코드를 받아 주세요." : e.message);
      }
    },
    resume() {
      const code = sessionStorage.getItem(PENDING);
      if (code && !s && getToken() && getProfile()) this.join(code);
    },
    close,
    isOpen: () => Boolean(s),
  };
}
