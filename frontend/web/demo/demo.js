// 웹과 차량은 같은 API의 서로 다른 입력 장치입니다. 서버 응답 없이 완료 상태를 만들지 않습니다.
import { api, h, SEATS, SEAT, REQ, toast } from '/shared.js';
import { mediaButton, mediaTime, setMediaButton, waveformPeaks, drawWaveform } from '/media-controls.js';
import { createVehicleBoarding } from '/vehicle-boarding.js';
import { characterImage } from '/short-film.js';
import { createCaptions } from '/captions.js';
import { RATE, LIMIT, wav, decodeInput, microphone } from './audio-input.js';
import { windows, processCapture, saveCapture, loadCapture, deleteCapture, beginCapture, saveRawCapture, createCaptureFence, combineSamples } from './capture-session.js';

const $ = (id) => document.getElementById(id), KEY = 'gachita-demo';
const button = (label, onclick, className = '', disabled = false) => h('button', { type: 'button', onclick, className, disabled }, label);
const field = (label, input) => h('label', { className: 'field' }, h('span', {}, label), input);
let car; try { car = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { car = null; }
let trip, tab = 'capture', busy = false, online = false, error = '', rows = [], todos = [], requestSignature = '', reading = false;
let job, input, inputName = '', recording, recordingAt, frames = [], frameCount = 0, paused = false, processing, progress = '', draftLoaded = '';
let audioURL, sourceAudio, waveform, clock, recordButton, statusNode, feedback, fileRange = { from: 0, to: 30 };
let inputAt, routeObservedAt, lifecycle = 0, actionEpoch = 0, pendingCapture, finishing, unsavedAudio = false;
let routePosition, routeDestination, routeResults, routeError = '', routeBusy = false, routePlace;
const who = () => trip?.participants.find((p) => p.id === car?.id);
const owner = () => car && `${car.code}:${car.id}`;
const allConsent = () => trip?.participants.length > 0 && trip.participants.every((p) => p.consent);
const path = (suffix = '') => `/trips/${car.code}${suffix}`;
const saveCar = () => car ? localStorage.setItem(KEY, JSON.stringify(car)) : localStorage.removeItem(KEY);
const request = (method, suffix, data, signal) => api(method, path(suffix), data, car.token, signal || AbortSignal.timeout(20000));
const captureScope = () => ({ owner: owner(), code: car?.code, generation: trip?.generation, token: car?.token });
const validScope = (scope) => owner() === scope.owner && car?.token === scope.token && trip?.generation === scope.generation && allConsent() && !!who();
const fixedRequest = (scope) => (method, suffix, data, signal) => api(method, `/trips/${scope.code}${suffix}`, data, scope.token, signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000));
const captureFence = createCaptureFence(validScope);
async function changeRecording(scope, data, signal) {
  const updated = await fixedRequest(scope)('PATCH', '', data, signal);
  if (car?.code === scope.code && car?.token === scope.token && (!trip || updated.version >= trip.version)) trip = updated;
  return updated;
}
const board = createVehicleBoarding({ getTrip: () => trip, getToken: () => car?.token, onNotice: toast });
const captions = createCaptions({ getTrip: () => trip, getParticipant: who, request: (code, method, suffix, data, signal) => {
  if (code !== car?.code) throw new Error('여행이 바뀌었어요.');
  return request(method, suffix, data, signal);
}, refreshTrip: () => refresh(true) });

