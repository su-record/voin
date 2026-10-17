import { test } from "node:test";
import assert from "node:assert/strict";
import { bestModel, chooseModel, modelVersion, rankModels } from "../lib/model-ranking.mjs";

test("버전: 이름 속 숫자를 읽고 날짜 꼬리는 버린다", () => {
  assert.equal(modelVersion("claude-sonnet-5-5"), 5.5);
  assert.equal(modelVersion("claude-sonnet-4-5-20250929"), 4.5);
  assert.equal(modelVersion("gpt-5.1"), 5.1);
  assert.equal(modelVersion("gemini-2.5-pro"), 2.5);
  assert.equal(modelVersion("grok-4.3"), 4.3);
  assert.equal(modelVersion("gpt-4o"), 4);
  assert.equal(modelVersion("gpt-oss-120b"), 0); // 120b는 버전이 아니라 모델 크기
  assert.equal(modelVersion("gemma-4-31b-it"), 4);
});

test("자동: 가장 새 버전의 주력 모델, 요약에 안 맞는 모델과 mini는 뺀다", () => {
  const openai = ["gpt-4o", "gpt-5-mini", "gpt-5.1", "gpt-5", "whisper-1", "text-embedding-3-large", "gpt-5.1-2025-11-13", "gpt-image-1"];
  assert.equal(bestModel("openai", openai), "gpt-5.1");
  assert.equal(bestModel("openai", ["gpt-oss-120b", "gpt-5.1", "gpt-oss-20b"]), "gpt-5.1");
  assert.equal(bestModel("xai", ["grok-4.3", "grok-4.5", "grok-4.5-mini", "grok-imagine-image"]), "grok-4.5");
});

test("자동: 회사별 등급 (Claude는 sonnet, Gemini는 pro)", () => {
  const anthropic = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-4-5-20250929", "claude-fable-5-1"];
  assert.equal(bestModel("anthropic", anthropic), "claude-sonnet-5-5");
  const gemini = ["gemini-2.5-pro", "gemini-3.1-pro", "gemini-3.1-flash", "gemini-3.1-flash-lite"];
  assert.equal(bestModel("gemini", gemini), "gemini-3.1-pro");
  // 새 세대가 등급 이름을 바꿔도(pro 없음) 새 세대를 고른다. 같은 목록의 공개 소형 모델(Gemma)은 뺀다
  assert.equal(bestModel("gemini", [...gemini, "gemini-4-argon", "gemma-4-31b-it"]), "gemini-4-argon");
  assert.equal(bestModel("openai", ["gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-sol-pro", "gpt-oss-120b"]), "gpt-6.1-sol");
});

test("등급에 맞는 모델이 없으면 새 버전 아무거나", () => {
  assert.equal(bestModel("anthropic", ["claude-opus-6", "claude-haiku-5-5"]), "claude-opus-6");
  assert.equal(bestModel("openrouter", []), null);
});

test("순위: 새 버전이 앞", () => {
  assert.deepEqual(rankModels("openai", ["gpt-4.1", "gpt-5", "gpt-4o"]), ["gpt-5", "gpt-4.1", "gpt-4o"]);
});

test("고른 모델: 목록에 있으면 그대로, 새 모델이 있으면 알림, 없어졌으면 자동으로 대신", () => {
  const available = ["gpt-5", "gpt-5.1"];
  assert.deepEqual(chooseModel({ providerId: "openai", pinned: "", available }), { model: "gpt-5.1", auto: true });
  assert.deepEqual(chooseModel({ providerId: "openai", pinned: "gpt-5", available }), { model: "gpt-5", newer: "gpt-5.1" });
  assert.deepEqual(chooseModel({ providerId: "openai", pinned: "gpt-5.1", available }), { model: "gpt-5.1" });
  assert.deepEqual(chooseModel({ providerId: "openai", pinned: "gpt-4.5-preview", available }), { model: "gpt-5.1", auto: true, retired: "gpt-4.5-preview" });
  // 목록을 아직 못 받았으면 고른 것을 그대로 쓴다
  assert.deepEqual(chooseModel({ providerId: "openai", pinned: "gpt-5", available: null }), { model: "gpt-5" });
});
