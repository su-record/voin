import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDataDir } from "../lib/data-dir.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "voin-data-"));
}

test("예전 폴더를 새 폴더로 옮기고, 정리 대기 작업의 음성 경로도 고친다", () => {
  const root = tempRoot();
  const from = path.join(root, "MeetingNotes");
  const to = path.join(root, "voin");
  fs.mkdirSync(path.join(from, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(from, "settings.json"), "{}");
  const job = { filePath: "/vault/a.md", wavFiles: { mic: path.join(from, "tmp/x-mic.wav") } };
  fs.writeFileSync(path.join(from, "tmp/x.json"), JSON.stringify(job));

  assert.equal(migrateDataDir(from, to), true);
  assert.ok(!fs.existsSync(from));
  assert.ok(fs.existsSync(path.join(to, "settings.json")));
  const moved = JSON.parse(fs.readFileSync(path.join(to, "tmp/x.json"), "utf8"));
  assert.equal(moved.wavFiles.mic, path.join(to, "tmp/x-mic.wav"));
  assert.equal(moved.filePath, "/vault/a.md");
});

test("새 폴더가 이미 있거나 예전 폴더가 없으면 건드리지 않는다", () => {
  const root = tempRoot();
  const from = path.join(root, "MeetingNotes");
  const to = path.join(root, "voin");
  assert.equal(migrateDataDir(from, to), false);
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  assert.equal(migrateDataDir(from, to), false);
  assert.ok(fs.existsSync(from));
});