async function act(work) {
  if (busy) return;
  const action = ++actionEpoch;
  busy = true; error = ''; render();
  try { await work(); } catch (e) { if (action === actionEpoch) { error = e.message; toast(e.message); } }
  finally { if (action === actionEpoch) { busy = false; if (car) await refresh(true); else render(); } }
}
function revokeAudio() { sourceAudio?.pause(); if (audioURL) URL.revokeObjectURL(audioURL); audioURL = null; }
function stopDevice() { captureFence.cancel(); recording?.stop(); recording = null; pendingCapture = null; paused = false; }
async function invalidateDraft(message) {
  const previous = job?.owner || captureFence.current?.scope.owner || owner(), previousId = job?.captureId;
  lifecycle++; processing?.abort(); stopDevice(); frames = []; frameCount = 0; job = input = null; inputAt = null; inputName = ''; progress = ''; unsavedAudio = false; revokeAudio();
  if (previous) await deleteCapture(previous, previousId);
  if (message) toast(message);
}
const validJob = (value) => trip?.code === value.code && trip.generation === value.generation && allConsent() && !!who() && owner() === value.owner;
async function checkpoint(session = captureFence.current) {
  if (!session || !captureFence.owns(session)) return;
  if (session.flush) { await session.flush; return checkpoint(session); }
  const end = session.frames.length;
  if (end === session.persistedFrames) return;
  const samples = combineSamples(session.frames.slice(session.persistedFrames, end));
  session.flush = saveRawCapture(session.job, samples, session.nextChunk, () => captureFence.owns(session)).then((saved) => {
    session.persistedFrames = end; session.nextChunk++; session.savedSamples = saved.sampleCount;
    Object.assign(session.job, { checkpointAt: saved.checkpointAt, rawChunks: saved.rawChunks, sampleCount: saved.sampleCount });
    if (captureFence.owns(session)) unsavedAudio = frameCount > saved.sampleCount;
  }).finally(() => { session.flush = null; });
  return session.flush;
}
async function pauseRecording(changeServer = true) {
  const session = captureFence.current, device = recording;
  if (!session || !device) return;
  session.accepting = false; session.controlEpoch++; paused = true;
  await device.pause();
  if (!captureFence.owns(session)) return;
  await checkpoint(session);
  if (changeServer && captureFence.owns(session)) await changeRecording(session.scope, { recording: false }, session.abort.signal);
}
function checkpointFailed(session, failure) {
  if (!captureFence.owns(session)) return;
  session.accepting = false; session.controlEpoch++; paused = true; recording?.pause().catch(() => {});
  error = `임시 저장을 마치지 못해 녹음을 멈췄어요. 마지막 확인 ${mediaTime((session.savedSamples || 0) / RATE)}. 원음을 지우지 말고 저장을 다시 시도해 주세요. ${failure.message}`;
  changeRecording(session.scope, { recording: false }).catch(() => {}); render();
}
async function cancelStarting() {
  const scope = pendingCapture?.scope;
  actionEpoch++; busy = false;
  await invalidateDraft('마이크 시작을 취소했어요.');
  if (scope && validScope(scope) && !captureFence.current) await changeRecording(scope, { recording: false }).catch(() => {});
  render();
}

async function refresh(force = false) {
  if (!car || reading) return;
  reading = true;
  try {
    const requested = car;
    let next = await api('GET', `/trips/${requested.code}`, null, requested.token, AbortSignal.timeout(20000));
    if (car !== requested) return;
    if (trip?.code === next.code && trip.version > next.version) next = trip;
    const changed = trip?.version !== next.version || !online;
    online = true; trip = next;
    if (!who()) { await invalidateDraft(); rows = []; todos = []; throw new Error('이 브라우저의 참가자를 찾을 수 없어요.'); }
    if ((job && !validJob(job)) || (captureFence.current && !captureFence.owns(captureFence.current))) await invalidateDraft('기록 동의가 바뀌어 이 브라우저의 원음도 지웠어요.');
    if (recording && !paused && !trip.recording) await pauseRecording(false);
    board.sync(); captions.sync();
    if (draftLoaded !== owner() && !job && !pendingCapture && !recording) {
      const expectedOwner = owner(), expectedEpoch = lifecycle;
      const stored = await loadCapture(expectedOwner);
      if (owner() !== expectedOwner || lifecycle !== expectedEpoch || job || pendingCapture || recording) return;
      draftLoaded = expectedOwner;
      if (stored && validJob(stored)) {
        job = stored; input = stored.samples; inputName = stored.name; inputAt = stored.at;
        fileRange = { from: 0, to: Math.min(45, input.length / RATE) };
        if (stored.rawOnly) {
          frames = [input]; frameCount = input.length;
          progress = stored.interrupted ? `${mediaTime(input.length / RATE)}의 저장된 원음을 복구했어요. 마지막 완료 체크포인트 이후의 소리는 복구되지 않을 수 있어요. 구간을 선택하거나 녹음 마치기를 눌러 주세요.` : '임시 보관한 원음을 복구했어요. 받아 적을 구간을 선택해 주세요.';
          if (trip.recording) progress += ' 이 브라우저 마이크는 꺼져 있으며 차량 기록 설정은 켜져 있어요.';
        }
      } else if (stored) await deleteCapture(expectedOwner, stored.captureId);
    }
    if (who()?.consent) {
      const scope = captureScope();
      const transcript = await fixedRequest(scope)('GET', '/transcript');
      if (car !== requested || scope.generation !== trip?.generation) return;
      if (transcript.generation === trip.generation) {
        const sig = JSON.stringify(transcript);
        if (sig !== requestSignature) { rows = transcript.utterances || []; todos = transcript.todos || []; requestSignature = sig; if (!busy && !processing && !recording && !document.activeElement?.matches('input,textarea,select')) renderBody(); }
      }
    } else { rows = []; todos = []; }
    if (changed || force) render(); else updateStatus();
  } catch (e) {
    online = false; error = e.message;
    // 새 동의 상태를 확인할 수 없으면 마이크를 멈춥니다. 이미 받은 원음은 명시적으로 지우거나 재시도할 수 있습니다.
    if (recording && !paused) await pauseRecording(false).catch((failure) => { error += ` · ${failure.message}`; });
    updateStatus(); if (force || !trip) render();
  } finally { reading = false; }
}

