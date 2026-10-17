import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pickLang, setLang, t } from "../lib/i18n.mjs";
import en from "../lib/locales/en.mjs";
import ja from "../lib/locales/ja.mjs";

test("언어 고르기: 시스템 언어 중 한·영·일 첫 번째, 없으면 영어", () => {
  assert.equal(pickLang(["ja-JP", "en-US"]), "ja");
  assert.equal(pickLang(["fr-FR", "ko-KR"]), "ko");
  assert.equal(pickLang(["de-DE"]), "en");
  assert.equal(pickLang([]), "en");
});

test("번역: 자리 표시를 값으로 바꾸고, 한국어는 원문 그대로", () => {
  setLang("ko");
  assert.equal(t("{name} 불러오는 중…", { name: "Whisper" }), "Whisper 불러오는 중…");
  setLang("en");
  assert.equal(t("사전에 없는 문구"), "사전에 없는 문구");
  setLang("ko");
});

// 코드 속 t("…")·t(`…`) 문구와 index.html의 한국어 글이 영어·일본어 사전에 모두 있는지
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
function sourceKeys() {
  const files = ["public/app.js", "server.mjs", ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`)];
  const keys = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\bt\(\s*(["`])((?:\\.|(?!\1).)*?)\1/gs)) keys.add(m[2].replace(/\\(["`\\])/g, "$1").replace(/\\n/g, "\n"));
  }
  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8").replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/g, "");
  // 태그(속성 값 안의 ">" 포함)를 통째로 잘라 낸 사이의 글 조각, 그리고 번역하는 속성 값
  const tag = /<(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
  for (const text of html.split(tag)) if (/[가-힣]/.test(text)) keys.add(decode(text.trim()));
  for (const t of html.match(tag) ?? []) for (const m of t.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*[가-힣][^"]*)"/g)) keys.add(decode(m[1]));
  return [...keys].filter((k) => /[가-힣]/.test(k));
}
const decode = (s) => s.replace(/&#10;/g, "\n").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

for (const [name, dict] of [["en", en], ["ja", ja]]) {
  test(`사전 ${name}: 화면 문구가 모두 번역되어 있다`, () => {
    const missing = sourceKeys().filter((k) => !(k in dict));
    assert.deepEqual(missing, [], `${name}에 없는 문구 ${missing.length}개`);
  });
  test(`사전 ${name}: 자리 표시({…})가 원문과 같다`, () => {
    const bad = Object.entries(dict).filter(([k, v]) => (k.match(/\{\w+\}/g) ?? []).sort().join() !== (v.match(/\{\w+\}/g) ?? []).sort().join());
    assert.deepEqual(bad.map(([k]) => k), []);
  });
}
