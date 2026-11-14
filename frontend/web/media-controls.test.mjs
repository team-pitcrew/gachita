import assert from 'node:assert/strict';
import test from 'node:test';
import { waveformPeaks, createRecordingClock, mediaTime } from './media-controls.js';

test('무음과 한 채널에만 있는 실제 신호를 구분하고 마지막 PCM 샘플을 남긴다', () => {
  assert.deepEqual(waveformPeaks([new Float32Array(8)], 4), [0, 0, 0, 0]);
  assert.deepEqual(waveformPeaks([new Float32Array(5), Float32Array.from([0, -.5, 0, 0, 1])], 2), [.5, 1]);
  assert.deepEqual(waveformPeaks([]), []);
});

test('일시정지·연결 끊김은 시연 시간을 멈추고 새 여행·동의 세대에서 초기화한다', () => {
  let now = 0;
  const clock = createRecordingClock(() => now);
  clock.update('A:1', true); now = 1000; assert.equal(clock.seconds(), 1);
  clock.update('A:1', false); now = 9000; assert.equal(clock.seconds(), 1);
  clock.update('A:1', true); now = 11000; assert.equal(clock.seconds(), 3);
  clock.update('A:2', false); assert.equal(clock.seconds(), 0);
  clock.update('B:1', true); now = 12000; assert.equal(clock.seconds(), 1);
  assert.equal(mediaTime(61.4), '01:01'); assert.equal(mediaTime(NaN), '00:00');
});
