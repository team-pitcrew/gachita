// style.css의 색 토큰이 글자 대비 기준(WCAG AA, 4.5:1)을 지키는지 검사한다.
// 실행: 저장소 루트에서 make check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("style.css", import.meta.url), "utf8");
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})(?![0-9a-f])/gi)].map((m) => [m[1], m[2]]));
const [light, dark] = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => tokens(m[1]));

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [글자색, 바탕색, 쓰이는 곳]
const PAIRS = [
  ["ink", "bg", "본문"],
  ["ink", "surface", "카드 본문"],
  ["ink-2", "bg", "보조 글"],
  ["ink-2", "surface", "카드 보조 글"],
  ["ink-2", "line", "비활성 단추"],
  ["on-accent", "accent-fill", "주 단추(민트 바탕에 먹색 글자)"],
  ["accent", "accent-soft", "보조 단추"],
  ["accent", "surface", "브랜드 글자(카드 위)"],
  ["rec", "bg", "기록 중 표시"],
  ["ok", "bg", "완료 표시"],
  ["warn", "bg", "기다림 표시"],
  ["ink", "surface-2", "묶음 안 글자"],
  ["ink-2", "surface-2", "묶음 안 보조 글"],
  ["accent", "bg", "브랜드 글자(바탕 위)"],
  ["surface", "ink", "고른 칩"],
  ["ok", "surface-2", "완료 알약"],
  ["rec", "surface-2", "기록 중 알약"],
  ["ink", "accent-soft", "기록·공유 결과 줄"],
  ["rec", "accent-soft", "기록·공유 오류 줄"],
  ["bg", "ink", "알림 띠"],
  ["ink-2", "accent-soft", "고른 장면·여행 요약의 보조 글, 막힌 주 단추"],
];

for (const [name, theme] of [["밝은 화면", light], ["어두운 화면", dark]]) {
  test(`${name}: 글자 대비 4.5:1 이상`, () => {
    for (const [fg, bg, where] of PAIRS) {
      assert.ok(theme[fg] && theme[bg], `${where}: 토큰 ${fg}·${bg}가 ${name}에 없어요`);
      const r = ratio(theme[fg], theme[bg]);
      assert.ok(r >= 4.5, `${where}(${fg} on ${bg}) ${r.toFixed(2)}:1`);
    }
  });
}
