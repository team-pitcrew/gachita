// 할 일 행동 항목 규칙(place-rules-v2, T141)의 공유 시험 벡터. 차량 포팅도 같은 파일(todo-vectors.json)을 읽어 맞춘다.
// 규칙을 고치면 이 시험이 깨진다 — 두 구현을 함께 고치고 파일을 다시 만든다(만드는 법은 파일의 about).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deriveTodos, TODO_METHOD } from "./todos.js";

const vectors = JSON.parse(readFileSync(new URL("todo-vectors.json", import.meta.url), "utf8"));

test("공유 시험 벡터: 발화 → 장소·분류·제목·물건·수량·요청한 사람이 파일과 같다", () => {
  assert.equal(vectors.method, TODO_METHOD);
  assert.ok(vectors.cases.length >= 15);
  for (const { name, lines, todos } of vectors.cases) {
    const got = deriveTodos(lines).map(({ id, place, text, category, title, items, requestedBy, method }) => ({ id, place, text, category, title, items, requestedBy, method }));
    assert.deepEqual(got, todos, name);
  }
});