function viewer(view) {
  if (!trip || !car) return;
  // 차량 참가자 컨텍스트만 iframe의 별도 sessionStorage 영역으로 전달합니다. 휴대폰 프로필을 덮어쓰지 않습니다.
  sessionStorage.setItem(`gachita:vehicle-view:${car.code}`, car.id);
  sessionStorage.setItem(`gachita:vehicle-view:${car.code}:token`, car.token);
  sessionStorage.setItem('gachita:vehicle-view:trip', car.code);
  $('viewer-title').textContent = view === 'shorts' ? '우리 쇼츠' : '함께 나눈 대화';
  $('viewer-frame').src = `/?vehicle-view=1&view=${view}#${car.code}`; $('viewer').showModal();
}
$('viewer-close').onclick = () => $('viewer').close();
$('viewer').addEventListener('close', () => { $('viewer-frame').src = 'about:blank'; });

function welcome() {
  const title = h('input', { required: true, maxLength: 80, value: '함께하는 여행', autocomplete: 'off' });
  const name = h('input', { required: true, maxLength: 20, placeholder: '운전자의 이름', autocomplete: 'given-name' });
  return h('form', { className: 'welcome', onsubmit: (e) => { e.preventDefault(); act(async () => {
    const created = await api('POST', '/trips', { title: title.value.trim() });
    const driver = await api('POST', `/trips/${created.code}/participants`, { name: name.value.trim(), seat: 'ROW_1_LEFT', consent: false });
    car = { code: created.code, id: driver.id, token: driver.token }; saveCar();
  }); } }, h('img', { className: 'welcome-mark', src: '/icons/gachita-192.png', alt: '가치타 캐릭터' }), h('h2', {}, '함께 탄 이야기,', h('br'), '목소리 그대로.'), h('p', {}, '차량에서 시작한 여행을 웹에서도 이어 갑니다. 참석 QR로 일행을 초대하고, 모두의 동의를 받은 뒤 대화를 남겨 보세요.'), field('여행 이름', title), field('내 이름', name), h('button', { type: 'submit', className: 'primary', disabled: busy }, busy ? '여행 만드는 중' : '여행 시작하기'), error && h('p', { role: 'alert', className: 'error-text' }, error));
}
function render() {
  updateStatus();
  if (!trip) { $('trip-heading').replaceChildren(); $('journey-nav').replaceChildren(); $('workspace-body').replaceChildren(welcome()); return; }
  $('trip-heading').replaceChildren(h('div', {}, h('h1', {}, trip.title), h('p', {}, `함께 탄 사람 ${trip.participants.length}명 · ${new Date(trip.createdAt).toLocaleDateString('ko-KR')}`)), button('동승자 설정', people));
  $('journey-nav').replaceChildren(...[['capture', '대화 기록'], ['shorts', '쇼츠'], ['route', '경로와 할 일']].map(([value, name]) => {
    const control = button(name, () => { if (value === 'shorts') viewer('shorts'); else { tab = value; renderBody(); } });
    if (tab === value) control.setAttribute('aria-current', 'page'); return control;
  }));
  renderBody();
}
function updateStatus() {
  $('connection').textContent = online ? '서버 연결됨' : '서버 연결 확인 중';
  if (clock) clock.textContent = mediaTime(recording ? frameCount / RATE : input?.length / RATE || 0);
  if (statusNode) { statusNode.textContent = processing ? '대화를 받아 적는 중' : pendingCapture ? '마이크 준비 중' : recording ? paused ? '일시정지' : '녹음 중' : input ? '원음 준비됨' : '녹음 대기'; statusNode.classList.toggle('live', !!recording && !paused); }
  if (feedback) feedback.textContent = error || progress;
  if (recordButton) setMediaButton(recordButton, recording && !paused ? 'pause' : recording ? 'play' : 'record', recording && !paused ? '녹음 일시정지' : recording ? '녹음 재개' : '마이크 녹음 시작');
  if (waveform) { const sample = recording ? frames.slice(-20).flatMap((x) => Array.from(x)) : input; drawWaveform(waveform, sample?.length ? waveformPeaks([sample], 100) : [], sourceAudio?.duration ? sourceAudio.currentTime / sourceAudio.duration : 0); }
}
function renderBody() {
  if (!trip) return;
  // 파일 선택과 입력 중인 좌표는 정기 조회로 바꾸지 않습니다.
  if (document.activeElement?.matches('input,textarea,select') && document.activeElement.closest('#workspace-body')) return;
  $('workspace-body').replaceChildren(tab === 'route' ? routes() : captureView());
  updateStatus();
}
function captureView() {
  clock = h('time', { className: 'capture-time', 'aria-label': '원음 길이' }, '00:00');
  waveform = h('canvas', { className: 'capture-wave', width: 1200, height: 160, 'aria-label': '실제 원음의 파형' });
  statusNode = h('span', { className: 'capture-status', role: 'status' }); feedback = h('p', { className: 'capture-feedback', role: 'status' });
  recordButton = mediaButton('record', '마이크 녹음 시작', () => act(toggleRecording), 'record-control'); recordButton.disabled = busy || !!processing || !!finishing || !online || !allConsent();
  const finish = mediaButton('stop', pendingCapture ? '마이크 시작 취소' : '녹음 마치기', () => pendingCapture ? cancelStarting().catch((e) => { error = e.message; render(); }) : act(finishRecording)); finish.disabled = !pendingCapture && ((!recording && !(job?.rawOnly && input)) || busy);
  const picker = h('input', { type: 'file', accept: 'audio/*,video/*', hidden: true, onchange: (e) => act(() => importFile(e.target.files?.[0])) });
  const actions = h('div', { className: 'capture-actions' });
  if (input && !recording) {
    const from = h('input', { type: 'number', min: 0, max: Math.max(0, input.length / RATE - .5), step: .1, value: fileRange.from, disabled: !!processing || !!job && !job.rawOnly, 'aria-label': '선택 구간 시작 초', oninput: (e) => fileRange.from = Number(e.target.value) });
    const to = h('input', { type: 'number', min: .5, max: input.length / RATE, step: .1, value: fileRange.to, disabled: !!processing || !!job && !job.rawOnly, 'aria-label': '선택 구간 끝 초', oninput: (e) => fileRange.to = Number(e.target.value) });
    if (!job || job.rawOnly) actions.append(h('div', { className: 'clip-range' }, '원음 구간', from, '초부터', to, '초까지'));
    actions.append(button(processing ? '전사 취소' : job?.complete ? '선택한 원음으로 장면 남기기' : job && !job.rawOnly ? '남은 구간 다시 처리' : '이 구간 받아 적기', () => processing ? processing.abort() : job?.complete ? act(keepMoment) : transcribe().catch((e) => { error = e.name === 'AbortError' ? '전사를 멈췄어요. 저장된 구간은 유지합니다.' : e.message; }).finally(() => refresh(true)), 'primary', busy || !allConsent()));
    actions.append(button('원음 지우기', () => act(async () => { if (confirm('이 브라우저에 임시 보관한 원음을 지울까요? 서버에 저장된 장면은 그대로 남아요.')) await invalidateDraft(); }), '', !!processing || busy));
  }
  const preview = h('div', { className: 'source-preview' });
  if (input && !recording) {
    if (!audioURL) audioURL = URL.createObjectURL(wav(input));
    sourceAudio = h('audio', { src: audioURL, controls: true, preload: 'metadata', 'aria-label': '입력 원음 듣기' }); sourceAudio.ontimeupdate = updateStatus; preview.append(sourceAudio);
  }
  const consentHint = !allConsent() && h('p', { className: 'capture-footnote' }, '모두 기록에 동의하면 녹음을 시작할 수 있어요. ', button('동의와 동승자 확인', people));
  const panel = h('section', { className: 'capture-panel' }, h('div', { className: 'capture-head' }, h('div', {}, h('h2', {}, '우리의 대화'), h('p', { className: 'capture-source' }, inputName || '마이크 또는 가지고 있는 영상·음성')), statusNode), clock, waveform, h('div', { className: 'capture-transport' }, recordButton, finish), preview, h('div', { className: 'capture-upload' }, h('p', {}, '녹음한 원음은 이 브라우저에 임시 보관합니다. 받아 적을 때 음성을 서버로 보내고, 장면으로 남긴 구간만 함께 저장해요.'), button('영상·음성 선택', () => picker.click(), '', busy || !!recording || !!processing || !online || !allConsent()), picker), actions, feedback);
  return h('div', {}, panel, consentHint, h('div', { className: 'section-heading' }, h('h2', {}, `함께 나눈 이야기 ${rows.length}`), h('div', { className: 'actions' }, button('전체 대화', () => viewer('conversation')), button('자막 보정', () => captions.open(), '', !rows.length))),
    h('div', { className: 'live-lines' }, rows.slice(-8).map((line) => {
      const person = trip.participants.find((p) => p.id === line.participantId);
      const speaker = person?.name || (line.speakerLabel ? `화자 ${Number(line.speakerLabel.split(':')[1]) + 1} · 이 구간` : '말한 사람 미확인');
      return h('article', { className: 'live-line' }, characterImage(person?.character || 'basic-small'), h('div', {}, h('small', {}, speaker), h('p', {}, line.displayText ?? line.editedText ?? line.asrText ?? line.text), h('small', {}, new Date(line.at).toLocaleTimeString('ko-KR'), line.editedText ? ' · 자막 수정됨' : line.asrText ? ' · 자동 재전사' : '')), button('화자 확인', () => speakerEditor(line), '', busy));
    })), !rows.length && h('p', { className: 'capture-footnote' }, '받아 적은 대화가 여기에 모입니다. 확인되지 않은 화자에는 이름을 임의로 붙이지 않아요.'));
}

