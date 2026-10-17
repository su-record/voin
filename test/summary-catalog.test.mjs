import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendedSummaryModel, SUMMARY_CATALOG } from "../lib/summary-catalog.mjs";

test("맥 메모리별 추천", () => {
  assert.equal(recommendedSummaryModel(8).id, "midm-2.0-mini");
  assert.equal(recommendedSummaryModel(16).id, "gemma-4-e4b");
  assert.equal(recommendedSummaryModel(24).id, "gemma-4-12b");
  assert.equal(recommendedSummaryModel(64).id, "gemma-4-12b");
  assert.equal(recommendedSummaryModel(4).id, "midm-2.0-mini"); // 맞는 게 없어도 가장 작은 것
});

test("목록: 모델마다 고정 커밋·체크섬과 장단점이 있다", () => {
  for (const m of SUMMARY_CATALOG) {
    assert.match(m.commit, /^[0-9a-f]{40}$/);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.pros.length && m.cons.length, m.id);
  }
});
