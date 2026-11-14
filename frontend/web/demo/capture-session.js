import { RATE, wav } from './audio-input.js';

// 전사 응답과 발화 저장을 따로 체크포인트합니다. 저장 응답이 유실돼도 같은 기기/순번으로 재전송합니다.
export function windows(length, size = RATE * 7.5) {
  const parts = [];
  for (let start = 0; start < length; start += size) {
    const end = Math.min(length, start + size);
    if (end - start < RATE / 2 && parts.length) parts.at(-1).end = end;
    else if (end - start >= RATE / 2) parts.push({ start, end });
  }
  return parts;
}

export function utterances(result, part, job) {
  const offset = part.start / RATE;
  const pieces = result.diarization?.status === 'available' && result.segments?.length ? result.segments : null;
  if (!pieces) return result.text?.trim() ? [{ at: Math.round(job.at + offset * 1000), text: result.text.trim(), generation: job.generation }] : [];
  return pieces.map((segment) => ({
    at: Math.round(job.at + (offset + segment.start) * 1000),
    endAt: Math.round(job.at + (offset + segment.end) * 1000),
    text: segment.text, generation: job.generation,
    speakerLabel: segment.speakerLabel, speakerScope: result.diarization.requestId,
  }));
}

export async function processCapture(job, { request, persist, valid, onProgress = () => {}, signal }) {
  const assert = () => { signal?.throwIfAborted(); if (!valid(job)) throw new Error('여행이나 기록 동의가 바뀌었어요.'); };
  assert();
  for (let index = 0; index < job.parts.length; index++) {
    const part = job.parts[index];
    assert(); onProgress(index, job.parts.length);
    if (!part.result || !part.items) {
      let result;
      try { result = await request('POST', `/transcriptions?generation=${job.generation}`, wav(job.samples.subarray(part.start, part.end)), signal); }
      catch (error) {
        // 공급자가 받아 적을 음성이 없다고 명시한 구간만 건너뜁니다. 다른 실패는 자동 재전송하지 않습니다.
        if (error.status !== 422) throw error;
        result = { text: '', silence: true };
      }
      assert();
      const items = utterances(result, part, job).map((item, index) => ({ ...item, seq: job.seq + index + 1 }));
      Object.assign(part, { result, items }); job.seq += items.length;
      await persist(job);
    }
    if (!part.saved && part.items.length) {
      const ack = await request('POST', '/utterances', { device: job.device, generation: job.generation, items: part.items }, signal);
      assert();
      if (ack.generation !== job.generation || ack.lastSeq < part.items.at(-1).seq) throw new Error('서버가 모든 대화를 저장했는지 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.');
      part.saved = true; await persist(job);
    }
    for (const item of part.items) {
      if (part.matches?.[item.seq]) continue;
      assert();
      const from = Math.max(0, Math.floor((item.at - job.at) / 1000 * RATE));
      const to = item.endAt ? Math.min(job.samples.length, Math.ceil((item.endAt - job.at) / 1000 * RATE)) : part.end;
      if (to - from < RATE / 2) { (part.matches ||= {})[item.seq] = { skipped: 'short-segment' }; await persist(job); continue; }
      const matched = await request('POST', `/voice-match?device=${encodeURIComponent(job.device)}&seq=${item.seq}`, wav(job.samples.subarray(from, to)), signal);
      assert(); (part.matches ||= {})[item.seq] = matched; await persist(job);
    }
    part.done = true; await persist(job); onProgress(index + 1, job.parts.length);
  }
  job.complete = true; await persist(job); return job;
}


export class StaleCapture extends Error { constructor() { super('원음 보관 상태가 바뀌었어요. 새로 확인해 주세요.'); this.name = 'StaleCapture'; } }

// Pending getUserMedia cannot be aborted by the platform. Its late device is stopped on attachment,
// and samples are rejected until the same owner/generation has explicitly activated this session.
export function createCaptureFence(valid) {
  let epoch = 0, current;
  const owns = (session) => !!session && current === session && session.epoch === epoch && valid(session.scope);
  const cancel = () => { epoch++; if (current) { current.accepting = false; current.abort?.abort(); current.device?.stop(); } current = null; };
  return {
    begin(scope) { cancel(); return current = { epoch, scope, accepting: false, device: null }; },
    owns,
    attach(session, device) { if (!owns(session)) { device.stop(); return false; } session.device = device; return true; },
    accepts: (session) => owns(session) && session.accepting,
    cancel,
    get current() { return current; },
  };
}

