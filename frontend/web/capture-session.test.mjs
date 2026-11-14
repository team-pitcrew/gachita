import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE } from './demo/audio-input.js';
import { windows, utterances, processCapture, createCaptureFence, captureWrite, captureAppend, combineSamples, StaleCapture } from './demo/capture-session.js';
const makeJob = () => ({ code: 'TEST12', generation: 1, at: 10000, device: 'web-test', seq: 0, samples: new Float32Array(RATE), parts: windows(RATE) });
test('전사 창은 마지막 표본까지 겹침 없이 보존하며 10초를 넘지 않는다', () => {
  for (const length of [RATE / 2, RATE * 7.7, RATE * 30 + 123]) {
    const parts = windows(length); assert.equal(parts[0].start, 0); assert.equal(parts.at(-1).end, length);
    parts.forEach((part, i) => { assert(part.end - part.start >= RATE / 2); assert(part.end - part.start <= RATE * 10); if (i) assert.equal(part.start, parts[i - 1].end); });
  }
});
test('실제 화자·끝 시각만 보존하고 잘못된 메타데이터에서는 전체 글을 유지한다', () => {
  const j = makeJob(), part = { start: RATE, end: RATE * 2 };
  const result = { segments: [{ start: .1, end: .7, text: '테스트 발화', speakerLabel: 'spk:0' }], diarization: { status: 'available', requestId: 'scope-1' } };
  assert.deepEqual(utterances(result, part, j)[0], { at: 11100, endAt: 11700, text: '테스트 발화', generation: 1, speakerLabel: 'spk:0', speakerScope: 'scope-1' });
  assert.deepEqual(utterances({ text: '전체 글 유지', segments: null, diarization: { status: 'invalid' } }, part, j), [{ at: 11000, text: '전체 글 유지', generation: 1 }]);
});
test('발화 저장 응답이 사라져도 ASR을 다시 호출하지 않고 같은 순번으로 복구한다', async () => {
  const j = makeJob(); let asr = 0, uploads = 0; const bodies = [];
  const request = async (_m, path, body) => {
    if (path.startsWith('/transcriptions')) { asr++; return { text: '같은 대화' }; }
    if (path === '/utterances') { bodies.push(structuredClone(body)); if (++uploads === 1) throw new Error('response lost'); return { generation: 1, lastSeq: 1 }; }
    return { participantId: null };
  };
  const opts = { request, persist: async () => {}, valid: () => true };
  await assert.rejects(processCapture(j, opts), /response lost/);
  await processCapture(j, opts); assert.equal(asr, 1); assert.deepEqual(bodies[0], bodies[1]); assert.equal(j.complete, true);
});
test('화자 대조 실패를 재시도할 때 이미 저장된 전사와 발화를 다시 보내지 않는다', async () => {
  const j = makeJob(); let asr = 0, uploads = 0, matches = 0;
  const request = async (_m, path) => {
    if (path.startsWith('/transcriptions')) { asr++; return { text: '익명 화자' }; }
    if (path === '/utterances') { uploads++; return { generation: 1, lastSeq: 1 }; }
    if (++matches === 1) throw new Error('match offline'); return { participantId: null };
  };
  const opts = { request, persist: async () => {}, valid: () => true };
  await assert.rejects(processCapture(j, opts)); await processCapture(j, opts);
  assert.deepEqual([asr, uploads, matches], [1, 1, 2]);
});
test('전사 중 동의가 바뀌면 늦게 받은 글을 저장하거나 화자 대조하지 않는다', async () => {
  const j = makeJob(); let valid = true, saved = 0, calls = 0;
  await assert.rejects(processCapture(j, { request: async () => { calls++; valid = false; return { text: '늦은 결과' }; }, persist: async () => saved++, valid: () => valid }), /동의/);
  assert.equal(calls, 1); assert.equal(saved, 0); assert.equal(j.complete, undefined); assert.equal(j.parts[0].result, undefined);
});
test('무음 응답만 빈 구간으로 처리하고 공급자 오류를 성공으로 바꾸지 않는다', async () => {
  const opts = { persist: async () => {}, valid: () => true };
  const silent = makeJob(); await processCapture(silent, { ...opts, request: async () => { throw Object.assign(new Error('silence'), { status: 422 }); } });
  assert.equal(silent.complete, true); assert.equal(silent.seq, 0);
  await assert.rejects(processCapture(makeJob(), { ...opts, request: async () => { throw Object.assign(new Error('provider unavailable'), { status: 503 }); } }), /provider unavailable/);
});
test('ASR 직후 취소한 작업은 반쪽 응답을 남기지 않고 다시 처리할 수 있다', async () => {
  const j = makeJob(), controller = new AbortController(); let calls = 0;
  const request = async (_method, path) => {
    if (path.startsWith('/transcriptions')) { if (++calls === 1) controller.abort(); return { text: '처음부터 보존하는 글' }; }
    if (path === '/utterances') return { generation: 1, lastSeq: 1 };
    return { participantId: null };
  };
  const opts = { request, persist: async () => {}, valid: () => true };
  await assert.rejects(processCapture(j, { ...opts, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(j.parts[0].result, undefined); assert.equal(j.parts[0].items, undefined); assert.equal(j.seq, 0);
  await processCapture(j, opts); assert.equal(j.complete, true); assert.equal(j.seq, 1); assert.equal(calls, 2);
});
test('과거에 응답만 저장된 체크포인트도 발화 순번을 중복시키지 않고 복구한다', async () => {
  const j = makeJob(); j.parts[0].result = { text: '미완료 응답' };
  await processCapture(j, {
    request: async (_method, path) => path.startsWith('/transcriptions') ? { text: '다시 받은 글' } : path === '/utterances' ? { generation: 1, lastSeq: 1 } : { participantId: null },
    persist: async () => {}, valid: () => true,
  });
  assert.equal(j.parts[0].items[0].text, '다시 받은 글'); assert.equal(j.seq, 1); assert.equal(j.complete, true);
});
test('마이크 권한 대기 중 취소하면 늦게 생긴 장치를 닫고 새 세션을 유지한다', () => {
  const fence = createCaptureFence(() => true), first = fence.begin({ owner: 'A', generation: 1 });
  first.abort = new AbortController();
  assert.equal(fence.accepts(first), false);
  fence.cancel(); assert.equal(first.abort.signal.aborted, true);
  const second = fence.begin({ owner: 'A', generation: 1 }); let stopped = 0;
  assert.equal(fence.attach(first, { stop: () => stopped++ }), false);
  assert.equal(stopped, 1); assert.equal(fence.current, second); assert.equal(fence.accepts(first), false);
  assert.equal(fence.attach(second, { stop: () => stopped++ }), true);
  assert.equal(fence.accepts(second), false);
  second.accepting = true; assert.equal(fence.accepts(second), true);
  fence.cancel(); assert.equal(stopped, 2); assert.equal(fence.owns(undefined), false);
});
test('동의 세대나 참가자가 바뀌면 이전 장치 표본을 즉시 거절한다', () => {
  let active = { owner: 'A', generation: 1, consent: true };
  const fence = createCaptureFence((scope) => active.consent && scope.owner === active.owner && scope.generation === active.generation);
  const session = fence.begin({ owner: 'A', generation: 1 }); session.accepting = true;
  assert.equal(fence.accepts(session), true);
  active = { ...active, generation: 2 }; assert.equal(fence.accepts(session), false);
  active = { ...active, generation: 1, owner: 'B' }; assert.equal(fence.accepts(session), false);
  active = { ...active, owner: 'A', consent: false }; assert.equal(fence.accepts(session), false);
  let stopped = false; assert.equal(fence.attach(session, { stop: () => stopped = true }), false); assert.equal(stopped, true);
});
test('삭제 표식·새 녹음·새 동의 세대는 늦게 도착한 PCM과 전사 저장을 거절한다', () => {
  const incoming = { owner: 'A', captureId: 'old', generation: 1, revision: 4, samples: new Float32Array([.1]) };
  for (const current of [undefined, { ...incoming, revoked: true }, { ...incoming, captureId: 'new' }, { ...incoming, generation: 2 }, { ...incoming, revision: 5 }]) {
    assert.throws(() => captureWrite(current, incoming), StaleCapture);
    assert.throws(() => captureAppend(current, incoming, 0, 1), StaleCapture);
  }
  assert.equal(captureWrite({ ...incoming, revision: 3 }, incoming), incoming);
});
test('PCM 체크포인트는 순서와 표본을 보존하고 중복·뒤늦은 청크를 거절한다', () => {
  const start = { owner: 'A', captureId: 'capture', generation: 1, revision: 0, rawOnly: true, rawChunks: 0, sampleCount: 0 };
  const chunks = [new Float32Array([.25, -.5]), new Float32Array([1, 0, -1])];
  const first = captureAppend(start, { ...start, revision: 1 }, 0, chunks[0].length);
  const second = captureAppend(first, { ...first, revision: 2 }, 1, chunks[1].length);
  assert.equal(second.rawChunks, 2); assert.equal(second.sampleCount, 5);
  assert.deepEqual([...combineSamples(chunks)], [.25, -.5, 1, 0, -1]);
  assert.throws(() => captureAppend(second, { ...second, revision: 3 }, 1, 3), StaleCapture);
  assert.throws(() => captureAppend(second, { ...second, revision: 1 }, 2, 3), StaleCapture);
  assert.throws(() => captureAppend({ ...second, samples: combineSamples(chunks) }, second, 2, 3), StaleCapture);
  assert.throws(() => captureAppend({ ...second, rawOnly: false }, second, 2, 3), StaleCapture);
});