async function importFile(file) {
  if (!file) return;
  if (!online || !allConsent()) throw new Error('서버 연결과 모두의 기록 동의를 먼저 확인해 주세요.');
  if (job && !confirm('임시 보관한 원음을 새 파일로 바꿀까요? 서버에 저장한 대화는 그대로 남아요.')) return;
  const scope = captureScope(), epoch = lifecycle;
  const samples = await decodeInput(file);
  if (lifecycle !== epoch || !validScope(scope)) throw new Error('파일을 읽는 동안 여행이나 기록 동의가 바뀌었어요.');
  await invalidateDraft();
  const active = lifecycle;
  const value = { owner: scope.owner, code: scope.code, generation: scope.generation, name: file.name, samples, rawOnly: true, imported: true, at: null };
  await beginCapture(value, () => active === lifecycle && validScope(scope));
  if (active !== lifecycle || !validScope(scope)) return;
  job = value; input = samples; inputAt = null; inputName = file.name; draftLoaded = scope.owner;
  fileRange = { from: 0, to: Math.min(30, input.length / RATE) }; progress = '원음을 임시 보관했어요. 구간을 고르고 들어 본 뒤 받아 적어 주세요.';
}
async function toggleRecording() {
  if (finishing) throw new Error('원음 보관을 마친 뒤 녹음을 다시 시작해 주세요.');
  if (!online || !allConsent()) throw new Error('서버 연결과 모두의 기록 동의를 확인한 뒤 시작해 주세요.');
  if (recording) {
    if (!paused) await pauseRecording();
    else {
      const session = captureFence.current;
      if (!session || !captureFence.owns(session)) throw new Error('녹음 상태를 다시 확인해 주세요.');
      await checkpoint(session);
      const device = recording, control = ++session.controlEpoch;
      await changeRecording(session.scope, { recording: true }, session.abort.signal);
      if (!captureFence.owns(session) || !trip.recording || control !== session.controlEpoch) return;
      await device.resume();
      if (!captureFence.owns(session) || !trip.recording || control !== session.controlEpoch) { await device.pause().catch(() => {}); return; }
      session.accepting = true; paused = false;
    }
    return;
  }
  if (pendingCapture) return;
  if (input && !confirm('임시 보관한 원음을 새 녹음으로 바꿀까요?')) return;
  await invalidateDraft();
  const session = captureFence.begin(captureScope());
  Object.assign(session, { abort: new AbortController(), frames: [], persistedFrames: 0, nextChunk: 0, savedSamples: 0, controlEpoch: 0 });
  pendingCapture = session; frames = session.frames; frameCount = 0;
  session.job = { owner: session.scope.owner, code: session.scope.code, generation: session.scope.generation, name: '마이크로 녹음한 대화', rawOnly: true, rawChunks: 0, sampleCount: 0, at: Date.now(), recording: true };
  job = session.job; inputName = job.name; render();
  try {
    await beginCapture(session.job, () => captureFence.owns(session));
    if (!captureFence.owns(session)) return;
    draftLoaded = session.scope.owner;
    const device = await microphone((samples) => {
      if (!captureFence.accepts(session)) return;
      const next = samples.subarray(0, Math.max(0, LIMIT - frameCount));
      if (!next.length) return;
      if (!frameCount) { recordingAt = Date.now(); session.job.at = recordingAt; }
      session.frames.push(next); frameCount += next.length; unsavedAudio = true;
      if (frameCount >= LIMIT && !finishing) finishAutomatically();
    }, () => { if (captureFence.owns(session)) finishAutomatically(); });
    if (!captureFence.attach(session, device)) return;
    await device.pause();
    if (!captureFence.owns(session)) return;
    await changeRecording(session.scope, { status: 'driving', recording: true }, session.abort.signal);
    if (!captureFence.owns(session)) return;
    recording = device; pendingCapture = null; paused = true;
    const control = ++session.controlEpoch;
    if (!trip.recording) return;
    await device.resume();
    if (!captureFence.owns(session) || !trip.recording || control !== session.controlEpoch) { await device.pause().catch(() => {}); return; }
    session.accepting = true; paused = false;
  } catch (e) {
    if (captureFence.current === session) { await invalidateDraft(); throw e; }
  } finally {
    if (captureFence.current === session && !captureFence.owns(session)) await invalidateDraft();
  }
}
function finishAutomatically() {
  const epoch = lifecycle, done = finishRecording(); render();
  done.then(() => { if (epoch === lifecycle) render(); }).catch((e) => { if (epoch === lifecycle) { error = e.message; render(); } });
}
async function finishRecording() {
  if (finishing) return finishing;
  const session = captureFence.current, scope = session?.scope || captureScope(), epoch = lifecycle;
  if (!session && !(job?.rawOnly && input)) return;
  if (session) { session.accepting = false; session.device?.stop(); }
  recording = null; pendingCapture = null; paused = false;
  finishing = (async () => {
    if (session?.flush) await session.flush.catch(() => {});
    if (epoch !== lifecycle || !validScope(scope)) return;
    const samples = session ? combineSamples(session.frames) : input;
    if (samples.length < RATE / 2) { await invalidateDraft('0.5초 이상 녹음한 원음부터 보관할 수 있어요.'); return; }
    const value = { ...(session?.job || job), samples, rawOnly: true, recording: false, interrupted: false, checkpointAt: Date.now() };
    job = value; input = samples; inputAt = value.at; frames = []; frameCount = samples.length;
    fileRange = { from: 0, to: Math.min(45, samples.length / RATE) }; revokeAudio();
    await saveCapture(value, () => epoch === lifecycle && job === value && validScope(scope));
    if (epoch !== lifecycle || job !== value || !validScope(scope)) return;
    unsavedAudio = false; captureFence.cancel();
    await changeRecording(scope, { recording: false });
    progress = '녹음을 마치고 원음을 임시 보관했어요. 들어 본 뒤 받아 적을 구간을 골라 주세요.';
  })().finally(() => { finishing = null; });
  return finishing;
}
async function transcribe() {
  if (processing) return;
  if (!input || !job || !online || !allConsent()) throw new Error('원음과 서버 연결, 모두의 기록 동의를 확인해 주세요.');
  const controller = processing = new AbortController(), scope = captureScope(), epoch = lifecycle;
  const valid = (value) => !controller.signal.aborted && epoch === lifecycle && job === value && validScope(scope) && validJob(value);
  error = ''; renderBody();
  try {
    if (job.rawOnly) {
      const from = Math.round(fileRange.from * RATE), to = Math.round(fileRange.to * RATE);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > input.length || to - from < RATE / 2 || to - from > RATE * 45) throw new Error('0.5초에서 45초 사이의 원음 구간을 골라 주세요.');
      const samples = input.slice(from, to), now = Date.now();
      job = { captureId: job.captureId, revision: job.revision, owner: scope.owner, code: scope.code, generation: scope.generation, name: inputName, samples, at: inputAt ? inputAt + from / RATE * 1000 : now - samples.length / RATE * 1000, device: `web-${crypto.randomUUID().replaceAll('-', '')}`, seq: 0, parts: windows(samples.length) };
      input = samples; revokeAudio();
    }
    const current = job;
    await saveCapture(current, () => valid(current));
    unsavedAudio = false;
    await processCapture(current, { request: fixedRequest(scope), persist: (value) => saveCapture(value, () => valid(value)), valid, signal: controller.signal, onProgress: (done, total) => { progress = `원음 ${total}구간 중 ${done}구간 저장됨 · 화자 확인 함께 처리`; updateStatus(); } });
    if (valid(current)) {
      const unresolved = current.parts.filter((part) => part.result?.text && part.result.diarization?.status !== 'available').length;
      progress = unresolved
        ? `전사를 저장했어요. ${unresolved}개 구간은 화자 구분이 불확실해 원문으로 남겼습니다. 원음을 듣고 자막과 말한 사람을 확인해 주세요.`
        : '전사와 화자 대조를 마쳤어요. 자막과 말한 사람을 확인한 뒤 장면으로 남겨 주세요.';
    }
  } catch (e) { if (epoch === lifecycle) progress = '이미 임시 보관된 원음은 유지했어요. 다시 처리하면 저장이 확인된 구간부터 이어집니다.'; throw e; }
  finally { if (processing === controller) processing = null; }
}
async function keepMoment() {
  if (!job?.complete || !validJob(job)) throw new Error('전사 결과와 기록 동의를 먼저 확인해 주세요.');
  const current = job, scope = captureScope(), epoch = lifecycle, by = car.id, createdAt = trip.createdAt;
  const valid = () => job === current && lifecycle === epoch && validScope(scope) && validJob(current);
  const check = () => { if (!valid()) throw new Error('여행이나 기록 동의가 바뀌었어요.'); };
  const send = fixedRequest(scope), seconds = current.samples.length / RATE;
  if (seconds < 15 || seconds > 45) throw new Error('쇼츠 장면은 15초에서 45초 사이의 원음을 골라 주세요.');
  if (!current.moment) {
    const moment = await send('POST', '/moments', { at: Math.max(createdAt, current.at), from: current.at, to: Math.round(current.at + seconds * 1000), by, label: '함께 나눈 이야기' });
    check(); current.moment = moment;
    await saveCapture(current, valid);
  }
  check();
  await send('POST', `/recordings?moment=${current.moment.id}&generation=${current.generation}&from=${Math.round(current.at)}`, wav(current.samples));
  check(); await changeRecording(scope, { status: 'parked', recording: false }); check();
  progress = '장면과 원음이 서버에 저장됐어요. 쇼츠에서 같은 장면을 만들 수 있어요.';
}

