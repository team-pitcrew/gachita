// 가족·동승 그룹(흐름 F2, T133): P09–P16, P16A·B·C·G·I·L(그룹 상세·좌석 배정·구성원 선택·혼자인 동승 그룹·초대·전체 그룹), P39–P43, 폰 QR 참여(phoneJoin·phoneJoined·phoneGuestJoin·phoneGuestJoined),
// 초대 링크 공유·복사. 서버 계약은 docs/api/groups.md. 화면은 앱 위에 겹치는 전체 화면 대화 상자다(주소의 #는 바꾸지 않음).
// 사용자가 쓴 글은 textContent로만 넣는다(innerHTML 금지).
import { api, h, SEAT, SEATS, toast } from "./shared.js";
import { CHARACTER_OPTIONS, characterImage, characterKey } from "./short-film.js";
import { qrcode } from "./qrcode.js";
import { startVoice, voiceBars, VOICE_SECONDS, WAVE_BARS } from "./voice-meter.js";
import { appBar } from "./ride.js";

const PENDING = "gachita:group-pending"; // 프로필을 만들기 전에 연 초대 링크의 코드(이 탭에서만)
const CODE = /^(FAMILY|TRIP)-[0-9]{4}$/;
const button = (label, onclick, className = "", disabled = false) => h("button", { type: "button", className, onclick, disabled }, label);
const face = (person) => h("span", { className: "group-face", "aria-hidden": "true" }, characterImage(characterKey(person?.character)));

// 그룹 얼굴 2×2('Group / 2x2 / … / Phone'): 앞 네 사람, 남는 칸은 초대 중·미등록 칸. 프로필 드롭다운(profile-menu.js)도 쓴다.
// labels면 빈 칸에 '초대 중'·'미등록' 글자(시안 P10 'Group / 2x2 / inviting / Phone').
export function groupFaces(g, labels = false) {
  const slots = g.members.slice(0, 4).map(face);
  const slot = (inviting) => h("span", { className: `group-slot${inviting ? " inviting" : ""}`, "aria-hidden": "true" }, labels && (inviting ? "초대 중" : "미등록"));
  if (slots.length < 4 && g.invite) slots.push(slot(true));
  while (slots.length < 4) slots.push(slot(false));
  return h("span", { className: `group-faces${labels ? " labeled" : ""}` }, slots);
}

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
// 좌석 바꾸기에서 누른 것의 결과. 자리는 '자리를 눌러야만' 정해지고, 사람을 누르면 고른 사람만 바뀐다.
// 앉아 있던 사람이 자리를 잃는 일은 없게 한다 — 자리 없는 사람을 앉은 사람의 자리에 넣지 않는다(#413 재점검: 엄마가 자리를 잃음).
// target: 자리 칸이면 {seat, member?(그 자리의 사람)}, '자리 없음' 줄이면 {member}. 돌려주는 것: {members?, picked, note?}.
export function seatPick(members, picked, target) {
  const seatOf = (id) => members.find((m) => m.profileId === id)?.seat ?? null;
  if (!target.seat) return { picked: target.member === picked ? null : target.member }; // 자리 없음 줄: 고르기만
  if (!picked) return target.member ? { picked: target.member } : { picked: null, note: "먼저 앉힐 사람을 눌러 주세요." };
  if (target.member === picked) return { picked: null };
  if (!target.member) return { members: seatTo(members, picked, target.seat), picked: null }; // 빈자리에 앉힘
  if (seatOf(picked)) return { members: swapSeats(members, picked, target.member), picked: null }; // 앉은 사람끼리 맞바꿈
  return { picked, note: "앉은 사람이 있는 자리예요. 빈자리를 눌러 주세요." }; // 자리 없는 사람은 빈자리에만
}

// 저장한 그룹에서 앉아 있다가 자리를 잃는 사람(저장·출발을 막는다).
export function lostSeats(saved, edited) {
  const before = new Map(saved.map((m) => [m.profileId, m.seat ?? null]));
  return edited.filter((m) => before.get(m.profileId) && !m.seat);
}

