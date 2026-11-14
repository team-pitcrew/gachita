import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 실제 studio/model/API 코드를 실행하며 DOM·시계·파일 전송만 제어합니다.
const dataModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const library = dataModule(`export * from ${JSON.stringify(new URL('./short-library.js', import.meta.url).href)};
export const readShortLibrary = async () => [];
export const shortPoster = async () => null;`);
const source = (await readFile(new URL('./short-studio.js', import.meta.url), 'utf8'))
  .replaceAll('"/shared.js"', JSON.stringify(new URL('./shared.js', import.meta.url).href))
  .replaceAll('"/short-generation.js"', JSON.stringify(new URL('./short-generation.js', import.meta.url).href))
  .replaceAll('"/short-film.js"', JSON.stringify(new URL('./short-film.js', import.meta.url).href))
  .replaceAll('"/short-library.js"', JSON.stringify(library));
const { createShortStudio } = await import(dataModule(source + '\n//# sourceURL=short-studio-under-test.js'));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.classList = { add() {}, toggle() {} }; }
  append(...children) { this.children.push(...children); for (const child of children) if (child instanceof Element) child.parent = this; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this[key]; delete this.attrs[key]; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : String(child)).join(''); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  showModal() {} close() {} focus() {} pause() {} load() {} play() { return Promise.resolve(); }
}
function all(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...element.children.filter((child) => child instanceof Element).flatMap((child) => all(child, predicate))];
}
function fixture(t) {
  let interval, listHandler, fileCalls = 0, listCalls = 0;
  const body = new Element('body'), file = defer();
  const trip = { code: 'TEST12', generation: 1, title: '여행', status: 'parked', moments: [], participants: [{ id: 'p', consent: true }] };
  const job = { id: 'j', origin: 'local-render', state: 'completed', result: { url: '/api/trips/TEST12/short-assets/j/file', seconds: 30 } };
  let items = [job], generation = 1;
  const originals = new Map();
  const set = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); };
  set('document', { body, activeElement: null, hidden: false, createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) });
  set('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  set('setInterval', (callback) => { interval = callback; return 1; }); set('clearInterval', () => {});
  set('fetch', async (url, options) => {
    if (url.endsWith('/file')) { fileCalls++; assert.equal(options.headers.authorization, 'Bearer test'); return (await file.promise).clone(); }
    if (url === '/api/short-templates') return Response.json({ enabled: false });
    assert.equal(url, '/api/trips/TEST12/short-assets'); listCalls++;
    return listHandler ? listHandler(options) : Response.json({ generation, items });
  });
  const studio = createShortStudio({ getTrip: () => trip, getParticipant: () => trip.participants[0], getToken: () => 'test', getOwner: () => 'owner' });
  t.after(() => { studio.close(); for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return {
    studio, trip, body, poll: () => interval(), fileCalls: () => fileCalls, listCalls: () => listCalls,
    list: (fn) => { listHandler = fn; }, items: (value) => { items = value; }, generation: (value) => { generation = value; },
    finishFile: () => file.resolve(new Response(new Blob(['synthetic-video'], { type: 'video/mp4' }), { headers: { 'content-type': 'video/mp4' } })),
    video: () => all(body, (element) => element.tagName === 'video').length,
    clickTile: () => all(body, (element) => element.className === 'reel-tile')[0].onclick(),
    click: (text) => { const button = all(body, (element) => element.tagName === 'button' && element.textContent === text)[0]; assert.ok(button, `button ${text}`); return button.onclick(); },
  };
}

test('느린 파일 수신 중 5초 폴링을 건너뛰고 수신 후 목록 검증을 통과해야 재생한다', async (t) => {
  const f = fixture(t); await f.studio.open();
  assert.equal(f.fileCalls(), 1); assert.equal(f.video(), 0);
  f.list(() => { throw new Error('poll timeout'); });
  const before = f.listCalls(); await f.poll(); await f.poll();
  assert.equal(f.listCalls(), before, '파일 수신 중 폴링 요청을 시작하지 않습니다');
  assert.match(f.body.textContent, /쇼츠를 불러오고 있어요/);
  f.list(null); f.finishFile(); await tick();
  assert.equal(f.listCalls(), before + 1, '파일 수신 뒤 권한·완료 상태를 조회합니다');
  assert.equal(f.video(), 1);
});

test('선택 전에 시작한 폴링의 늦은 실패는 새 다운로드를 폐기하지 않는다', async (t) => {
  const f = fixture(t); await f.studio.open({ view: 'library' });
  const pending = defer(); f.list(() => pending.promise); const polling = f.poll();
  f.clickTile();
  assert.equal(f.fileCalls(), 1);
  pending.reject(new Error('old poll timeout')); await polling;
  assert.match(f.body.textContent, /쇼츠를 불러오고 있어요/);
  f.list(null); f.finishFile(); await tick(); assert.equal(f.video(), 1);
});

test('일시 폴링 실패 뒤 조회 복구는 오류를 지우고 명시적 다시 시도로 파일을 받는다', async (t) => {
  const f = fixture(t); await f.studio.open(); f.finishFile(); await tick(); assert.equal(f.video(), 1);
  f.list(() => { throw new Error('offline'); }); await f.poll();
  assert.equal(f.video(), 0); assert.match(f.body.textContent, /연결을 확인/);
  f.list(null); await f.poll();
  assert.doesNotMatch(f.body.textContent, /연결을 확인/);
  assert.equal(f.fileCalls(), 1, '폴링 복구만으로 큰 파일을 자동 재전송하지 않습니다');
  await f.click('다시 시도'); assert.equal(f.fileCalls(), 2); assert.equal(f.video(), 1);
});

for (const reason of ['consent', 'generation', 'trip', 'driving']) test(`파일 수신 중 ${reason} 변경은 sync에서 차단한다`, async (t) => {
  const f = fixture(t); await f.studio.open();
  if (reason === 'consent') f.trip.participants[0].consent = false;
  if (reason === 'generation') f.trip.generation++;
  if (reason === 'trip') f.trip.code = 'OTHER1';
  if (reason === 'driving') f.trip.status = 'driving';
  f.studio.sync(); f.finishFile(); await tick();
  assert.equal(f.video(), 0); assert.doesNotMatch(f.body.textContent, /쇼츠를 불러오고 있어요/);
});

for (const reason of ['deleted', 'generation', 'forbidden']) test(`파일 수신 후 ${reason} 응답이면 영상을 표시하지 않는다`, async (t) => {
  const f = fixture(t); await f.studio.open();
  if (reason === 'deleted') f.items([]);
  if (reason === 'generation') f.generation(2);
  if (reason === 'forbidden') f.list(() => Response.json({ error: '동의가 필요합니다' }, { status: 403 }));
  f.finishFile(); await tick(); assert.equal(f.video(), 0);
});

test('파일을 다 받아도 마지막 검증 응답을 기다리는 동안 영상은 표시하지 않는다', async (t) => {
  const f = fixture(t); await f.studio.open();
  const pending = defer(); f.list(() => pending.promise); f.finishFile(); await tick();
  assert.equal(f.video(), 0);
  pending.resolve(Response.json({ error: '권한을 확인해 주세요' }, { status: 401 }));
  await tick(); assert.equal(f.video(), 0); assert.match(f.body.textContent, /권한을 확인/);
});
