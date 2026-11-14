import test from 'node:test';
import assert from 'node:assert/strict';
import { joinedTrip, verifyJoinedTrip } from './demo/continue-trip.js';

const candidate = { code: 'JOIN12', id: 'joined-person', token: 'participant-only-token' };
const makeTrip = (consent = true, status = 'boarding') => ({ code: candidate.code, status, participants: [{ id: candidate.id, name: '동승자', seat: 'ROW_1_RIGHT', consent }] });
const deferred = () => { let resolve; const promise = new Promise((r) => resolve = r); return { promise, resolve }; };
function fixture(consent = true, status = 'boarding') {
  const trip = makeTrip(consent, status), calls = [];
  let current = candidate;
  return {
    trip, calls, change: (value) => { current = value; },
    options: { current: () => current, request: async (...args) => { calls.push(args); return args[1].endsWith('/me') ? trip.participants[0] : trip; } },
  };
}

test('완성된 canonical 참여 연결만 읽고 프로필 토큰이나 저장소를 변경하지 않는다', () => {
  const map = new Map([['gachita:trip', 'JOIN12'], ['gachita:JOIN12', candidate.id], ['gachita:JOIN12:token', candidate.token], ['gachita:profile', 'profile-token']]);
  const storage = { getItem: (key) => map.get(key), setItem: () => assert.fail('identity write'), removeItem: () => assert.fail('identity removal') };
  assert.deepEqual(joinedTrip(storage), candidate);
  map.delete('gachita:JOIN12:token'); assert.equal(joinedTrip(storage), null);
  map.set('gachita:trip', '../other'); assert.equal(joinedTrip(storage), null);
  assert.equal(joinedTrip({ getItem: () => { throw new Error('unavailable'); } }), null);
});
for (const [consent, status] of [[true, 'boarding'], [false, 'boarding'], [false, 'ended']]) {
  test(`동의 ${consent}·${status} 여행도 실제 참가자 검증 후 demo 연결만 반환한다`, async () => {
    const f = fixture(consent, status), result = await verifyJoinedTrip(candidate, f.options);
    assert.deepEqual(result.car, candidate); assert.equal(result.trip, f.trip);
    assert.deepEqual(f.calls.map(([method, path, body, token]) => ({ method, path, body, token })), [
      { method: 'GET', path: '/trips/JOIN12/me', body: null, token: candidate.token },
      { method: 'GET', path: '/trips/JOIN12', body: null, token: candidate.token },
    ]);
    assert.equal(result.trip.participants[0].consent, consent);
  });
}
test('유효한 토큰이어도 저장된 참가자와 주체가 다르면 연결하지 않는다', async () => {
  const f = fixture(); f.trip.participants[0].id = 'someone-else';
  await assert.rejects(verifyJoinedTrip(candidate, f.options), /현재 연결이 달라요/); assert.equal(f.calls.length, 1);
});
test('인증 뒤 참가자가 사라지거나 다른 여행 문서를 받으면 연결하지 않는다', async () => {
  for (const trip of [{ code: 'OTHER1', participants: [makeTrip().participants[0]] }, { code: 'JOIN12', participants: [] }]) {
    await assert.rejects(verifyJoinedTrip(candidate, { current: () => candidate, request: async (_method, path) => path.endsWith('/me') ? makeTrip().participants[0] : trip }), /참가자를 찾을 수 없어요/);
  }
});
for (const status of [401, 403, 404]) test(`${status} 응답은 연결 성공 대신 재연결 안내로 전달한다`, async () => {
  await assert.rejects(verifyJoinedTrip(candidate, { current: () => candidate, request: async () => { throw Object.assign(new Error('server detail'), { status }); } }), status === 404 ? /여행을 찾을 수 없어요/ : /참여 연결이 만료/);
});
test('인증 대기 중 참여 연결·프로필 문맥이 바뀌면 늦은 결과로 선택하지 않는다', async () => {
  for (const changeProfile of [false, true]) {
    const wait = deferred(), f = fixture(); let valid = true, calls = 0;
    const pending = verifyJoinedTrip(candidate, { ...f.options, valid: () => valid, request: async () => { calls++; return wait.promise; } });
    if (changeProfile) valid = false; else f.change({ ...candidate, token: 'new-participant-token' });
    wait.resolve(makeTrip().participants[0]); await assert.rejects(pending, /다시 선택/); assert.equal(calls, 1);
  }
});
test('여행 조회 중 취소하면 demo 세션으로 쓸 결과를 반환하지 않는다', async () => {
  const wait = deferred(), controller = new AbortController();
  const pending = verifyJoinedTrip(candidate, { current: () => candidate, signal: controller.signal, request: async (_method, path) => path.endsWith('/me') ? makeTrip().participants[0] : wait.promise });
  await new Promise(setImmediate); controller.abort(); wait.resolve(makeTrip());
  await assert.rejects(pending, { name: 'AbortError' });
});
