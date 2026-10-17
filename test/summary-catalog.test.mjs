import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendedSummaryModel, SUMMARY_CATALOG } from "../lib/summary-catalog.mjs";

test("맥 메모리별 추천", () => {
  assert.equal(recommendedSummaryModel(8).id, "qwen3.5-4b");
  assert.equal(recommendedSummaryModel(16).id, "gemma-4-e4b");
  assert.equal(recommendedSummaryModel(24).id, "gemma-4-12b");
  assert.equal(recommendedSummaryModel(64).id, "gemma-4-12b");
  assert.equal(recommendedSummaryModel(4).id, "qwen3.5-4b"); // 맞는 게 없어도 목록 첫 번째
});

test("목록: 모델마다 고정 커밋·체크섬과 장단점이 있다", () => {
  for (const m of SUMMARY_CATALOG) {
    assert.match(m.commit, /^[0-9a-f]{40}$/);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.pros.length && m.cons.length, m.id);
  }
});

test("쓸 모델은 사용자가 고른 것만: 고르지 않았거나 지웠으면 없음 (추천·설치된 다른 모델로 대신하지 않음)", async () => {
  const { chosenSummaryModel } = await import("../lib/summary-catalog.mjs");
  const installed = (ids) => (entry) => ids.includes(entry.id);
  assert.equal(chosenSummaryModel("gemma-4-e4b", installed(["gemma-4-e4b", "gemma-4-12b"]))?.id, "gemma-4-e4b");
  assert.equal(chosenSummaryModel("", installed(["gemma-4-12b"])), null);
  assert.equal(chosenSummaryModel(undefined, installed(["gemma-4-12b"])), null);
  assert.equal(chosenSummaryModel("gemma-4-e4b", installed(["gemma-4-12b"])), null); // 고른 모델을 지움
  assert.equal(chosenSummaryModel("없는-모델", installed(["gemma-4-12b"])), null);
});
