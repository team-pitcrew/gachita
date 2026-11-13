// 장면 후보와 숏폼 자막(T43, ADR-0020). LLM 없이 규칙으로 고른다(Claude API 계약 전).
// 입력은 기록본의 발화(asUtterance 모양, 시각 순, 글이 빈 줄 제외)와 여행의 장면(moments). DB도 네트워크도 모른다.

const WINDOW = 30_000; // 발화를 세는 창
const MIN_LINES = 4; // 이보다 적게 말한 창은 후보가 아니다
const MAX_ITEMS = 5;
const MAX_SPAN = 45_000; // 숏폼 15~45초
const overlaps = (a, b) => a.from < b.to && b.from < a.to;

// 사람이 이미 남긴 장면의 구간. 구간이 없으면 표시한 순간 앞 20초~뒤 10초로 본다(차가 자르는 기본 구간과 같게).
export const momentSpan = (m) => ({ from: m.from ?? m.at - 20_000, to: m.to ?? m.at + 10_000 });

// 각 발화에서 시작하는 30초 창의 발화 수와 말한 사람 수(화자 대조로 붙은 프로필, 없으면 좌석 구역)로 점수를 매기고,
// 이미 남긴 장면과 겹치지 않는 창을 점수 순으로 최대 5개 고른다(서로도 겹치지 않게). 돌려줄 때는 시각 순.
// ponytail: 밀도 규칙이라 '재미'를 직접 보지 않는다. LLM 계약이 생기면 이 창들을 후보로 넘겨 이유를 쓰게 한다.
export function suggest(lines, moments) {
  const taken = moments.map(momentSpan);
  const windows = [];
  for (let i = 0, j = 0; i < lines.length; i++) {
    j = Math.max(j, i);
    while (j < lines.length && lines[j].at < lines[i].at + WINDOW) j++;
    const w = lines.slice(i, j);
    if (w.length < MIN_LINES) continue;
    const speakers = new Set(w.map((u) => u.profileId ?? u.seatArea ?? "?")).size;
    const from = w[0].at - 1000;
    windows.push({ from, to: Math.min(w.at(-1).at + 4000, from + MAX_SPAN), n: w.length, speakers, score: w.length + 2 * (speakers - 1), w });
  }
  const picked = [];
  for (const c of windows.sort((a, b) => b.score - a.score || a.from - b.from)) {
    if (picked.length === MAX_ITEMS) break;
    if (!taken.some((t) => overlaps(c, t)) && !picked.some((p) => overlaps(c, p))) picked.push(c);
  }
  return picked
    .sort((a, b) => a.from - b.from)
    .map(({ from, to, n, speakers, score, w }) => {
      const here = w.find((u) => u.lat !== undefined);
      return {
        at: w[0].at,
        from,
        to,
        why: `${WINDOW / 1000}초에 말이 ${n}번${speakers > 1 ? `, ${speakers}명이 말함` : ""}`,
        score,
        lines: w,
        ...(here ? { lat: here.lat, lng: here.lng } : {}),
      };
    });
}

// 클립 구간(startAt부터 seconds초) 안의 발화를 자막 큐로. 시각은 클립 첫 표본에서 잰 초.
// 발화의 at을 말 시작으로 본다. 끝 시각은 서버에 없어서 글자 수로 어림하고(글자당 0.15초, 1~6초) 다음 발화·클립 끝에서 자른다.
// ponytail: 차가 발화 끝 시각을 올리면 그것으로 바꾼다.
export function cues(lines, startAt, seconds) {
  const end = startAt + seconds * 1000;
  const inside = lines.filter((u) => u.at >= startAt && u.at < end);
  const sec = (ms) => Math.round(ms) / 1000;
  return inside.map((u, i) => {
    const guess = u.at + Math.min(6000, Math.max(1000, [...u.text].length * 150));
    return { start: sec(u.at - startAt), end: sec(Math.min(guess, inside[i + 1]?.at ?? end, end) - startAt), text: u.text, profileId: u.profileId ?? null, seatArea: u.seatArea ?? null };
  });
}
