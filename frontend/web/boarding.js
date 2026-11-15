import { api, h, SEAT } from './shared.js';
import { appBar, meEnd } from './ride.js';
import { characterImage } from './short-film.js';

const button = (label, onclick, className = '', disabled = false) => h('button', { type: 'button', onclick, className, disabled }, label);
export const remainingTime = (expiresAt, now = Date.now()) => {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
export function boardingToken(url, origin) {
  try { const target = new URL(url, origin); const token = target.searchParams.get('join'); return target.origin === origin && target.pathname === '/' && /^[A-Za-z0-9_-]{20,120}$/.test(token || '') ? token : null; }
  catch { return null; }
}

// 차가 표시한 초대 URL을 폰에서 연다. 참가자 토큰은 QR이 아니라 참가 응답으로 이 폰에만 전달된다.
// 받침에 맞춘 '와/과'(한글이 아니면 '와').
const withJosa = (word) => { const c = word.charCodeAt(word.length - 1) - 0xac00; return `${word}${c >= 0 && c < 11172 && c % 28 ? '과' : '와'}`; };

export function createBoarding({ getProfile, getToken, consentText, consentOffMessage, onLinked, onDecision, onLeave, onProfile }) {
  let state;
  const PENDING = 'gachita:boarding-pending';
  const savedJoin = () => { try { const saved = JSON.parse(sessionStorage.getItem(PENDING) || 'null'); return saved?.profileId === getProfile()?.id ? saved : null; } catch { return null; } };
  const rememberJoin = (s) => sessionStorage.setItem(PENDING, JSON.stringify({ invite: s.invite, profileId: s.profileId, seat: s.seat }));
  const currentInvite = () => boardingToken(location.href, location.origin);
  const forgetInvite = () => { const url = new URL(location.href); url.searchParams.delete('join'); history.replaceState(null, '', url); };
  const valid = (s) => state === s && getProfile()?.id === s.profileId && getToken() === s.profileToken;
  const stopCamera = (s) => { clearTimeout(s.cameraTimer); s.stream?.getTracks().forEach((track) => track.stop()); s.stream = null; };
  function close(clear = false) {
    const s = state; if (!s) return;
    state = null; stopCamera(s); clearInterval(s.timer); s.controller.abort(); s.dialog.close(); s.dialog.remove(); s.focus?.focus();
    if (clear) forgetInvite();
  }
  const sync = (latest) => {
    if (state && !valid(state)) return close();
    const s = state;
    if (!s?.joined || latest?.code !== s.joined.code) return;
    const person = latest.participants.find((p) => p.id === s.joined.participant.id && p.profileId === s.profileId);
    if (!person) return close();
    const changed = person.consent !== s.joined.participant.consent || person.seat !== s.joined.participant.seat;
    s.trip = latest; s.joined.participant = person;
    if (changed && !s.busy) { s.phase = person.consent ? 'complete' : 'consent'; paint(s); }
  };
  async function request(s, method, path, body, token = s.profileToken) {
    if (!valid(s)) throw new Error('프로필이 바뀌었어요. 다시 확인해 주세요.');
    const controller = new AbortController(), abort = () => controller.abort();
    s.controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10000);
    try {
      const result = await api(method, path, body, token, controller.signal);
      if (!valid(s)) throw new Error('연결 화면이 바뀌었어요.');
      return result;
    } finally { clearTimeout(timeout); s.controller.signal.removeEventListener('abort', abort); }
  }
  function begin() {
    close();
    const s = { profileId: getProfile()?.id, profileToken: getToken(), controller: new AbortController(), phase: 'scan', busy: false, error: '', focus: document.activeElement };
    // Esc·뒤로: 참여한 뒤에는 '닫기'·'여행으로 돌아가기'처럼 그 여행으로(전에는 처음 화면으로 갔다), 참여 전에는 닫기만.
    s.dialog = h('dialog', { className: 'boarding-dialog', 'aria-label': '차량 QR로 동승 참여', oncancel: (event) => { event.preventDefault(); if (!s.busy) { if (s.joined) finish(s); else close(true); } } });
    state = s; document.body.append(s.dialog); s.dialog.showModal(); return s;
  }
  async function preview(s) {
    if (!valid(s) || !s.invite || s.busy || s.checking || s.joined) return;
    s.checking = true;
    try {
      const result = await request(s, 'GET', `/boarding-invites/${encodeURIComponent(s.invite)}`, null, null);
      s.preview = result; s.error = ''; s.phase = 'seat';
      if (!s.recovering && !result.seats.includes(s.seat)) s.seat = null;
    } catch (e) {
      if (!valid(s)) return;
      s.error = e.status === 404 || e.status === 410 ? 'QR이 만료됐거나 차에서 닫혔어요. 차의 새 QR을 다시 스캔해 주세요.' : e.message;
      s.preview = null; s.phase = 'unavailable';
    } finally { s.checking = false; if (valid(s)) paint(s); }
  }
  async function join(s) {
    if (!valid(s) || s.busy || !s.seat || !s.preview || s.preview.expiresAt <= Date.now()) return;
    if (!getProfile() || !getToken()) { close(); onProfile?.(); return; }
    s.busy = true; s.error = ''; paint(s);
    try {
      // 응답을 받지 못하고 새로고침해도 같은 프로필·초대·자리로 멱등 재확인을 합니다.
      rememberJoin(s); s.recovering = true;
      const result = await request(s, 'POST', `/boarding-invites/${encodeURIComponent(s.invite)}/participants`, { seat: s.seat });
      const joined = { code: result.tripCode, participant: result.participant, token: result.token };
      onLinked(joined); s.joined = joined; sessionStorage.removeItem(PENDING); forgetInvite();
      await connection(s);
    } catch (e) {
      if (valid(s)) {
        if (e.status === 409) { s.recovering = false; sessionStorage.removeItem(PENDING); }
        s.error = e.status === 409 ? '그 자리에 다른 동승자가 먼저 참여했거나 여행 상태가 바뀌었어요. 빈자리를 다시 확인해 주세요.' : e.status === 410 ? 'QR이 만료됐어요. 차의 새 QR을 스캔하면 이미 참여한 자리를 다시 연결할 수 있어요.' : e.message;
        s.phase = s.joined ? 'connecting' : s.preview && s.preview.expiresAt > Date.now() ? 'seat' : 'unavailable';
      }
    } finally { s.busy = false; if (valid(s)) paint(s); }
  }
  async function connection(s) {
    s.phase = 'connecting'; paint(s);
    const trip = await request(s, 'GET', `/trips/${s.joined.code}`, null, s.joined.token);
    const me = trip.participants.find((p) => p.id === s.joined.participant.id && p.profileId === s.profileId);
    if (!me) throw new Error('참여한 자리를 확인하지 못했어요. 다시 확인해 주세요.');
    s.trip = trip; s.joined.participant = me; s.phase = me.consent ? 'complete' : 'consent';
  }
  async function retry(s) {
    if (!valid(s) || s.busy) return;
    if (!s.joined) return preview(s);
    s.busy = true; s.error = '';
    try { await connection(s); } catch (e) { if (valid(s)) s.error = e.message; }
    finally { s.busy = false; if (valid(s)) paint(s); }
  }
  function finish(s) { const joined = s.joined; close(true); if (joined) onLeave(joined); }
  async function decide(s, consent) {
    if (!valid(s) || s.busy || !s.joined || s.phase !== 'consent') return;
    if (!consent && s.joined.participant.consent && !confirm(consentOffMessage)) return;
    s.busy = true; s.error = ''; paint(s);
    try {
      await request(s, 'PATCH', `/trips/${s.joined.code}/participants/${s.joined.participant.id}`, { consent }, s.joined.token);
      await connection(s);
      if (s.joined.participant.consent !== consent) throw new Error('동의 상태가 바뀌었어요. 다시 확인해 주세요.');
      onDecision(s.joined); s.phase = 'complete';
    } catch (e) { if (valid(s)) { s.error = e.message; s.phase = 'connecting'; } }
    finally { s.busy = false; if (valid(s)) paint(s); }
  }
  async function scan(s) {
    if (!valid(s) || s.busy) return;
    if (!globalThis.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) { s.error = '휴대폰의 기본 카메라로 차 화면의 QR을 비추고 표시되는 링크를 눌러 주세요.'; paint(s); return; }
    s.busy = true; s.error = ''; paint(s);
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (!valid(s)) { stream.getTracks().forEach((track) => track.stop()); return; }
      s.stream = stream;
      s.video = h('video', { muted: true, autoplay: true, playsInline: true, className: 'boarding-camera', 'aria-label': '차량 QR을 비추는 카메라' });
      s.video.srcObject = stream; s.busy = false; paint(s); await s.video.play();
      const detect = async () => {
        if (!valid(s) || !s.stream) return;
        try {
          const results = await detector.detect(s.video);
          if (!valid(s) || s.stream !== stream) return;
          const token = results.map((result) => boardingToken(result.rawValue, location.origin)).find(Boolean);
          if (token) { stopCamera(s); s.invite = token; s.phase = 'loading'; const url = new URL(location.href); url.searchParams.set('join', token); history.replaceState(null, '', url); paint(s); await preview(s); return; }
        } catch { /* 프레임이 준비되지 않으면 다음 실제 프레임을 확인합니다. */ }
        if (valid(s) && s.stream) s.cameraTimer = setTimeout(detect, 200);
      };
      detect();
    } catch (e) { if (valid(s)) { stopCamera(s); s.error = e.name === 'NotAllowedError' ? '카메라 사용을 허용하거나 휴대폰의 기본 카메라로 차량 QR을 스캔해 주세요.' : '카메라를 열지 못했어요. 휴대폰의 기본 카메라로 차량 QR을 스캔해 주세요.'; } }
    finally { s.busy = false; if (valid(s)) paint(s); }
  }
  // 기록 동의(consent)와 참여 완료(complete)는 폰 시안의 같은 역할 프레임을 따른다: D補 phoneJoin('…에 초대받았어요' →
  // 카드 셋 → '동의하고 그룹 참여')과 phoneJoined('…에 참여했어요'). 그룹 여행이 시작돼 처음 화면이 연 여행(app.js openActive)도 여기로 온다.
  // 시안에는 단추가 하나지만 기록 동의는 거절할 수 있어야 해서 '기록 없이 함께 타기'를 함께 둔다(동의 문구 전문도 접어 둔다).
  function phonePaint(s) {
    const profile = getProfile(), me = s.joined.participant, trip = s.trip;
    const crew = trip.title || '함께 타는 여행';
    const driver = trip.participants.find((p) => p.seat === 'ROW_1_LEFT');
    // 시안 카드: 제목 19/28 Bold 아래 설명 15/22(groups.js joinView와 같은 틀). 얼굴이 있으면 옆에 둔다(phoneJoined).
    const card = (title, sub, extra = {}) => extra.face
      ? h('div', { className: 'group-card soft row' }, extra.face, h('div', {}, h('strong', {}, title), h('small', {}, sub)))
      : h('div', { className: 'group-card' }, h('strong', {}, title), h('small', {}, sub));
    const face = h('span', { className: 'group-face', 'aria-hidden': 'true' }, characterImage(profile.character));
    const consent = s.phase === 'consent';
    const view = consent ? [
      h('div', { className: 'ob-title' }, h('h1', {}, `${crew}${/여행$/.test(crew) ? '이' : ' 여행이'} 시작됐어요`), h('p', { className: 'sub' }, `${driver?.name ? `${driver.name}님의 차량` : '차량'} / ${SEAT[me.seat] ?? '자리 확인 중'}`)),
      card(`${withJosa(crew)} 함께 타요`, `${profile.name} / 등록된 캐릭터와 목소리 연결`),
      card('대화 기록과 콘텐츠 생성', '음성과 전사록 업로드, 요약과 편집에 사용'),
      card('내 목소리로 발화자 구분', '등록한 음성 특징으로 말하는 사람 구분'),
      h('p', { className: 'meta' }, '모두 동의한 동안만 기록해요. 실제 녹음은 차에서 따로 시작해요.'),
      h('details', { className: 'boarding-consent' }, h('summary', {}, '기록에 쓰는 정보와 보관·삭제 안내'), h('ul', {}, consentText.map((line) => h('li', {}, line)))),
      h('div', { className: 'group-actions' }, button('기록 없이 함께 타기', () => decide(s, false), 'group-ghost', s.busy), button(s.busy ? '확인 중' : '동의하고 기록 참여', () => decide(s, true), 'primary', s.busy)),
    ] : [
      h('div', { className: 'ob-title' }, h('h1', {}, `${crew}에 함께 타고 있어요`), h('p', { className: 'sub' }, '차량과 폰에서 같은 프로필을 사용해요.')),
      card(`${profile.name} / ${SEAT[me.seat] ?? '자리 확인 중'}`, me.consent ? '기록 동의 완료 / 모두 동의하면 차에서 기록해요' : '기록 없이 함께 타요 / 내 동의 설정에서 바꿀 수 있어요', { soft: true, face }),
      card('이제 함께 출발해요', '차량에서 내 캐릭터와 참여 상태를 확인해 주세요.'),
      h('div', { className: 'group-actions' }, button('내 동의 설정', () => { s.phase = 'consent'; paint(s); }, 'group-ghost'), button('여행으로 돌아가기', () => finish(s), 'primary')),
    ];
    s.dialog.className = 'groups-dialog boarding-phone';
    s.dialog.replaceChildren(h('div', { className: 'group-content' }, appBar({ online: navigator.onLine !== false, onHome: () => finish(s) }), ...view,
      s.error && h('p', { className: 'meta', role: 'alert' }, s.error)));
  }
  function paint(s) {
    if (!valid(s)) return;
    if (s.joined && s.trip && (s.phase === 'consent' || s.phase === 'complete')) return phonePaint(s);
    s.dialog.className = 'boarding-dialog';
    const profile = getProfile(), me = s.joined?.participant;
    const heading = h('header', { className: 'boarding-heading' }, button('닫기', () => s.joined ? finish(s) : close(true), 'plain', s.busy), h('strong', {}, s.joined ? '동승 연결' : '차량 QR로 참여'), meEnd());
    let body;
    if (s.phase === 'seat') {
      s.countdown = h('p', { className: 'boarding-countdown' }, `${remainingTime(s.preview.expiresAt)} 안에 참여해 주세요`);
      body = h('section', { className: 'boarding-content' }, h('h1', {}, s.preview.title || '함께 탈 여행'),
        profile ? h('div', { className: 'boarding-person' }, characterImage(profile.character), h('strong', {}, profile.name)) : h('p', {}, '차량 QR을 확인했어요. 내 프로필을 만든 뒤 자리를 골라 참여해 주세요.'),
        profile ? h('fieldset', { className: 'boarding-seats' }, h('legend', {}, '어느 자리에 앉았나요?'), s.preview.seats.map((seat) => h('label', { className: 'boarding-seat-option' }, h('input', { type: 'radio', name: 'boarding-seat', value: seat, checked: s.seat === seat, disabled: s.busy, onchange: () => { s.seat = seat; paint(s); } }), SEAT[seat]))) : null,
        !s.preview.seats.length && h('p', {}, '빈자리가 없어요. 차에서 동승자 설정을 확인해 주세요.'), s.countdown,
        profile ? button(s.busy ? '참여 중' : s.recovering ? '참여 결과 다시 확인' : '이 자리로 함께 타기', () => join(s), 'primary', s.busy || !s.seat) : button('내 프로필 만들기', () => { close(); onProfile?.(); }, 'primary'),
        profile && !s.preview.seats.length && !s.recovering && button('이미 참여한 자리 다시 연결', () => { s.seat = 'ROW_1_LEFT'; s.recovering = true; join(s); }, 'boarding-secondary', s.busy),
        h('p', { className: 'meta' }, '참여한 뒤 내 휴대폰에서 기록 동의를 따로 정해요.'));
    } else if (s.phase === 'scan') {
      body = h('section', { className: 'boarding-content' }, h('h1', {}, '차 화면의 QR을', h('br'), '휴대폰으로 스캔해요'),
        h('p', {}, '차에서 동승자 설정 → 참석 QR을 열어 주세요. 휴대폰의 기본 카메라로 QR을 비추고 나타나는 링크를 누르면 참여할 수 있어요.'),
        s.stream ? s.video : button('카메라로 QR 스캔', () => scan(s), 'primary', s.busy),
        s.stream && button('카메라 닫기', () => { stopCamera(s); paint(s); }, 'boarding-secondary'));
    } else body = h('section', { className: 'boarding-content' }, h('h1', {}, s.phase === 'unavailable' ? '참여할 QR을 확인해 주세요' : s.joined ? '내 자리를 확인하고 있어요' : '차량 QR을 확인하고 있어요'));
    s.dialog.replaceChildren(heading, body, ...[s.error && h('div', { className: 'boarding-error', role: 'alert' }, h('p', {}, s.error), s.invite && button('다시 확인', () => retry(s), 'boarding-secondary', s.busy))].filter(Boolean));
  }
  async function open(invite = currentInvite()) {
    if (state && valid(state)) return;
    const s = begin(); s.invite = invite; s.phase = invite ? 'loading' : 'scan';
    const pending = savedJoin(); if (pending?.invite === invite) { s.seat = pending.seat; s.recovering = true; }
    paint(s);
    if (invite) await preview(s);
    if (!valid(s)) return;
    s.timer = setInterval(() => {
      sync(); if (!valid(s)) return;
      if (s.joined && !s.busy && !s.checking && Date.now() - (s.polledAt || 0) >= 2000) {
        s.polledAt = Date.now(); s.checking = true;
        request(s, 'GET', `/trips/${s.joined.code}`, null, s.joined.token).then((trip) => sync(trip), () => {}).finally(() => { s.checking = false; });
      }
      if (document.hidden && s.stream) { stopCamera(s); paint(s); }
      if (!s.joined && s.preview && s.preview.expiresAt <= Date.now()) { s.preview = null; s.phase = 'unavailable'; s.error = 'QR이 만료됐어요. 차의 새 QR을 다시 스캔해 주세요.'; paint(s); }
      else if (s.countdown && s.preview) s.countdown.textContent = `${remainingTime(s.preview.expiresAt)} 안에 참여해 주세요`;
    }, 1000);
  }
  function openConsent(trip, participant, token) {
    if (!token || participant.profileId !== getProfile()?.id) return;
    if (state?.joined?.code === trip.code && valid(state)) {
      const s = state, changed = s.joined.participant.consent !== participant.consent || s.joined.participant.seat !== participant.seat;
      s.trip = trip; s.joined = { code: trip.code, participant, token };
      if (changed && !s.busy) { if (!participant.consent) s.phase = 'consent'; paint(s); }
      return;
    }
    const s = begin(); s.joined = { code: trip.code, participant, token }; s.trip = trip; s.phase = 'consent'; paint(s);
  }
  return { open, openConsent, close, sync, resume: () => currentInvite() && open(), pending: currentInvite };
}
