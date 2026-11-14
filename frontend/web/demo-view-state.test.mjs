import test from 'node:test';
import assert from 'node:assert/strict';
import { editingText, serialRefresh } from './demo/view-state.js';

const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);

test('파일 선택·숨김·버튼 포커스는 완료 화면을 막지 않고 편집 중인 글과 숫자는 유지한다', () => {
  const container = { contains: (element) => element.inside };
  const element = { tagName: 'INPUT', inside: true, type: 'file' };
  assert.equal(editingText(element, container), false);
  for (const type of ['hidden', 'checkbox', 'radio', 'button', 'submit']) assert.equal(editingText({ ...element, type }, container), false);
  for (const type of ['text', 'number']) assert.equal(editingText({ ...element, type }, container), true);
  assert.equal(editingText({ ...element, tagName: 'TEXTAREA' }, container), true);
  for (const condition of [{ hidden: true }, { disabled: true }, { readOnly: true }, { inside: false }]) assert.equal(editingText({ ...element, type: 'text', ...condition }, container), false);
  assert.equal(editingText(null, container), false);
});

test('오래된 조회 중 전사가 끝나면 강제 조회를 합쳐 한 번 더 읽고 끝날 때까지 기다린다', async () => {
  const first = defer(), second = defer(), calls = [];
  let active = 0, maximum = 0;
  const refresh = serialRefresh(async (force) => {
    calls.push(force); maximum = Math.max(maximum, ++active);
    await (calls.length === 1 ? first.promise : second.promise); active--;
  });
  const polling = refresh(); await tick();
  const complete = refresh(true); refresh(true); refresh();
  assert.equal(complete, polling); assert.deepEqual(calls, [false]);
  first.resolve(); await tick(); assert.deepEqual(calls, [false, true]);
  let finished = false; complete.then(() => finished = true);
  await tick(); assert.equal(finished, false);
  second.resolve(); await complete;
  assert.equal(finished, true); assert.equal(maximum, 1);
});

test('읽기 시작 직전에 들어온 강제 요청도 보존하며 정기 조회만 겹치면 반복하지 않는다', async () => {
  const wait = defer(), calls = [];
  const refresh = serialRefresh(async (force) => { calls.push(force); await wait.promise; });
  const work = refresh(); refresh(true); await tick();
  assert.deepEqual(calls, [true]);
  refresh(); refresh(); wait.resolve(); await work;
  assert.deepEqual(calls, [true]);
});

test('조회가 실패해도 다음 갱신이 영구 대기 상태로 남지 않는다', async () => {
  let calls = 0;
  const refresh = serialRefresh(async () => { if (++calls === 1) throw new Error('offline'); });
  await assert.rejects(refresh(), /offline/); await refresh(true);
  assert.equal(calls, 2);
});
