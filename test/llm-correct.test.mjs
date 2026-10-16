import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { guardCorrection, editDistance, buildCorrectionMessages, correctWithLlm, ollamaStatus } from "../lib/llm-correct.mjs";
import { asrHintOptions, buildContextPrompt } from "../lib/asr-hints.mjs";

test("editDistance", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  assert.equal(editDistance("쿠버네티스", "쿠버네티스"), 0);
});

test("guard: 작은 교정은 받아들인다", () => {
  const r = guardCorrection("오늘 쿠버네티즈 배포 회의를 합니다", "오늘 쿠버네티스 배포 회의를 합니다");
  assert.equal(r.ok, true);
  assert.equal(r.reason, "corrected");
});
test("guard: 빈 답·길이 변화·크게 바뀐 답은 원문", () => {
  const src = "오늘 배포 회의를 합니다";
  assert.equal(guardCorrection(src, "  ").text, src);
  assert.equal(guardCorrection(src, `${src} 그리고 내일은 회고를 합니다`).reason, "length");
  assert.equal(guardCorrection(src, "금일 출시 미팅을 진행").ok, false);
  assert.equal(guardCorrection(src, `"${src}"`).reason, "unchanged");
});

test("prompt builder: 엄격한 지시와 사전", () => {
  const [sys, user] = buildCorrectionMessages("지피티 써요", [{ from: "지피티", to: "GPT" }, { to: "Sutory" }]);
  assert.match(sys.content, /Never add, remove/);
  assert.match(sys.content, /Output ONLY/);
  assert.match(sys.content, /지피티 → GPT/);
  assert.match(sys.content, /- Sutory/);
  assert.equal(user.content, "지피티 써요");
});

test("asr hints: vocabulary → context_prompt → none", () => {
  const mk = (f) => ({ supports: (x) => f.includes(x) });
  assert.deepEqual(asrHintOptions(mk(["vocabulary"]), ["GPT", "GPT"], { language: "ko" }).options, { language: "ko", vocabulary: ["GPT"] });
  assert.equal(asrHintOptions(mk(["context_prompt"]), ["GPT"]).options.prompt, "용어: GPT.");
  assert.equal(asrHintOptions(mk([]), ["GPT"]).hint, "none");
  assert.equal(asrHintOptions({ supports() { throw new Error("x"); } }, ["GPT"]).hint, "none");
  assert.ok(buildContextPrompt(Array(200).fill("abcdefghij")).length <= 410);
});

// 가짜 Ollama
let reply = "";
let seen = null;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "gemma4:e2b" }] }));
    seen = JSON.parse(body);
    if (seen.model !== "gemma4:e2b") return res.writeHead(404).end("{}");
    if (reply === "SLOW") return setTimeout(() => res.end("{}"), 500);
    res.end(JSON.stringify({ message: { role: "assistant", content: reply } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("mock ollama: 교정 적용, temperature 0", async () => {
  reply = "GPT로 회의록 써요";
  const r = await correctWithLlm("지피티로 회의록 써요", { baseUrl, dictionary: [{ from: "지피티", to: "GPT" }] });
  assert.equal(seen.options.temperature, 0);
  assert.equal(seen.stream, false);
  assert.equal(r.text, "GPT로 회의록 써요");
});
test("mock ollama: 엉뚱한 답이면 원문", async () => {
  reply = "완전히 다른 문장으로 바꿔서 대답했습니다 여기 있어요";
  assert.equal((await correctWithLlm("회의록 써요", { baseUrl })).text, "회의록 써요");
});
test("mock ollama: 모델 없음·시간 초과·꺼짐은 원문", async () => {
  assert.equal((await correctWithLlm("안녕", { baseUrl, model: "gemma4:e4b" })).reason, "model-missing");
  reply = "SLOW";
  assert.equal((await correctWithLlm("안녕", { baseUrl, timeoutMs: 100 })).reason, "timeout");
  assert.equal((await correctWithLlm("안녕", { baseUrl: "http://127.0.0.1:1" })).text, "안녕");
});
test("mock ollama: 상태", async () => {
  assert.deepEqual((await ollamaStatus("gemma4:e2b", { baseUrl })).model, true);
  assert.equal((await ollamaStatus("gemma4:e4b", { baseUrl })).model, false);
  assert.equal((await ollamaStatus("gemma4:e2b", { baseUrl: "http://127.0.0.1:1" })).ollama, false);
});
