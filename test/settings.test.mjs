import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, saveDir, saveLocationChosen } from "../lib/settings.mjs";

test("처음에는 저장 위치가 정해져 있지 않다 (사용자가 고른다)", () => {
  assert.equal(DEFAULTS.customFolder, "");
  assert.equal(DEFAULTS.obsidianVault, "");
  assert.deepEqual(DEFAULTS.reviewedPages, []); // 처음에는 모든 설정 항목이 회색
  assert.equal(saveLocationChosen(DEFAULTS), false);
  assert.throws(() => saveDir(DEFAULTS), /저장 위치/);
});

test("폴더나 보관함을 고르면 정해진 것", () => {
  assert.equal(saveLocationChosen({ ...DEFAULTS, customFolder: "~/Notes" }), true);
  assert.equal(saveLocationChosen({ ...DEFAULTS, saveMode: "obsidian", obsidianVault: "/vault" }), true);
  assert.equal(saveLocationChosen({ ...DEFAULTS, saveMode: "obsidian" }), false);
  assert.match(saveDir({ ...DEFAULTS, customFolder: "/tmp/notes" }), /\/tmp\/notes$/);
});
