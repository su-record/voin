// 요약 모델 비교 시험: voin이 실제로 쓰는 요약 경로(local-llm.mjs + 요약 지시문)로 GGUF 모델들을 같은 기록에 돌린다.
//   node scripts/compare-summary-models.mjs <기록.md> <모델.gguf>...
// 기록은 samples/5명-합성회의-정답포함.wav를 voin으로 불러와 만든 것을 쓰고, 결과는 samples/5명-합성회의-정답.md의 정답과 비교한다.
// 결과 요약은 summary-compare/에 모델별로 남긴다 (시간·최대 메모리는 화면에).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "summary-compare");
const [record, ...models] = process.argv.slice(2);

// 모델 하나를 따로 띄운 프로세스에서 돌린다 (메모리를 모델마다 따로 재고, 앞 모델이 남긴 메모리가 섞이지 않게)
async function runOne(modelPath) {
  const { summarizeLocal } = await import("../lib/local-llm.mjs");
  const { transcriptOf } = await import("../lib/meeting-record.mjs");
  const instructions = fs.readFileSync(path.join(ROOT, "lib/summarizer.mjs"), "utf8").match(/const INSTRUCTIONS = `([\s\S]*?)`;/)[1];
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 200);
  const started = Date.now();
  const text = await summarizeLocal(modelPath, instructions, transcriptOf(record));
  clearInterval(sampler);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${path.basename(modelPath, ".gguf")}.md`), `${text}\n`);
  console.log(`${path.basename(modelPath)}\t${seconds}s\t최대 메모리 ${(peak / 1e9).toFixed(1)}GB`);
  process.exit(0);
}

if (process.env.COMPARE_ONE) await runOne(process.env.COMPARE_ONE);
else if (!record || !models.length) console.log("사용법: node scripts/compare-summary-models.mjs <기록.md> <모델.gguf>...");
else {
  for (const model of models) {
    spawnSync(process.execPath, [fileURLToPath(import.meta.url), record], { env: { ...process.env, COMPARE_ONE: model }, stdio: "inherit" });
  }
  console.log(`\n요약: ${OUT_DIR}/ (samples/5명-합성회의-정답.md와 비교)`);
}
