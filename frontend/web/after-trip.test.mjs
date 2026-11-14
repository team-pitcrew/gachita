import assert from "node:assert/strict";
import { test } from "node:test";
import { audioStep, axisLabel, clip, clock, dayRange, densityBars, durationLabel, generationStages, itemProgress, mockUpload, offsetPct, sceneTitle, spanLabel, strongestLine, topScenes, tripClock } from "./after-trip.js";

// 시각은 이 컴퓨터의 시간대로 만든다(표시도 같은 시간대라 어디서 돌려도 같다).
const at = (h, m, s = 0, day = 14) => new Date(2026, 10, day, h, m, s).getTime();
const people = [
  { id: "dad", name: "아빠", seat: "ROW_1_LEFT" },
  { id: "kid", name: "서준", seat: "ROW_2_LEFT" },
];
const line = (time, text, participantId) => ({ at: time, text, displayText: text, ...(participantId ? { participantId } : {}) });

test("추천 장면은 서버 점수 상위 3개를 시각 순으로 보인다", () => {
  const items = [
    { from: 500, to: 900, score: 4 },
    { from: 100, to: 400, score: 9 },
    { from: 2000, to: 2400, score: 7 },
    { from: 1000, to: 1300, score: 9 },
    { from: 3000, to: 3300, score: 2 },
  ];
  assert.deepEqual(topScenes(items).map((s) => s.from), [100, 1000, 2000], "점수 9·9·7을 고르고 시각 순으로");
  assert.deepEqual(topScenes(items, 2).map((s) => s.from), [100, 1000]);
  assert.deepEqual(topScenes([{ from: 5, to: 9, score: 1 }, { from: 1, to: 9, score: 1 }], 1).map((s) => s.from), [1], "같은 점수면 앞선 장면");
  assert.deepEqual(topScenes([{ from: 9, to: 9, score: 9 }, { score: 9 }, null]), [], "구간이 없거나 길이 0인 후보는 뺀다");
  assert.deepEqual(topScenes(undefined), []);
});

test("장면 시각은 여행 시작 기준 HH:MM:SS, 시작 전은 0", () => {
  assert.equal(clock(0), "00:00:00");
  assert.equal(clock((12 * 60 + 4) * 1000 + 999), "00:12:04", "초 아래는 버린다");
  assert.equal(clock(((1 * 60 + 8) * 60 + 24) * 1000), "01:08:24");
  assert.equal(clock(-5000), "00:00:00");
  assert.equal(clock(NaN), "00:00:00");
  const start = at(9, 20);
  assert.equal(spanLabel(at(9, 32, 4), at(9, 32, 36), start), "00:12:04–00:12:36");
  assert.equal(axisLabel(((34 * 60) + 12) * 1000), "34:12", "파형 눈금은 시간이 없으면 분:초");
  assert.equal(axisLabel(4104_000), "1:08:24");
});

test("주행 시간과 날짜 범위", () => {
  assert.equal(durationLabel(4104), "1시간 8분");
  assert.equal(durationLabel(3600), "1시간");
  assert.equal(durationLabel(480), "8분");
  assert.equal(durationLabel(40.4), "40초");
  assert.equal(durationLabel(0), "", "모르면 말하지 않는다");
  assert.equal(dayRange(at(9, 20), at(10, 28)), "11월 14일 09:20–10:28");
  assert.equal(dayRange(at(9, 20), at(9, 20)), "11월 14일 09:20");
  assert.equal(dayRange(at(23, 50), at(0, 30, 0, 15)), "11월 14일 23:50 – 11월 15일 00:30", "날을 넘기면 양쪽에 날짜");
  assert.equal(dayRange(undefined, 1), "");
});

