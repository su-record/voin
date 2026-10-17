import { test } from "node:test";
import assert from "node:assert/strict";
import { splitByTokens, stripThinking } from "../lib/local-llm.mjs";

const count = (text) => text.length; // 글자 수를 토큰 수로 친다 (시험용)

test("나누기: 한도 안이면 그대로 한 덩어리", () => {
  assert.deepEqual(splitByTokens("a\nb\nc", count, 100), ["a\nb\nc"]);
});

test("나누기: 줄 단위로 한도를 넘지 않게 나눈다", () => {
  const text = ["1111", "2222", "3333", "4444"].join("\n");
  assert.deepEqual(splitByTokens(text, count, 10), ["1111\n2222", "3333\n4444"]);
});

test("나누기: 한 줄이 한도보다 길면 그 줄만 따로", () => {
  assert.deepEqual(splitByTokens("12\n123456789012\n34", count, 10), ["12", "123456789012", "34"]);
});

test("생각 과정 지우기: Gemma 4의 <channel|> 앞과 <think> 블록", () => {
  assert.equal(stripThinking("생각...<channel|>요약"), "요약");
  assert.equal(stripThinking("<think>음</think>\n요약"), "요약");
  assert.equal(stripThinking("요약"), "요약");
});

test("작은 모델이 지시문의 '- 없음'을 목록 기호와 겹쳐 쓴 것(- - 없음)을 바로잡는다", () => {
  assert.equal(stripThinking("### 남은 질문\n- - 없음"), "### 남은 질문\n- 없음");
});