export function captureWrite(current, incoming) {
  if (!current || current.revoked || !incoming.captureId || current.captureId !== incoming.captureId || current.generation !== incoming.generation) throw new StaleCapture();
  if ((current.revision || 0) > (incoming.revision || 0)) throw new StaleCapture();
  return incoming;
}
export function captureAppend(current, incoming, index, sampleLength) {
  captureWrite(current, incoming);
  if (!current.rawOnly || current.samples || (current.rawChunks || 0) !== index || !Number.isInteger(sampleLength) || sampleLength < 1) throw new StaleCapture();
  return { ...current, ...incoming, rawChunks: index + 1, sampleCount: (current.sampleCount || 0) + sampleLength };
}
export function combineSamples(frames) {
  const result = new Float32Array(frames.reduce((count, frame) => count + frame.length, 0));
  let at = 0; for (const frame of frames) { result.set(frame, at); at += frame.length; }
  return result;
}

const open = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('gachita-capture-drafts', 2);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains('drafts')) req.result.createObjectStore('drafts', { keyPath: 'owner' });
    if (!req.result.objectStoreNames.contains('chunks')) req.result.createObjectStore('chunks', { keyPath: ['captureId', 'index'] });
  };
  req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
  req.onerror = () => reject(new Error('녹음 임시 보관함을 열지 못했어요.'));
});
const range = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
function removeChunks(chunks, id) { if (id) chunks.delete(range(id)); }
async function transaction(owner, operation) {
  const db = await open();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(['drafts', 'chunks'], 'readwrite');
    const drafts = tx.objectStore('drafts'), chunks = tx.objectStore('chunks');
    let value, failure;
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(failure || new Error('원음을 임시 보관하지 못했어요. 저장 공간을 확인해 주세요.'));
    const req = drafts.get(owner);
    req.onsuccess = () => {
      try { operation({ current: req.result, drafts, chunks, done: (result) => { value = result; }, fail: (error) => { failure = error; tx.abort(); } }); }
      catch (error) { failure = error; tx.abort(); }
    };
  }); } finally { db.close(); }
}
export async function beginCapture(job, valid = () => true) {
  job.captureId ||= crypto.randomUUID(); job.revision = 0;
  const next = structuredClone(job);
  return transaction(next.owner, ({ current, drafts, chunks, done }) => {
    if (!valid()) throw new StaleCapture();
    removeChunks(chunks, current?.captureId); drafts.put(next); done(next);
  });
}
export async function saveCapture(job, valid = () => true) {
  job.revision = (job.revision || 0) + 1;
  const next = structuredClone(job);
  return transaction(next.owner, ({ current, drafts, chunks, done }) => {
    if (!valid()) throw new StaleCapture();
    const value = captureWrite(current, next);
    if (value === next) { drafts.put(next); if (next.samples) removeChunks(chunks, next.captureId); }
    done(value);
  });
}
export async function saveRawCapture(job, samples, index, valid = () => true) {
  job.revision = (job.revision || 0) + 1;
  const next = { ...job, checkpointAt: Date.now() }; delete next.samples;
  const copy = new Float32Array(samples);
  return transaction(next.owner, ({ current, drafts, chunks, done }) => {
    if (!valid()) throw new StaleCapture();
    const value = captureAppend(current, next, index, copy.length);
    chunks.put({ captureId: next.captureId, index, samples: copy }); drafts.put(value); done(value);
  });
}
export const loadCapture = (owner) => transaction(owner, ({ current, drafts, chunks, done, fail }) => {
  if (!current || current.revoked) return done(undefined);
  // Upgrade existing drafts in this same transaction; a concurrent delete cannot be resurrected.
  if (!current.captureId) { current.captureId = crypto.randomUUID(); current.revision = 0; drafts.put(current); }
  if (current.samples) return done(current);
  if (!current.rawChunks) return done(undefined);
  const request = chunks.getAll(range(current.captureId));
  request.onsuccess = () => {
    try {
      const parts = request.result;
      if (parts.length !== current.rawChunks || parts.some((part, index) => part.index !== index)) throw new Error('저장된 원음 구간이 빠져 있어요.');
      const samples = combineSamples(parts.map((part) => part.samples));
      if (samples.length !== current.sampleCount) throw new Error('저장된 원음 길이를 확인하지 못했어요.');
      done({ ...current, samples, interrupted: true });
    } catch (error) { fail(error); }
  };
});
export const deleteCapture = (owner, captureId) => transaction(owner, ({ current, drafts, chunks, done }) => {
  if (captureId && current?.captureId !== captureId) return done(false);
  removeChunks(chunks, current?.captureId);
  drafts.put({ owner, captureId: crypto.randomUUID(), revoked: true }); done(true);
});