test("여행 시간축: 전체 음성의 시작·길이가 먼저, 없으면 발화, 장면이 넘치면 늘린다", () => {
  const lines = [line(at(9, 21), "출발"), line(at(10, 28), "도착")];
  const trip = { createdAt: at(9, 0) };
  assert.deepEqual(tripClock(trip, { state: "ready", startedAt: at(9, 20), seconds: 4104 }, lines), { origin: at(9, 20), end: at(9, 20) + 4104_000, seconds: 4104, fromAudio: true });
  assert.equal(tripClock(trip, { state: "uploading", startedAt: at(9, 20), seconds: 4104 }, lines).fromAudio, true, "올리는 중에도 차가 알린 길이를 쓴다");
  const fromLines = tripClock(trip, null, lines);
  assert.deepEqual([fromLines.origin, fromLines.seconds, fromLines.fromAudio], [at(9, 21), 67 * 60, false], "경로가 없으면(404) 첫·끝 발화");
  assert.equal(tripClock(trip, { state: "none" }, []).origin, at(9, 0), "아무것도 없으면 여행을 만든 때");
  assert.equal(tripClock({ ...trip, startedAt: at(9, 18) }, null, lines).origin, at(9, 18), "처음 출발한 때가 첫 발화보다 이르면 그때부터");
  assert.equal(tripClock({ ...trip, startedAt: at(9, 30) }, null, lines).origin, at(9, 21), "출발 전에 받아 적은 말이 있으면 그 말부터");
  assert.equal(tripClock(trip, { state: "uploading", previous: { startedAt: at(9, 19), seconds: 60 } }, []).origin, at(9, 19), "다시 올리는 중이면 앞의 전체 음성");
  assert.equal(tripClock(trip, null, lines, [{ from: at(10, 28), to: at(10, 29) }]).end, at(10, 29), "장면이 축 밖이면 축을 늘린다");
  assert.equal(tripClock(trip, null, [line(at(9, 21), "가"), { ...line(at(9, 22), "나"), endAt: at(9, 23) }]).end, at(9, 23), "발화 끝(endAt)까지");
});

test("올리기 진행률은 서버가 준 바이트로만, 경로가 없거나 시작 전이면 기다린다고만 말한다", () => {
  assert.deepEqual(audioStep(null), { kind: "waiting", percent: null, label: "차에서 음성을 올리기를 기다리고 있어요" }, "404");
  assert.equal(audioStep({ state: "none", receivedParts: 0, receivedBytes: 0, progress: 0 }).kind, "waiting");
  assert.equal(audioStep({ state: "none", deleted: true }).label, "전체 음성을 지웠어요");
  assert.deepEqual(audioStep({ state: "uploading", receivedParts: 9, receivedBytes: 820, expectedBytes: 1000, progress: 0.82 }), { kind: "uploading", percent: 82, label: "전체 음성 업로드 중  82%" });
  assert.equal(audioStep({ state: "uploading", receivedBytes: 1000, expectedBytes: 1000 }).percent, 99, "합치기 전에는 100%라 하지 않는다");
  assert.deepEqual(audioStep({ state: "uploading", receivedParts: 3, receivedBytes: 300, progress: 0 }), { kind: "uploading", percent: null, label: "전체 음성 업로드 중 · 조각 3개 받음" }, "전체 크기를 모르면 퍼센트를 지어내지 않는다");
  assert.deepEqual(audioStep({ state: "ready", seconds: 4104 }), { kind: "ready", percent: 100, label: "전체 음성 업로드 완료" });
});

test("mock: 실제 업로드가 꺼진 동안 P22 진행률은 연 때부터 시간으로 흉내 내고 mock 표시를 단다", () => {
  assert.equal(audioStep(mockUpload(0, 0, 10_000)).label, "전체 음성 업로드 중  0%");
  assert.equal(audioStep(mockUpload(0, 8_200, 10_000)).label, "전체 음성 업로드 중  82%");
  assert.deepEqual(mockUpload(0, 10_000, 10_000), { state: "ready", mock: true });
  assert.equal(mockUpload(0, 4_000, 10_000).mock, true);
  assert.equal(mockUpload(5_000, 0, 10_000).receivedBytes, 0, "시계가 거꾸로 가도 0 아래로 내려가지 않는다");
});

test("제목은 장면에서 가장 힘 있는 한 줄, 너무 짧으면 '이름의 한마디', 모르는 화자에게 이름을 붙이지 않는다", () => {
  const scene = { lines: [line(1, "바다 어디 있지", "dad"), line(2, "아빠, 아까부터 바다 보이는데?", "kid"), line(3, "어 정말이네 어디 어디 어디 어디 어디 있었지 진짜로 몰랐어", "dad")] };
  assert.equal(strongestLine(scene.lines, people).text, "아빠, 아까부터 바다 보이는데?", "물음표로 끝난 말이 긴 말을 이긴다(글자 수는 20자까지만 침)");
  assert.deepEqual(sceneTitle(scene, people), { title: "아빠, 아까부터 바다 보이는데?", quote: "아빠 “바다 어디 있지”", speakerId: "kid" });
  assert.deepEqual(sceneTitle({ lines: [line(1, "응", "dad"), line(2, "와!", "kid")] }, people), { title: "서준의 한마디", quote: "서준 “와!”", speakerId: "kid" });
  assert.deepEqual(sceneTitle({ lines: [line(1, "와!"), line(2, "응")] }, people), { title: "와!", quote: "“응”", speakerId: null }, "화자를 모르면 그 말 그대로");
  assert.deepEqual(sceneTitle({ lines: [line(1, "  "), line(2, "")] }, people), { title: "함께 나눈 이야기", quote: "", speakerId: null });
  assert.equal(sceneTitle({ lines: [line(1, "가나다라마바사아자차카타파하가나다라마바사아자차카타파하", "dad")] }, people).title.length, 24, "제목은 24자에서 줄임표");
  assert.equal(clip("가나다", 3), "가나다");
  assert.equal(clip("가나다라", 3), "가나…");
});

