// 장면 후보와 숏폼 자막(T43, ADR-0021). LLM 없이 규칙으로 고른다(Claude API 계약 전).
// 입력은 기록본의 발화(asUtterance 모양, 시각 순, 글이 빈 줄 제외)와 여행의 장면(moments). DB도 네트워크도 모른다.

const WINDOW = 30_000; // 발화를 세는 창
const MIN_LINES = 4; // 이보다 적게 말한 창은 후보가 아니다
const MIN_SPAN = 15_000; // 숏폼 15초 이상. 창이 30초라 구간은 15~35초
const MAX_ITEMS = 5;
const MAX_LINES = 30; // 후보 하나에 보여 줄 발화
const overlaps = (a, b) => a.from < b.to && b.from < a.to;

// 사람이 이미 남긴 장면의 구간. 구간(from·to)이 없으면 표시한 순간 앞 20초~뒤 10초로 본다 —
// 차(T63)가 구간 없는 장면을 자르는 기본 구간도 이것이다(docs/api/voice.md).
export const momentSpan = (m) => ({ from: m.from ?? m.at - 20_000, to: m.to ?? m.at + 10_000 });

// 각 발화에서 시작하는 30초 창의 발화 수와 말한 사람 수로 점수를 매기고, 이미 남긴 장면과 겹치지 않는 창을
// 점수 순으로 최대 5개 고른다(서로도 겹치지 않게). 돌려줄 때는 시각 순. 말한 사람은 좌석 구역으로 세고
// (화자 대조가 일부만 붙어도 한 사람이 둘로 세지지 않게), 구역을 모르면 화자 대조로 붙은 프로필로, 둘 다 없으면 세지 않는다.
// 창을 복사하지 않고 두 손가락으로 훑는다 — 발화 2만 줄(여행 한도)이 한 순간에 몰려도 O(n log n).
// ponytail: 밀도 규칙이라 '재미'를 직접 보지 않는다. LLM 계약이 생기면 이 창들을 후보로 넘겨 이유를 쓰게 한다.
export function suggest(lines, moments) {
  const taken = moments.map(momentSpan);
  const said = new Map(); // 창 안에서 말한 사람 → 발화 수
  const count = (u, d) => {
    const who = u.seatArea ?? u.profileId;
    if (who == null) return;
    const n = (said.get(who) ?? 0) + d;
    if (n) said.set(who, n);
    else said.delete(who);
  };
  const windows = [];
  for (let i = 0, j = 0; i < lines.length; i++) {
    if (i > 0) count(lines[i - 1], -1);
    while (j < lines.length && lines[j].at < lines[i].at + WINDOW) count(lines[j++], 1);
    if (j - i < MIN_LINES) continue;
    const from = lines[i].at - 1000;
    windows.push({ i, j, from, to: Math.max(lines[j - 1].at + 4000, from + MIN_SPAN), speakers: said.size, score: j - i + 2 * (said.size - 1) }); // 명세 그대로: 말한 사람을 모르면(0명) 2점 깎인다
  }
  const picked = [];
  for (const c of windows.sort((a, b) => b.score - a.score || a.from - b.from)) {
    if (picked.length === MAX_ITEMS) break;
    if (!taken.some((t) => overlaps(c, t)) && !picked.some((p) => overlaps(c, p))) picked.push(c);
  }
  return picked
    .sort((a, b) => a.from - b.from)
    .map(({ i, j, from, to, speakers, score }) => {
      const w = lines.slice(i, j);
      const here = w.find((u) => u.lat !== undefined);
      return {
        at: lines[i].at,
        from,
        to,
        why: `${WINDOW / 1000}초에 말이 ${j - i}번${speakers > 1 ? `, ${speakers}명이 말함` : ""}`,
        score,
        lines: w.slice(0, MAX_LINES),
        ...(here ? { lat: here.lat, lng: here.lng } : {}),
      };
    });
}

// 시각 순 발화에서 at 이상인 첫 자리(이분 탐색).
const firstAt = (lines, at) => {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

// 클립 구간(startAt부터 seconds초) 안의 발화를 자막 큐로. 시각은 클립 첫 표본에서 잰 초.
// 발화의 at을 말 시작으로 본다. 끝 시각은 서버에 없어서 글자 수로 어림하고(글자당 0.15초, 1~6초) 다음 발화에서 자르되
// 1초는 남긴다 — 두 자리에서 같이 말하면 자막이 겹쳐 보이게(0초짜리 자막이 사라지지 않게). 클립 끝은 넘지 않는다.
// ponytail: 차가 발화 끝 시각을 올리면 그것으로 바꾼다.
export function cues(lines, startAt, seconds) {
  const end = startAt + seconds * 1000;
  const inside = [];
  for (let k = firstAt(lines, startAt); k < lines.length && lines[k].at < end; k++) inside.push(lines[k]);
  const sec = (ms) => Math.round(ms) / 1000;
  return inside.map((u, i) => {
    const guess = u.at + Math.min(6000, Math.max(1000, [...u.text].length * 150));
    const stop = Math.min(end, Math.max(u.at + 1000, Math.min(guess, inside[i + 1]?.at ?? end)));
    // text는 수동 수정→재전사→Pleos 원문. raw는 늘 Pleos 원문이며 편집 키·버전은 충돌 확인에 쓴다.
    return {
      start: sec(u.at - startAt), end: sec(stop - startAt), text: u.displayText ?? u.asrText ?? u.text, raw: u.text,
      device: u.device, seq: u.seq, editedText: u.editedText ?? null, editVersion: u.editVersion ?? 0,
      ...(u.asrText ? { asrText: u.asrText } : {}),
      ...(u.editedBy ? { editedBy: u.editedBy, editedAt: u.editedAt } : {}),
      participantId: u.participantId ?? null, profileId: u.profileId ?? null, seatArea: u.seatArea ?? null,
    };
  });
}
