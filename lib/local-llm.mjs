// voin 내장 요약 모델: 내려받은 GGUF를 이 맥 안에서 돌린다 (node-llama-cpp, Metal GPU).
// 서버와 따로 띄운 프로세스(local-llm-worker.mjs)에서 돌린다: 받아쓰기 엔진(transcribe-cpp)과 한 프로세스에 함께
// 올리면 두 엔진의 ggml이 부딪혀 서버가 죽는다(종료 코드 139). 모델 쪽이 죽어도 서버와 녹음은 살아남는다.
// 한 번에 한 요청씩, 마지막으로 쓴 뒤 5분이 지나면 프로세스를 끝내 메모리를 돌려준다.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t } from "./i18n.mjs";

const WORKER = fileURLToPath(new URL("./local-llm-worker.mjs", import.meta.url));
const IDLE_EXIT_MS = 5 * 60 * 1000;

let worker = null; // { child, pending: Map<id, { resolve, reject }> }
let nextId = 0;
let idleTimer = null;
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

function startWorker() {
  const child = fork(WORKER, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const current = { child, pending: new Map() };
  child.on("message", ({ id, text, error }) => {
    const job = current.pending.get(id);
    current.pending.delete(id);
    if (error) job?.reject(new Error(error));
    else job?.resolve(text);
  });
  child.on("exit", (code, signal) => {
    if (worker === current) worker = null;
    for (const job of current.pending.values()) job.reject(new Error(t("내장 모델이 비정상 종료되었습니다 ({code})", { code: signal ?? code })));
    current.pending.clear();
  });
  return current;
}

function request(modelPath, instructions, transcript) {
  worker ??= startWorker();
  const { child, pending } = worker;
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.send({ id, modelPath, instructions, transcript });
  });
}

export function summarizeLocal(modelPath, instructions, transcript) {
  clearTimeout(idleTimer);
  const job = queue.then(() => request(modelPath, instructions, transcript));
  queue = job.catch(() => {}).finally(() => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => queue.then(() => worker?.child.kill()), IDLE_EXIT_MS);
  });
  return job;
}

// 앱을 끝낼 때 모델 프로세스도 함께 끝낸다
process.on("exit", () => worker?.child.kill());