test("시간축 막대는 말한 양으로만, 말이 없던 칸은 0", () => {
  const bars = densityBars([line(0, "a"), line(10, "b"), line(15, "c"), line(19, "d"), line(25, "e"), line(99, "밖")], 0, 40, 4);
  assert.deepEqual(bars, [0.58, 1, 0.58, 0], "칸당 1·3·1·0, 최대 대비 제곱근");
  assert.deepEqual(densityBars([], 0, 40, 4), [0, 0, 0, 0]);
  assert.deepEqual(densityBars([line(5, "a")], 10, 10, 3), [0, 0, 0], "길이 0이면 빈 막대");
  assert.equal(offsetPct(15, 0, 40), 37.5, "파형 위 장면 표식 자리(%)");
  assert.equal(offsetPct(-5, 0, 40), 0);
  assert.equal(offsetPct(99, 0, 40), 100);
  assert.equal(offsetPct(5, 10, 10), 0, "길이 0");
});

test("생성 진행률은 장면별 실제 단계의 평균, 세 줄은 단계에 맞춘다", () => {
  assert.equal(itemProgress({ phase: "moment" }), 0);
  assert.equal(itemProgress({ phase: "voice", momentId: "m" }), 0.1);
  assert.equal(itemProgress({ phase: "render", momentId: "m", ready: true, progress: 0.5 }), 0.55);
  assert.equal(itemProgress({ phase: "save" }), 0.9);
  assert.equal(itemProgress({ phase: "voice", assetId: "a" }), 1, "보관한 영상이 있으면 완성");
  const items = [{ phase: "done", assetId: "a" }, { phase: "render", momentId: "m", ready: true, progress: 0.5 }, { phase: "voice", momentId: "n" }];
  const s = generationStages(items);
  assert.equal(s.voice, "음성 구간 준비 중 · 2/3");
  assert.equal(s.step, "캐릭터 배치와 자막 생성 중 · 2/3");
  assert.equal(s.content, "콘텐츠 생성 중  55%");
  assert.equal(s.done, 1);
  assert.equal(generationStages([{ phase: "voice", momentId: "m" }]).step, "차에서 음성 구간이 올라오기를 기다리고 있어요");
  assert.equal(generationStages([{ phase: "render", ready: true, progress: 0 }]).voice, "음성 구간 준비 완료");
  assert.equal(generationStages([{ phase: "save", ready: true }]).step, "콘텐츠 기록에 저장 중 · 1/1");
  assert.equal(generationStages([{ phase: "done", assetId: "a" }]).step, "모두 만들었어요");
  assert.equal(generationStages([{ phase: "failed", momentId: "m" }, { phase: "done", assetId: "a" }]).step, "1개를 만들지 못했어요");
  assert.equal(generationStages(items, "앱을 나가 만들기를 멈췄어요.").step, "앱을 나가 만들기를 멈췄어요.", "멈췄으면 까닭을 그대로");
});

// 차 이식(F5)과 같은 결과를 맞추는 시험 벡터: 서버 추천 후보(scenes.js) → 번호·시각·제목·대사.
test("scene-picks-vectors.json: 추천 후보에서 고른 3개의 번호·시각·제목·대사가 벡터와 같다", async () => {
  const { readFile } = await import("node:fs/promises");
  const v = JSON.parse(await readFile(new URL("./scene-picks-vectors.json", import.meta.url), "utf8"));
  const got = topScenes(v.items).map((p, i) => ({ number: i + 1, from: p.from, to: p.to, time: spanLabel(p.from, p.to, v.origin), ...sceneTitle(p, v.participants) }));
  assert.deepEqual(got, v.expected);
  assert.equal(v.items.length, 5, "서버는 5개까지 주고 폰은 점수 상위 3개만 보인다");
});