function people() {
  const dialog = $('settings');
  const own = who();
  dialog.replaceChildren(h('header', { className: 'dialog-heading' }, h('h2', { id: 'settings-title' }, '함께 타는 사람'), button('닫기', () => dialog.close())),
    h('div', { className: 'people-list' }, trip.participants.map((p) => h('div', { className: 'person-setting' }, characterImage(p.character || 'basic'), h('div', {}, h('strong', {}, p.name), h('p', {}, SEAT[p.seat]), h('small', {}, p.consent ? '기록 동의함' : '기록 동의 전')), p.id === car.id && button(p.consent ? '내 동의 끄기' : '내 기록 동의', () => consent())))),
    h('p', { className: 'capture-footnote' }, '휴대폰 카메라로 차량의 QR을 스캔하고, 각자의 프로필과 자리를 고릅니다. 기록 동의는 각자의 화면에서 정해요.'),
    button('참석 QR 전체 화면으로 보기', () => { dialog.close(); board.open(); }, 'primary', !['boarding', 'parked'].includes(trip.status) || !own),
    ...(trip.status === 'driving' ? [button('주차하고 동승자 초대', () => { dialog.close(); act(async () => { if (recording) await finishRecording(); await request('PATCH', '', { status: 'parked', recording: false }); }); })] : []),
    button('새 여행 만들기', () => { if (recording || pendingCapture || processing) return toast('녹음과 처리를 먼저 마쳐 주세요.'); if (!confirm('현재 여행은 서버에 남기고 새 여행을 시작할까요?')) return; dialog.close(); invalidateDraft().then(() => { car = null; trip = null; rows = []; draftLoaded = ''; saveCar(); render(); }).catch((e) => { error = e.message; render(); }); }));
  dialog.showModal();
}
function consent() {
  const current = who(), dialog = $('settings');
  if (current.consent) {
    if (!confirm('기록 동의를 끄면 이 여행의 전사록과 서버 원음이 삭제됩니다. 끌까요?')) return;
    dialog.close(); return act(async () => {
      const scope = captureScope(), id = car.id;
      let localFailure;
      try { await invalidateDraft(); } catch (e) { localFailure = e; }
      await fixedRequest(scope)('PATCH', `/participants/${id}`, { consent: false });
      if (localFailure) throw new Error(`서버 기록 동의는 껐지만 브라우저 원음 삭제를 확인하지 못했어요. ${localFailure.message}`);
    });
  }
  dialog.replaceChildren(h('header', { className: 'dialog-heading' }, h('h2', { id: 'settings-title' }, '내 목소리를 기록할까요?'), button('닫기', () => dialog.close())),
    h('p', {}, '모두 동의한 동안만 대화를 기록합니다. 웹에서 받은 원음은 이 브라우저에 임시 보관하고, 전사와 화자 대조를 위해 음성 인식 서버로 보냅니다. 장면으로 선택한 원음과 전사록은 공용 서버에 저장됩니다.'),
    h('p', {}, '기록 동의는 언제든 끌 수 있습니다. 동의를 끄면 여행의 전사록과 서버에 저장된 원음·쇼츠를 지웁니다. 별도로 내려받거나 다른 앱으로 공유한 사본은 남습니다.'),
    button('동의하고 계속', () => { dialog.close(); act(() => request('PATCH', `/participants/${car.id}`, { consent: true })); }, 'primary'));
}
function speakerEditor(line) {
  const dialog = $('settings'), select = h('select', {}, h('option', { value: '' }, '말한 사람 미확인'), trip.participants.filter((p) => p.consent).map((p) => h('option', { value: p.id }, p.name)));
  select.value = line.participantId || '';
  dialog.replaceChildren(h('header', { className: 'dialog-heading' }, h('h2', { id: 'settings-title' }, '말한 사람 확인'), button('닫기', () => dialog.close())), h('p', {}, line.displayText ?? line.text), field('직접 확인한 화자', select), h('p', { className: 'capture-footnote' }, '등록된 목소리와 일치하지 않으면 이름을 붙이지 않습니다. 원음을 듣고 확인한 경우에만 선택해 주세요.'), button('저장', () => act(async () => { await request('PATCH', `/utterances/${encodeURIComponent(line.device)}/${line.seq}`, { participantId: select.value || null }); dialog.close(); }), 'primary'));
  dialog.showModal();
}
function coordinateFields(title, value, onChange) {
  const lat = h('input', { type: 'number', step: 'any', min: -90, max: 90, value: value?.lat ?? '', placeholder: '위도', 'aria-label': `${title} 위도` });
  const lng = h('input', { type: 'number', step: 'any', min: -180, max: 180, value: value?.lng ?? '', placeholder: '경도', 'aria-label': `${title} 경도` });
  lat.oninput = lng.oninput = () => onChange(lat.value !== '' && lng.value !== '' ? { lat: Number(lat.value), lng: Number(lng.value) } : null);
  return h('fieldset', {}, h('legend', {}, title), lat, lng);
}
function routes() {
  return h('section', {}, h('div', { className: 'section-heading' }, h('h2', {}, '다음에 쉬어 갈 곳')),
    h('form', { onsubmit: (e) => { e.preventDefault(); if (!routePosition || !routeDestination) return toast('현재 위치와 목적지를 입력해 주세요.'); routeBusy = true; routeError = ''; renderBody(); api('POST', '/rest-stops', { from: routePosition, to: routeDestination, limit: 5 }).then((data) => { routeResults = data; }, (e) => { routeError = e.message; }).finally(() => { routeBusy = false; renderBody(); }); } },
      h('div', { className: 'route-form' }, coordinateFields('현재 위치', routePosition, (v) => { routePosition = v; routeObservedAt = null; }), coordinateFields('목적지', routeDestination, (v) => routeDestination = v)),
      h('div', { className: 'capture-actions' }, button('현재 위치 가져오기', () => navigator.geolocation.getCurrentPosition((p) => { routePosition = { lat: p.coords.latitude, lng: p.coords.longitude }; routeObservedAt = p.timestamp; renderBody(); }, (e) => toast(e.message), { enableHighAccuracy: true, timeout: 10000 })), h('button', { type: 'submit', className: 'primary', disabled: routeBusy }, routeBusy ? '후보 찾는 중' : '휴게소 찾기'))),
    h('p', { className: 'capture-footnote' }, '현재 위치와 목적지 방향으로 후보를 찾습니다. 실제 도로 경로와 진입 가능 여부는 차량 내비에서 확인합니다.'),
    routeError && h('p', { role: 'alert', className: 'error-text' }, routeError),
    routeResults && h('div', {}, !routeResults.items.length ? h('p', {}, '이 위치와 목적지 방향에서 찾은 후보가 없어요.') : routeResults.items.map((stop) => h('article', { className: 'route-result' }, h('h3', {}, stop.name), h('p', {}, `${stop.route} · 약 ${(stop.meters / 1000).toFixed(1)}km`), button('이 장소로 부탁 남기기', () => act(() => request('POST', '/requests', { by: car.id, text: `${stop.name}에 들러요`, when: 'now' }))), button('도착 할 일 확인', () => { routePlace = stop; arrival(); })))),
    h('div', { className: 'section-heading' }, h('h2', {}, '일행이 남긴 부탁')),
    trip.requests.map((r) => h('article', { className: 'route-result' }, h('p', {}, r.text), h('small', {}, REQ[r.status]?.[0] || r.status))),
    h('div', { className: 'section-heading' }, h('h2', {}, '장소별 할 일')),
    !todos.length ? h('p', { className: 'capture-footnote' }, '대화에서 확인한 장소별 할 일이 여기에 모여요.') : todos.map((item) => h('article', { className: 'route-result' }, h('h3', {}, item.place), h('p', {}, item.text), h('small', {}, item.status === 'done' ? '완료' : item.status === 'cancelled' ? '취소됨' : '남은 할 일'), h('details', {}, h('summary', {}, '대화 근거'), item.sources.map((s) => h('p', {}, s.displayText ?? s.text))), button(item.status === 'done' ? '다시 할 일로' : '완료 표시', () => act(() => request('PATCH', `/todos/${item.id}`, { generation: trip.generation, expectedVersion: item.version, status: item.status === 'done' ? 'pending' : 'done' }))))));
}
async function arrival() {
  if (!routePosition || !routePlace) return;
  if (!routeObservedAt) return toast('현재 위치 가져오기로 실제 위치를 확인한 뒤 도착 안내를 확인해 주세요.');
  await act(async () => {
    const result = await request('POST', '/arrival-briefing', { generation: trip.generation, place: { name: routePlace.name, lat: routePlace.lat, lng: routePlace.lng }, position: routePosition, parked: ['parked', 'ended'].includes(trip.status), observedAt: routeObservedAt, source: 'browser' });
    toast(result.eligible ? result.items.map((i) => i.text).join(' · ') || '이 장소에 남은 할 일이 없어요.' : `도착 안내 조건을 확인해 주세요 · ${result.reason}`);
  });
}

