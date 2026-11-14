import { api, h } from './shared.js';
import qrcode from './qrcode.js';
import { remainingTime } from './boarding.js';

export function boardingUrl(relative, origin) {
  const url = new URL(relative, origin);
  if (url.origin !== origin || url.pathname !== '/' || !/^[A-Za-z0-9_-]{20,120}$/.test(url.searchParams.get('join') || '')) throw new Error('참석 QR 주소를 확인하지 못했어요.');
  return url.href;
}
export function qrSvg(text) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), d = [];
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (qr.isDark(row, col)) d.push(`M${col + 4} ${row + 4}h1v1h-1z`);
  const el = (tag, attrs) => Object.entries(attrs).reduce((node, [key, value]) => (node.setAttribute(key, value), node), document.createElementNS('http://www.w3.org/2000/svg', tag));
  const svg = el('svg', { viewBox: `0 0 ${n + 8} ${n + 8}`, class: 'vehicle-boarding-qr', role: 'img', 'aria-label': '휴대폰 카메라로 스캔할 참석 QR', 'shape-rendering': 'crispEdges', 'data-payload': text });
  svg.append(el('rect', { width: n + 8, height: n + 8, fill: '#fff' }), el('path', { d: d.join(''), fill: '#000' })); return svg;
}
const button = (label, onclick, disabled = false) => h('button', { type: 'button', onclick, disabled }, label);
export function createVehicleBoarding({ getTrip, getToken, getOrigin = () => location.origin, onNotice = () => {} }) {
  let state;
  const pending = new Map();
  async function revoke(s, invite = s.invite) {
    if (!invite) return;
    const item = pending.get(invite.id) || { code: s.code, token: s.token, invite, next: 0 };
    pending.set(invite.id, item);
    if (item.busy || Date.now() < item.next) return;
    item.busy = true;
    try { await api('DELETE', `/trips/${item.code}/boarding-invites/${invite.id}`, null, item.token, AbortSignal.timeout(10000)); pending.delete(invite.id); }
    catch (error) {
      if (error.status === 404 || invite.expiresAt <= Date.now()) pending.delete(invite.id);
      else { item.next = Date.now() + 10000; if (!item.notified) { item.notified = true; onNotice('QR 화면을 닫았지만 서버 폐기를 확인하지 못했어요. 연결되면 다시 닫고, 기존 QR은 만료 시각까지만 유효해요.'); } }
    } finally { item.busy = false; }
  }
  const allowed = (s) => state === s && getTrip()?.code === s.code && ['boarding', 'parked'].includes(getTrip()?.status) && getToken() === s.token;
  function hide(s) { clearInterval(s.timer); s.controller.abort(); s.dialog.close(); s.dialog.remove(); if (state === s) state = null; s.focus?.focus(); }
  async function request(s, method, path, body) {
    const controller = new AbortController(), abort = () => controller.abort();
    s.controller.signal.addEventListener('abort', abort, { once: true }); const timeout = setTimeout(abort, 10000);
    try { return await api(method, `/trips/${s.code}/boarding-invites${path}`, body, s.token, controller.signal); }
    finally { clearTimeout(timeout); s.controller.signal.removeEventListener('abort', abort); }
  }
  async function close() {
    const s = state; if (!s || s.busy) return;
    s.busy = true; s.visible = false; paint(s);
    try { if (s.invite) await request(s, 'DELETE', `/${s.invite.id}`); hide(s); }
    catch (e) { s.error = 'QR을 서버에서 닫지 못했어요. 연결을 확인하고 다시 닫아 주세요.'; s.busy = false; paint(s); }
  }
  async function generate(s) {
    if (!allowed(s) || s.busy) return;
    s.busy = true; s.visible = false; s.error = ''; paint(s);
    try {
      const invite = await request(s, 'POST', '', {});
      if (!allowed(s)) { revoke(s, invite); return; }
      const url = boardingUrl(invite.url, getOrigin());
      s.invite = invite; s.qr = qrSvg(url); s.visible = true;
    } catch (e) { if (state === s) s.error = e.message; }
    finally { s.busy = false; if (state === s) paint(s); }
  }
  function paint(s) {
    if (state !== s) return;
    const ready = s.visible && s.invite?.expiresAt > Date.now();
    s.countdown = h('p', { className: 'vehicle-boarding-countdown' }, ready ? `${remainingTime(s.invite.expiresAt)} 뒤 만료` : s.invite && !s.busy ? 'QR을 다시 열어 주세요' : '');
    s.people = h('p', { className: 'vehicle-boarding-people', role: 'status' }, `함께 탄 사람 ${getTrip()?.participants.length || 0}명`);
    s.dialog.replaceChildren(
      h('header', {}, h('strong', {}, '가치타 · 참석 QR'), button(s.busy ? '처리 중' : '닫기', close, s.busy)),
      h('section', { className: 'vehicle-boarding-content' }, h('p', { className: 'vehicle-boarding-trip' }, getTrip()?.title || '함께 탈 여행'),
        h('h1', {}, '휴대폰 카메라로', h('br'), '이 QR을 스캔해 주세요'),
        h('div', { className: 'vehicle-boarding-code' }, ready ? s.qr : h('p', { role: 'status' }, s.busy ? '참석 QR을 준비하고 있어요' : '스캔할 QR이 없어요')),
        s.countdown, h('p', {}, '휴대폰에서 내 프로필과 자리를 고르면 함께 탈 수 있어요.'), h('p', { className: 'vehicle-boarding-note' }, '기록 동의는 각자의 휴대폰에서 따로 정합니다.'),
        s.people, button('QR 새로 만들기', () => generate(s), s.busy)),
      s.error && h('p', { className: 'vehicle-boarding-error', role: 'alert' }, s.error),
    );
  }
  function sync() {
    for (const item of pending.values()) revoke(item, item.invite);
    const s = state; if (!s) return;
    if (!allowed(s)) {
      revoke(s);
      hide(s); return;
    }
    if (s.visible && s.invite?.expiresAt <= Date.now()) { s.visible = false; paint(s); }
    else if (s.visible && s.countdown) s.countdown.textContent = `${remainingTime(s.invite.expiresAt)} 뒤 만료`;
    if (s.people) s.people.textContent = `함께 탄 사람 ${getTrip().participants.length}명`;
  }
  async function open() {
    if (state) return;
    const trip = getTrip(); if (!trip || !['boarding', 'parked'].includes(trip.status) || !getToken()) return;
    const s = state = { code: trip.code, token: getToken(), focus: document.activeElement, controller: new AbortController(), busy: false, visible: false, error: '' };
    s.dialog = h('dialog', { className: 'vehicle-boarding-dialog', 'aria-label': '차량 전체 화면 참석 QR', oncancel: (e) => { e.preventDefault(); close(); } });
    document.body.append(s.dialog); s.dialog.showModal(); paint(s); s.timer = setInterval(sync, 1000); await generate(s);
  }
  return { open, close, sync };
}
