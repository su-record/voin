import { test } from "node:test";
import assert from "node:assert/strict";
import { addTranslations, isForeign } from "../lib/translation.mjs";

test("외국어 줄 가리기: 한글이 거의 없으면 외국어", () => {
  assert.equal(isForeign("Thanks for having us."), true);
  assert.equal(isForeign("日本のユーザー向けに準備します。"), true);
  assert.equal(isForeign("네 십일월 이십일 그대로 갑니다."), false);
  assert.equal(isForeign("패들 API로 결제 연동할게요"), false); // 영어 낱말이 섞인 한국어
  assert.equal(isForeign("OK"), false); // 너무 짧으면 번역하지 않음
  assert.equal(isForeign("123 456"), false);
});

const record = [
  "# 회의",
  "",
  "[00:00:00] **화자 1**: 안녕하세요.",
  "",
  "[00:00:05] **화자 2**: Thanks for having us.",
  "",
].join("\n");

test("외국어 줄 아래에 번역을 붙이고, 한국어 줄은 그대로", async () => {
  const out = await addTranslations(record, async (t) => `번역(${t})`);
  assert.equal(out, record.replace("Thanks for having us.\n", "Thanks for having us.\n↳ 번역(Thanks for having us.)\n"));
});

test("이미 번역한 줄은 다시 번역하지 않는다 (정리를 다시 해도 한 번만)", async () => {
  let calls = 0;
  const once = await addTranslations(record, async () => (calls++, "번역"));
  const twice = await addTranslations(once, async () => (calls++, "번역"));
  assert.equal(twice, once);
  assert.equal(calls, 1);
});

test("번역이 비거나 실패하면 그 줄은 건너뛴다", async () => {
  assert.equal(await addTranslations(record, async () => ""), record);
  await assert.rejects(addTranslations(record, async () => { throw new Error("모델 없음"); }), /모델 없음/);
});
