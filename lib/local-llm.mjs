// voin 내장 요약 모델: 내려받은 GGUF를 이 맥 안에서 돌린다 (node-llama-cpp, Metal GPU).
// 한 번에 한 요청씩, 마지막으로 쓴 뒤 5분이 지나면 메모리를 비운다. 긴 기록은 나눠 요약한 뒤 합친다.
const IDLE_UNLOAD_MS = 5 * 60 * 1000;
const OUTPUT_TOKENS = 2048;
const MAX_CONTEXT = 32768; // 이보다 긴 기록은 나눈다 (메모리를 받아쓰기 모델과 나눠 쓰므로)

let loaded = null; // { path, model }
let unloadTimer = null;
let queue = Promise.resolve();

// 줄 단위로 maxTokens를 넘지 않게 나눈다. 한 줄이 한도보다 길면 그 줄만 한 덩어리
export function splitByTokens(text, countTokens, maxTokens) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of text.split("\n")) {
    const n = countTokens(line) + 1;
    if (current.length && size + n > maxTokens) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += n;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

// 생각 과정을 함께 내놓는 모델(Gemma 4의 <channel|>, Qwen의 <think>)에서 답만 남긴다.
// 작은 모델이 "- 없음"을 목록 기호와 겹쳐 쓰는 것(- - 없음)도 바로잡는다
export function stripThinking(text) {
  const marker = "<channel|>";
  const answer = text.includes(marker) ? text.slice(text.lastIndexOf(marker) + marker.length) : text;
  return answer
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^(\s*)- - /gm, "$1- ")
    .trim();
}

async function loadModel(modelPath) {
  clearTimeout(unloadTimer);
  if (loaded?.path !== modelPath) {
    await unload();
    const { getLlama } = await import("node-llama-cpp"); // 쓸 때만 불러온다 (앱 시작을 늦추지 않게)
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

export function summarizeLocal(modelPath, instructions, transcript) {
  const job = queue.then(() => run(modelPath, instructions, transcript));
  queue = job.catch(() => {}).finally(() => {
    clearTimeout(unloadTimer);
    unloadTimer = setTimeout(() => queue.then(unload), IDLE_UNLOAD_MS);
  });
  return job;
}