addEventListener('beforeunload', (event) => { if (recording || pendingCapture || processing || unsavedAudio || (input && !job)) { event.preventDefault(); event.returnValue = ''; } });
addEventListener('pagehide', () => {
  processing?.abort();
  const session = captureFence.current;
  if (pendingCapture) { lifecycle++; stopDevice(); return; }
  if (session) { session.accepting = false; session.device?.stop(); recording = null; paused = true; checkpoint(session).catch(() => {}); }
});
addEventListener('pageshow', (event) => { if (event.persisted) { lifecycle++; stopDevice(); processing = null; job = input = null; frames = []; frameCount = 0; draftLoaded = ''; refresh(true); } });
addEventListener('storage', (event) => {
  if (event.key !== KEY || event.newValue === JSON.stringify(car)) return;
  invalidateDraft().catch((e) => { error = e.message; }).finally(() => { try { car = JSON.parse(event.newValue || 'null'); } catch { car = null; } trip = null; rows = []; draftLoaded = ''; render(); refresh(true); });
});
setInterval(() => { const session = captureFence.current; if (recording && session) checkpoint(session).catch((e) => checkpointFailed(session, e)); }, 1000);
setInterval(() => { if (recording) updateStatus(); }, 100);
setInterval(() => refresh(), 2000);
render(); refresh(true);
