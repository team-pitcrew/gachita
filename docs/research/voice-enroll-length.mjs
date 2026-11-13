#!/usr/bin/env node
// 등록 길이(문장 수)별 화자 대조 정확도를 macOS 합성 음성으로 잰다(T38 할 일 4, ADR-0019).
//   node docs/research/voice-enroll-length.mjs   # macOS의 say가 있어야 한다(2분쯤)
// 목소리마다 등록 문장 1~3개로 등록값을 만들고, 등록에 쓰지 않은 발화를 대조한다.
// 결과는 표(마크다운)로 찍는다. 음성 파일은 임시 폴더에 만들고 지운다.
// 영어 문장인 까닭: 이 Mac에 받아진 한국어 음성은 Yuna 하나뿐이다. 참조 임베더는 음높이·스펙트럼만 봐
// 언어를 타지 않지만, 합성 음성이라 실제 가족의 구분 난이도를 대신하지는 못한다(ADR-0019).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { embed, similarity, wavMono } = await import(fileURLToPath(new URL("../../backend/api/providers/voice.js", import.meta.url)));
const THRESHOLD = 0.9; // providers/voice.js의 기본값과 같게

// 여자 8, 남자 8, 아이 1. 장난 음성(Bells, Zarvox 등)은 뺐다.
const VOICES = ["Samantha", "Karen", "Moira", "Tessa", "Flo", "Sandy", "Shelley", "Grandma", "Daniel", "Rishi", "Fred", "Ralph", "Eddy", "Reed", "Rocko", "Grandpa", "Junior"];
const ENROLL = ["Today our family is driving to the sea in Gangneung.", "I am reading this sentence slowly to register my voice.", "When we stop at the rest area I want a warm drink."];
const SHORT = ["Okay, sounds good.", "I need the toilet.", "I am hungry.", "Are we there yet?"]; // 1초 안팎
const LONG = ["Dad, when do we arrive? I am so sleepy.", "We have to stop at the market for milk and eggs.", "Look, I can see the sea, it is so pretty.", "Let us take a short break at the next rest area."]; // 2~3초

const dir = mkdtempSync(join(tmpdir(), "voice-bench-"));
let n = 0;
const speak = (voice, text) => {
  const file = join(dir, `${n++}.wav`);
  execFileSync("say", ["-v", voice, "-o", file, "--file-format=WAVE", "--data-format=LEI16@16000", text]);
  return wavMono(readFileSync(file)).samples;
};
const join2 = (parts) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
};

try {
  const enroll = Object.fromEntries(VOICES.map((v) => [v, ENROLL.map((t) => speak(v, t))]));
  const tests = Object.fromEntries(VOICES.map((v) => [v, { 짧은: SHORT.map((t) => speak(v, t)), 보통: LONG.map((t) => speak(v, t)) }]));
  const secs = (s) => s.length / 16000;
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const pct = (a) => `${Math.round(avg(a.map(Number)) * 100)}%`;

  console.log(`| 등록 | 발화 | 등록 길이 | 발화 길이 | 같은 목소리 유사도 | 다른 목소리 최고 유사도 | 기준을 넘은 발화 | ${VOICES.length}명 중 1등이 맞음 | 두 명 후보 · 맞힘 | 두 명 후보 · 틀림 | 두 명 후보 · 모름 | 말한 사람이 후보에 없음(두 명) · 잘못 붙임 |`);
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const k of [1, 2, 3]) {
    const prints = Object.fromEntries(VOICES.map((v) => [v, embed(join2(enroll[v].slice(0, k)))]));
    const enrollSecs = avg(VOICES.map((v) => secs(join2(enroll[v].slice(0, k)))));
    for (const kind of ["짧은", "보통"]) {
      const same = [], other = [], top = [], right = [], wrong = [], unknown = [], absent = [];
      const lens = [];
      for (const v of VOICES) {
        for (const s of tests[v][kind]) {
          lens.push(secs(s));
          const e = embed(s);
          const sims = Object.fromEntries(VOICES.map((w) => [w, similarity(e, prints[w])]));
          const others = VOICES.filter((w) => w !== v).map((w) => sims[w]);
          same.push(sims[v]);
          other.push(Math.max(...others));
          top.push(others.every((x) => x < sims[v]));
          // 후보가 둘(그 사람과 다른 한 명, 앞줄 두 자리처럼)일 때 서버의 판정: 높은 쪽이 기준을 넘으면 그 사람, 아니면 모름
          for (const x of others) {
            const best = Math.max(x, sims[v]);
            right.push(best >= THRESHOLD && sims[v] > x);
            wrong.push(best >= THRESHOLD && x >= sims[v]);
            unknown.push(best < THRESHOLD);
          }
          // 말한 사람이 후보에 없을 때(등록하지 않은 손님, 줄 판정이 틀림, 동의하지 않은 사람): 다른 두 사람 가운데 누가 기준을 넘으면 잘못 붙는다
          for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) absent.push(Math.max(others[i], others[j]) >= THRESHOLD);
        }
      }
      const passed = same.filter((x) => x >= THRESHOLD).length;
      console.log(`| ${k}문장 | ${kind} | ${enrollSecs.toFixed(1)}초 | ${avg(lens).toFixed(1)}초 | ${avg(same).toFixed(3)} | ${avg(other).toFixed(3)} | ${passed}/${same.length} | ${pct(top)} | ${pct(right)} | ${pct(wrong)} | ${pct(unknown)} | ${pct(absent)} |`);
    }
  }
  console.log(`\n목소리 ${VOICES.length}개(${VOICES.join(", ")}), 발화 종류마다 목소리당 ${SHORT.length}개. 두 명 후보는 그 목소리와 다른 ${VOICES.length - 1}개 각각의 쌍, 말한 사람이 없는 두 명 후보는 다른 목소리 둘의 조합(${((VOICES.length - 1) * (VOICES.length - 2)) / 2}개). 기준 ${THRESHOLD}.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