export function swapSeats(members, a, b) {
  const seatA = members.find((m) => m.profileId === a)?.seat ?? null;
  const seatB = members.find((m) => m.profileId === b)?.seat ?? null;
  return members.map((m) => (m.profileId === a ? { ...m, seat: seatB } : m.profileId === b ? { ...m, seat: seatA } : m));
}

// 그룹 한 줄(P16A·P16L '4명  |  기본 그룹'). 혼자인 동승 그룹에 살아 있는 초대가 있으면 '초대 대기'.
export function groupLine(g) {
  const kind = g.kind === "family" ? "기본 그룹" : g.members.length === 1 && g.invite ? "초대 대기" : "동승 그룹";
  return `${g.members.length}명  |  ${kind}`;
}
// 구성원과 저장된 좌석(P16A): 자리 순서대로 [자리, 이름]. 자리 없는 사람은 마지막 한 줄 — 서버는 자리 있는 사람만 여행에 넣는다.
export function seatRows(members) {
  const rows = SEATS.flatMap(([id, label]) => members.filter((m) => m.seat === id).map((m) => [label, m.name]));
  const free = members.filter((m) => !m.seat).map((m) => m.name);
  return free.length ? [...rows, ["자리 없음", free.join(", ")]] : rows;
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
    s.meter?.cancel(); // 아이 목소리 녹음 중이면 마이크를 놓고 모은 소리를 버린다
    s.dialog.close();
    s.dialog.remove();
    s = null;
  }
  function begin(view) {
    close();
    s = { view, groups: [], groupId: null, invite: null, busy: false, draft: { name: "", character: "cap" }, seats: null, swapped: null, meter: null, voiceState: "", voiceNote: "" };
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
  const PARENT = { child: "member", childVoice: "member", seat: "group", guest: "groups", group: "groups", detail: "groups", assign: "detail", picker: "assign" };
  const back = () => (s.view === "invite" ? go(s.inviteFrom) : PARENT[s.view] ? go(PARENT[s.view]) : close());
  async function ensureFamily() {
    if (family()) return family();
    const made = await call("POST", "/groups", { name: "우리 가족", kind: "family" });
    s.groups.push(made);
    return made;
  }

  // 화면 틀: 머리(앱과 같은 머리 줄: 마스코트 · 가치타 · 연결됨), 탭(P13 이후), 제목 묶음, 본문, 아래 단추.
  // 가치타를 누르면 대화 상자를 닫는다(앱 처음 화면). 시안에 없는 '‹'는 두지 않는다(11/15 오너 '시안이 기준') —
  // 돌아가는 길은 시안의 단추(그룹으로·좌석 배정으로·전체 그룹 …)와 가치타, 기기의 뒤로 가기(Esc → back())다.
  const top = () => appBar({ online: navigator.onLine, onHome: close });
  const tabs = () => h("nav", { className: "journey-tabs", "aria-label": "여행 메뉴" }, h("button", { type: "button", className: "selected", "aria-current": "page" }, "함께 타는 중"), button("대화 기록", close), button("콘텐츠 기록", close));
  const page = (title, sub, body, actions, withTabs = false, aside = null) => [
    top(),
    withTabs && tabs(),
    h("div", { className: `ob-title${aside ? " group-aside" : ""}` }, h("h1", {}, title), sub && h("p", { className: "sub" }, sub), aside),
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
    // 시안 P09·P39·P40: 카드는 내 계정 하나. 들어온 사람은 제목 아래 줄(memberHeading)이 알린다.
    return page(title, sub, [
      meCard(`내 계정 / ${me?.hasVoice ? "목소리 등록 완료" : "목소리 등록 전"}`),
      button("가족 계정 초대하기", () => act(invite), "group-ghost", s.busy),
      button("아이 프로필 만들기", () => go("child"), "group-ghost", s.busy),
      h("div", { className: "group-card" }, h("strong", {}, "가족 그룹은 한 번만"), h("small", {}, "저장한 구성원과 좌석을 다음 여행에도 사용")),
    ], [
      g && g.members.length > 1 && button("우리 가족 좌석 보기", () => go("group"), "group-ghost"), // 시안 P39·P40에는 없는 의도적 추가: 아이 0–1명·어른만 가족도 좌석과 출발로 갈 길이 있게(기능이 시안보다 우선)
      adults.length ? button(kids.length ? "다음 아이 프로필 만들기" : "아이 프로필 만들기", () => go("child"), "primary") : button("가족 계정 초대하기", () => act(invite), "primary", s.busy),
    ]);
  }

  async function invite(groupId) {
    const g = groupId ? s.groups.find((x) => x.id === groupId) : await ensureFamily();
    s.groupId = g.id;
    s.invite = await call("POST", `/groups/${g.id}/invites`);
    s.groups = s.groups.map((x) => (x.id === g.id ? { ...x, invite: s.invite } : x));
    s.inviteFrom = s.view === "member" ? "member" : "detail"; // 가족 추가(P10)는 가족 추가로, 그룹 화면·새 동승 그룹(P16I)은 그룹으로
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
    const adding = s.inviteFrom === "member"; // 시안 P10: 가족 추가 중의 초대는 등록 수와 2x2 배지
    return page(guest ? "동승자 초대하기" : "가족 초대하기", adding ? `${g.members.length}명 등록 / 1명 초대 중` : "코드와 링크를 만들었어요. 편하게 공유하세요.", [
      h("div", { className: `group-invite${adding ? " adding" : ""}` },
        h("div", { className: "group-card center" },
          h("small", {}, "초대 코드"),
          h("strong", { className: "group-code" }, s.invite.code),
          button("코드 복사", () => copy(s.invite.code), "group-ghost group-short"),
          qr(link()),
          h("p", {}, "QR로도 바로 참여할 수 있어요")),
        h("div", { className: "group-join" },
          h("small", { className: "group-label" }, "초대 링크"),
          h("div", { className: "group-card soft group-link" }, h("strong", {}, `${g.name} 초대 링크`), h("small", {}, `열면 앱에서 ${s.invite.code} 그룹으로 연결`)),
          button("초대 링크 공유", share, "primary group-short"),
          h("div", { className: "group-pair" }, button("링크 복사", () => copy(link()), "group-ghost group-short"), h("a", { className: "group-ghost group-short group-open", href: s.invite.url }, "링크 열기")))),
    ], [button(adding ? "참여 확인" : "그룹으로 돌아가기", () => act(async () => { await load(); go(s.inviteFrom); }), "primary", s.busy)], guest, adding && groupFaces(g, true)); // 탭은 동승 초대(P16 guestInvite)만, P10·P16I는 없음
  }

  function childView() {
    const d = s.draft;
    const ready = () => !s.busy && Boolean(d.name.trim());
    const label = CHARACTER_OPTIONS.find(([k]) => k === d.character)?.[1].split(" · ")[0] ?? "";
    const tag = h("strong", {}, `${label} ${d.name || ""}`.trim()); // 시안 P11 '캡모자 서준': 이름을 적는 대로 바꾼다
    const name = h("input", { className: "group-input", value: d.name, placeholder: "아이 이름", maxLength: 20, "aria-label": "아이 이름", oninput: (e) => { d.name = e.target.value; tag.textContent = `${label} ${d.name}`.trim(); submit.disabled = !ready(); } });
    const pick = () => {
      const i = CHARACTER_OPTIONS.findIndex(([k]) => k === d.character);
      d.character = CHARACTER_OPTIONS[(i + 1) % CHARACTER_OPTIONS.length][0];
      paint();
    };
    const submit = button("동의하고 목소리 등록", () => act(async () => {
      const g = await ensureFamily();
      const made = await call("POST", `/groups/${g.id}/children`, { name: d.name.trim(), character: d.character, guardianConsent: true }); // '동의하고 목소리 등록'을 누른 것이 보호자 동의(서버도 동의 없이는 만들지 않음)
      s.groups = s.groups.map((x) => (x.id === made.id ? made : x));
      s.child = made.members.filter((m) => m.role === "child").at(-1);
      s.childGroup = g.id;
      s.draft = { name: "", character: "cap" };
      go("childVoice");
      record();
    }), "primary", !ready());
    return page("아이 프로필 만들기", "보호자가 이름과 캐릭터, 목소리를 관리해요.", [
      h("small", {}, "아이 이름"),
      name,
      h("button", { type: "button", className: "group-card row group-character", onclick: pick, "aria-label": "캐릭터 바꾸기" }, face(d), tag),
      h("div", { className: "group-card" }, h("strong", {}, "아이 목소리 15초 등록"), h("small", {}, "아이에게 짧은 문장을 읽어 달라고 해주세요.")),
      h("p", { className: "ob-note" }, "보호자로서 아이의 녹음과 콘텐츠 처리에 동의해요."),
    ], [submit]);
  }

  // 아이 목소리 15초 등록(P12·P42): 보호자 폰의 마이크로 15초를 듣고(막대는 실제 들어온 소리 크기, voice-meter.js),
  // 이 폰에서 값(112차원)으로 바꿔 POST /groups/{id}/members/{profileId}/voice(JSON, #356·#364 계약)로 값만 올린다.
  // 보호자 동의가 꺼진 아이는 녹음하지 않는다(서버도 409). 서버 400(말소리 없음)은 다시 녹음하게 한다.
  async function record() {
    const kid = s.child;
    s.meter?.cancel();
    s.meter = null;
    s.voiceState = "recording";
    s.voiceNote = "";
    if (!kid?.consent) { s.voiceState = "blocked"; s.voiceNote = "보호자 동의가 꺼져 있어 아이 목소리를 녹음하지 않아요."; return paint(); }
    let meter;
    try {
      meter = await startVoice({ slots: WAVE_BARS.length, seconds: VOICE_SECONDS, onChange: () => {
        if (!s || s.meter !== meter) return;
        if (meter.done && s.voiceState === "recording") save(meter);
        else paint();
      } });
    } catch (e) {
      if (!s) return;
      s.voiceState = "failed";
      s.voiceNote = e.message;
      return paint();
    }
    if (!s) return meter.cancel();
    s.meter = meter;
    paint();
  }
  async function save(meter) {
    s.voiceState = "saving";
    paint();
    try {
      const { value } = await meter.finish();
      await call("POST", `/groups/${s.childGroup}/members/${s.child.profileId}/voice`, value);
      if (!s) return;
      s.voiceState = "saved";
    } catch (e) {
      if (!s) return;
      s.voiceState = "failed";
      s.voiceNote = e.status === 400 ? "말소리가 없어 등록할 수 없음" : e.message;
    }
    paint();
  }
  const kidsIn = (id) => s.groups.find((x) => x.id === id)?.members.filter((m) => m.role === "child").length ?? 0;
  // 아이를 저장한 뒤: 둘째 아이부터는 우리 가족 좌석(P42 → P43, 차의 C13과 같은 규칙), 아니면 가족 추가로.
  async function afterChild() {
    await load();
    go(kidsIn(s.childGroup) >= 2 ? "group" : "member");
  }
  // 시안 P12 '하은도 같은 방법으로…'(첫 아이), P42 '우리 가족 4명의 프로필이 모두 준비됐어요.'(둘째 아이부터, 차 C13으로 가는 때와 같음)
  function childDone() {
    const g = s.groups.find((x) => x.id === s.childGroup);
    return kidsIn(s.childGroup) >= 2 ? `${g.name} ${g.members.length}명의 프로필이 모두 준비됐어요.` : "다음 아이도 같은 방법으로 추가할 수 있어요.";
  }
  function childVoiceView() {
    const kid = s.child;
    const sec = Math.floor(Math.min(s.meter?.elapsed() ?? 0, VOICE_SECONDS));
    const saved = s.voiceState === "saved";
    const retry = s.voiceState === "failed" || s.voiceState === "blocked";
    return page(`${kid?.name ?? "아이"}의 목소리 등록`, `“나는 ${kid?.name ?? "아이"}${batchim(kid?.name ?? "아이") ? "이야" : "야"}. 바다에 가서 모래성을 만들 거야.”`, [
      h("div", { className: "ob-meter" }, h("span", {}, `아이 목소리  ${sec} / ${VOICE_SECONDS}초`),
        voiceBars(s.meter, { className: "ob-wave", slots: WAVE_BARS.length, ready: WAVE_BARS, min: 11, max: 62, upcoming: WAVE_BARS }),
        h("p", {}, h("span", {}, `00:${String(sec).padStart(2, "0")}`), h("span", {}, `00:${VOICE_SECONDS}`))),
      s.voiceNote && h("p", { className: "meta", role: "status" }, s.voiceNote),
      saved && h("div", { className: "group-card soft row" }, face(kid), h("div", {}, h("strong", {}, `${kid?.name ?? "아이"}의 프로필 준비 완료`), h("small", {}, childDone()))),
    ], [saved ? button("가족 그룹에 저장", () => act(afterChild), "primary", s.busy)
      : retry ? button(s.voiceState === "blocked" ? "가족 그룹에 저장" : "다시 녹음", () => (s.voiceState === "blocked" ? act(afterChild) : record()), "primary", s.busy)
      : button(s.voiceState === "saving" ? "등록 중…" : "녹음 중…", () => {}, "primary", true)]);
  }

  // 우리 가족(P13·P43)과 좌석 바꾸기(P14): 위가 차 앞쪽, 앞줄 둘·뒷줄 둘(뒤 가운데는 앉았을 때만).
  function seatGrid(members, onpick, picked, center = false, className = "") {
    const at = Object.fromEntries(members.filter((m) => m.seat).map((m) => [m.seat, m]));
    const seat = ([id, label]) => {
      const m = at[id];
      return h("button", { type: "button", className: `seat${m ? "" : " empty"}${id === "ROW_1_LEFT" ? " me" : ""}${m && m.profileId === picked ? " picked" : ""}`, onclick: () => onpick?.(m, id), disabled: !onpick },
        m ? face(m) : h("span", { className: "seat-blank", "aria-hidden": "true" }), h("strong", {}, m ? m.name : "빈자리"), h("small", {}, label));
    };
    const rear = SEATS.slice(2).filter(([id]) => id !== "ROW_2_CENTER" || at[id] || center); // 자리 없는 사람이 있으면 빈 가운데도 고를 수 있게
    return h("section", { className: `seat-map group-seats ${className}`, "aria-label": "가족 좌석" },
      h("p", { className: "seat-front" }, "차량 앞쪽 ↑"),
      h("div", { className: "seat-row" }, SEATS.slice(0, 2).map(seat)),
      h("div", { className: `seat-row${rear.length > 2 ? " three" : ""}` }, rear.map(seat)));
  }
  function groupView() {
    const g = current();
    if (!g) return memberView();
    const free = g.members.filter((m) => !m.seat);
    return page(g.kind === "guest" ? g.name : "우리 가족", `${g.members.length}명 / ${g.kind === "guest" ? "동승 그룹" : "기본 그룹"} / 좌석을 눌러 변경`, [
      seatGrid(g.members, (m) => { s.seats = g.members; s.swapped = null; s.moved = null; s.note = null; s.picked = m?.profileId ?? null; go("seat"); }),
      free.length > 0 && h("p", { className: "meta" }, `자리 없음: ${free.map((m) => m.name).join(", ")}`),
      h("p", { className: "group-ready" }, readiness(g.members)),
    ], [
      button("새 동승 그룹", () => { s.draft.guestName = ""; go("guest"); }, "group-ghost"), // 시안 P43
      ride(g, g.kind === "guest" ? "이 그룹과 출발" : "이 가족과 출발"),
    ], true);
  }
  // 그룹으로 여행 만들기: 자리 있는 구성원만 탄다(docs/api/groups.md).
  const ride = (g, label) => button(label, () => act(async () => {
    const trip = await call("POST", "/trips", { groupId: g.id, title: g.name });
    const me = trip.participants.find((p) => p.profileId === getProfile()?.id);
    close();
    onTrip(trip.code, me?.id, me && trip.tokens[me.id]);
  }), "primary", s.busy);

  // 그룹 얼굴('Group / 2x2 profile / Phone' 2094:4300): 둘 이상이면 2x2(앞 네 사람, 남는 칸은 초대 중·미등록 점선), 혼자면 큰 캐릭터.
  const avatar = (g) => (g.members.length < 2 ? h("span", { className: "group-face big", "aria-hidden": "true" }, characterImage(characterKey(g.members[0]?.character))) : groupFaces(g));

  const detail = (id) => { s.groupId = id; go("detail"); };

  // 내 동승 그룹(P16L): 가족이 먼저. 카드를 누르면 그 그룹(P16A, 혼자인 동승 그룹은 P16G).
  function groupsView() {
    const list = [...s.groups].sort((a, b) => (a.kind === "family" ? 0 : 1) - (b.kind === "family" ? 0 : 1));
    const fam = family();
    return page("내 동승 그룹", "함께 탈 그룹을 선택해 주세요.", [
      ...list.map((g) => h("button", { type: "button", className: `group-card row group-pick${g.members.length < 2 ? " solo" : ""}`, onclick: () => detail(g.id) }, avatar(g),
        h("div", {}, h("strong", {}, g.name), h("small", { className: "group-line" }, groupLine(g)), g.members.length > 1 && h("small", { className: "group-names" }, g.members.map((m) => m.name).join(", "))))),
      button("+ 새 그룹 만들기", () => { s.draft.guestName = ""; go("guest"); }, "group-ghost"),
    ], [fam ? button(`${fam.name} 보기`, () => detail(fam.id), "primary") : button("우리 가족 만들기", () => go("member"), "primary")], true);
  }

  // 그룹 상세(P16A). 혼자인 동승 그룹은 초대부터(P16G).
  function detailView() {
    const g = current();
    if (!g) return groupsView();
    if (g.kind === "guest" && g.members.length === 1) {
      const owner = g.members[0];
      return page(g.name, "초대 코드, QR 또는 링크로 함께할 사람을 초대해 주세요.", [
        h("div", { className: "group-card row group-solo" }, avatar(g), h("div", {}, h("strong", {}, g.name), h("p", { className: "group-line" }, `${owner.name}  |  ${SEAT[owner.seat] ?? "자리 없음"}`))),
        button("동승자 초대하기", () => act(() => invite(g.id)), "primary", s.busy),
      ], [button("전체 그룹 보기", () => go("groups"), "group-ghost")], true);
    }
    return page(g.name, `오늘 함께 탈 ${g.kind === "family" ? "가족" : "사람"}과 좌석을 확인해 주세요.`, [
      h("div", { className: "group-card row group-head" }, avatar(g), h("div", {}, h("strong", {}, g.name), h("small", { className: "group-line" }, groupLine(g)))),
      h("div", { className: "group-card group-rows", "aria-label": "구성원과 저장된 좌석" }, ...seatRows(g.members).map(([seat, name]) => h("p", {}, h("span", {}, seat), h("span", {}, name)))),
      h("div", { className: "group-pair" }, button("좌석 배정", () => { s.seats = g.members; s.note = null; go("assign"); }, "group-ghost"), button("구성원 초대", () => act(() => invite(g.id)), "group-ghost", s.busy)),
    ], [button("전체 그룹", () => go("groups"), "group-ghost"), ride(g, "이 그룹과 출발")], true);
  }

  // 좌석 배정(P16B): 좌석을 누르면 누가 앉을지 고른다(P16C). 저장 전까지는 이 화면 안의 배치만 바뀐다.
  function assignView() {
    const g = current();
    const before = (m) => g.members.find((x) => x.profileId === m.profileId)?.seat ?? null;
    const changed = s.seats.filter((m) => (m.seat ?? null) !== before(m));
    return page("좌석 배정", "좌석을 누르고 앉을 사람을 선택해 주세요.", [
      seatGrid(s.seats, (m, seat) => { s.seatTarget = seat; s.note = null; go("picker"); }, null, s.seats.some((m) => !m.seat), "group-assign"),
      h("p", { className: "meta group-hint" }, "이미 앉은 사람을 선택하면 두 사람의 자리가 바뀌어요."),
    ], [button("그룹으로", () => go("detail"), "group-ghost"), button("이 배치로 저장", () => act(async () => {
      const saved = await call("PUT", `/groups/${g.id}/seats`, { seats: Object.fromEntries(changed.map((m) => [m.profileId, m.seat ?? null])) });
      s.groups = s.groups.map((x) => (x.id === saved.id ? saved : x));
      go("detail");
      note("새 좌석을 저장했어요.");
    }), "primary", s.busy || !changed.length)], true);
  }
  // 누가 앉나요?(P16C): 좌석 지도와 같은 규칙(seatPick) — 빈자리면 앉히고, 앉은 사람끼리는 맞바꾸고,
  // 자리 없는 사람은 앉은 사람의 자리에 넣지 않는다(앉아 있던 사람이 자리를 잃으면 그 사람 없이 출발하게 됨).
  function pickerView() {
    const g = current();
    const seat = s.seatTarget;
    const there = s.seats.find((m) => m.seat === seat)?.profileId;
    const pick = (m) => {
      const r = seatPick(s.seats, m.profileId, { seat, member: there });
      if (r.note) { s.note = r.note; return paint(); }
      if (r.members) s.seats = r.members;
      go("assign");
    };
    return page("누가 앉나요?", s.note ?? `선택한 좌석에 앉을 ${g.kind === "family" ? "가족" : "사람"}을 골라 주세요.`, [
      h("div", { className: "group-card group-target" }, h("small", {}, "선택한 좌석"), h("strong", {}, SEAT[seat])),
      ...s.seats.map((m) => h("button", { type: "button", className: `group-card row group-member${m.profileId === there ? " picked" : ""}`, onclick: () => pick(m) }, face(m), h("strong", {}, m.name))),
    ], [button("좌석 배정으로", () => go("assign"), "group-ghost")], true);
  }
  function seatView() {
    const g = current();
    // 사람 → 빈자리는 앉히고, 앉은 사람 → 앉은 사람은 맞바꾼다. '자리 없음' 줄을 누르면 고르기만 한다(seatPick).
    const pick = (m, seat) => {
      const before = s.picked;
      const r = seatPick(s.seats, s.picked, { member: m?.profileId, seat });
      s.note = r.note ?? null;
      if (r.members) {
        const name = (id) => s.seats.find((x) => x.profileId === id)?.name;
        s.swapped = m ? [name(before), m.name] : null;
        s.moved = m ? null : name(before);
        s.seats = r.members;
      }
      s.picked = r.picked;
      paint();
    };
    const changed = s.seats.some((m) => (m.seat ?? null) !== (g.members.find((x) => x.profileId === m.profileId)?.seat ?? null));
    const lost = lostSeats(g.members, s.seats);
    const free = s.seats.filter((m) => !m.seat);
    const rear = s.swapped && s.seats.filter((x) => s.swapped.includes(x.name)).every((x) => x.seat?.startsWith("ROW_2"));
    const sub = lost.length ? `${lost.map((m) => m.name).join(", ")}의 자리가 없어져요. 빈자리에 다시 앉혀 주세요.` : s.note ?? (s.swapped ? `${and(s.swapped[0])} ${s.swapped[1]}의 ${rear ? "뒷자리" : "자리"} 위치를 바꿨어요.` : s.moved ? `${s.moved}의 자리를 정했어요.` : s.picked ? "빈자리나 바꿀 사람을 눌러 주세요." : "사람을 누른 뒤 빈자리나 다른 사람을 눌러 주세요.");
    return page("가족 좌석 바꾸기", sub, [seatGrid(s.seats, pick, s.picked),
      free.length > 0 && h("p", { className: "meta" }, "자리 없음: 눌러서 고른 뒤 빈자리를 눌러요"),
      free.length > 0 && h("div", { className: "group-pair" }, free.map((m) => button(m.name, () => pick(m), `group-ghost${m.profileId === s.picked ? " picked" : ""}`))),
    ], [button("이 배치로 저장", () => act(async () => {
      const seats = Object.fromEntries(s.seats.filter((m) => m.seat !== g.members.find((x) => x.profileId === m.profileId)?.seat).map((m) => [m.profileId, m.seat]));
      const saved = await call("PUT", `/groups/${g.id}/seats`, { seats });
      s.groups = s.groups.map((x) => (x.id === saved.id ? saved : x));
      go("group");
      note("새 좌석을 저장했어요."); // 시안 P43은 저장 뒤에도 같은 부제라 알림으로
    }), "primary", s.busy || !changed || lost.length > 0)], true);
  }

  function guestView() {
    const me = getProfile();
    const input = h("input", { className: "group-input", value: s.draft.guestName ?? "", placeholder: "주말 바다 친구들", maxLength: 20, "aria-label": "그룹 이름", oninput: (e) => { s.draft.guestName = e.target.value; } });
    const make = async () => {
      const created = await call("POST", "/groups", { name: (s.draft.guestName ?? "").trim() || "동승 그룹", kind: "guest" });
      // 시안 P15·P16G '민준 | 운전석': 동승 그룹은 자리 없이 시작하므로 만든 사람을 운전석에 앉힌다(차의 C15와 같음).
      const made = await call("PUT", `/groups/${created.id}/seats`, { seats: { [me.id]: "ROW_1_LEFT" } });
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
    ], [button("그룹 저장", () => act(async () => { await make(); go("detail"); }), "primary", s.busy)], true);
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
    const view = { member: memberView, invite: inviteView, child: childView, childVoice: childVoiceView, group: groupView, seat: seatView, guest: guestView, groups: groupsView, detail: detailView, assign: assignView, picker: pickerView, join: joinView, joined: joinedView }[s.view]();
    const kept = [...s.dialog.querySelectorAll(":scope > .group-share, :scope > .group-toast")]; // 공유 시트와 알림은 다시 그려도 남긴다
    s.dialog.replaceChildren(h("div", { className: "group-content" }, view.flat().filter(Boolean)), ...kept);
  }

  return {
    // 가족을 연다: 모두 자리가 정해진 가족이면 내 동승 그룹(2005:5255 'P16 / groups', 옛 P13 자리), 아직 모으는 중이면 가족 추가(P09·P39·P40).
    async open() {
      if (!getToken()) return onProfile();
      begin("member");
      await act(async () => {
        await load();
        const members = family()?.members ?? [];
        s.view = members.length > 1 && members.every((m) => m.seat) ? "groups" : "member";
      });
    },
    // 프로필 드롭다운(C17m)에서 바로 여는 곳: 전체 그룹(P16L) 또는 지금 그룹(가족이 먼저)의 좌석 배정(P16B).
    async openAt(view) {
      if (!getToken()) return onProfile();
      begin("groups");
      await act(async () => {
        await load();
        const g = family() ?? s.groups[0];
        if (view === "assign" && g) Object.assign(s, { groupId: g.id, seats: g.members, note: null, view: "assign" });
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
    // 이 탭에 남아 있는 초대 코드(없으면 null). 온보딩이 끝나기 전에는 참여를 미룬다(app.js).
    pending: () => sessionStorage.getItem(PENDING),
    resume() {
      const code = sessionStorage.getItem(PENDING);
      if (code && !s && getToken() && getProfile()) this.join(code);
    },
    close,
    isOpen: () => Boolean(s),
  };
}
