// local-llm.mjs가 띄우는 모델 프로세스: 요청 { id, modelPath, instructions, transcript } → { id, text } | { id, error }
// 같은 모델은 한 번만 불러온다. 긴 기록은 나눠 정리한 뒤 합쳐 요약한다.
import { splitByTokens, stripThinking } from "./local-llm.mjs";

const OUTPUT_TOKENS = 2048;
const MAX_CONTEXT = 32768; // 이보다 긴 기록은 나눈다 (메모리를 받아쓰기 모델과 나눠 쓰므로)

let loaded = null; // { path, model }

async function loadModel(modelPath) {
  if (loaded?.path !== modelPath) {
    await unload();
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    loaded = { path: modelPath, model: await llama.loadModel({ modelPath }) };
  }
  return loaded.model;
}

async function unload() {
  const current = loaded;
  loaded = null;
  await current?.model.dispose();
}

async function ask(model, instructions, input) {
  const { LlamaChatSession } = await import("node-llama-cpp");
  const tokens = model.tokenize(input).length;
  const context = await model.createContext({ contextSize: Math.min(model.trainContextSize, tokens + OUTPUT_TOKENS + 1024) });
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: instructions });
    const raw = await session.prompt(input, { temperature: 0.2, maxTokens: OUTPUT_TOKENS, budgets: { thoughtTokens: 0 } });
    return stripThinking(raw);
  } finally {
    await context.dispose();
  }
}

const PART_INSTRUCTIONS = `너는 긴 녹음 기록의 한 부분을 정리한다. 이 부분에 나온 핵심 내용, 결정, 할 일(담당 화자·기한), 남은 질문을
화자 이름을 그대로 써서 빠짐없이 짧은 목록으로 적는다. 기록에 없는 내용은 만들지 않는다. 목록 밖의 말은 쓰지 않는다.`;

async function run(modelPath, instructions, transcript) {
  const model = await loadModel(modelPath);
  const limit = Math.min(model.trainContextSize, MAX_CONTEXT) - OUTPUT_TOKENS - 1024;
  const chunks = splitByTokens(transcript, (line) => model.tokenize(line).length, limit);
  if (chunks.length === 1) return ask(model, instructions, transcript);
  // 나눠서 정리한 뒤, 정리한 것들을 원래 지시대로 한 번 더 요약한다
  const parts = [];
  for (const [i, chunk] of chunks.entries()) parts.push(`## 부분 ${i + 1}/${chunks.length}\n${await ask(model, PART_INSTRUCTIONS, chunk)}`);
  return ask(model, instructions, `아래는 긴 기록을 부분별로 정리한 것이다. 이것을 하나의 기록으로 보고 요약하라.\n\n${parts.join("\n\n")}`);
}

process.on("message", async ({ id, modelPath, instructions, transcript }) => {
  try {
    process.send({ id, text: await run(modelPath, instructions, transcript) });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
// 서버가 끝나 연결이 끊기면 함께 끝낸다
process.on("disconnect", () => process.exit(0));
