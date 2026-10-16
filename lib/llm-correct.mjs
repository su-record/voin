// 받아쓰기 모드 선택 기능: 로컬 Ollama(Gemma 4)로 잘못 들린 낱말·맞춤법만 고친다.
// 결과가 원문과 너무 다르면 원문을 쓴다. Ollama가 꺼져 있거나 모델이 없으면 조용히 건너뛴다.
export const OLLAMA_URL = "http://localhost:11434";
export const LLM_MODELS = ["gemma4:e2b", "gemma4:e4b", "gemma4:e2b-mlx", "gemma4:e4b-mlx"];
export const DEFAULT_LLM_MODEL = "gemma4:e2b";
export const GUARD = { maxEditRatio: 0.3, maxLengthChange: 0.2 };

export function buildCorrectionMessages(text, dictionary = []) {
  const terms = dictionary.map((e) => (e.from && e.from !== e.to ? `${e.from} → ${e.to}` : e.to)).filter(Boolean);
  const system = [
    "You are a speech-recognition proofreader. Fix ONLY misrecognized words and spelling mistakes.",
    "Never add, remove, reorder, summarize, translate or rephrase content. Keep the language, punctuation style and spacing.",
    "If nothing needs fixing, return the input unchanged.",
    "Output ONLY the corrected text, with no quotes, notes or explanations.",
    terms.length ? `Use this dictionary for correct spellings of terms:\n${terms.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: text },
  ];
}

export function editDistance(a, b) {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

// 모델 답을 받아들일지 판단한다. { ok, text, reason }
export function guardCorrection(original, candidate, guard = GUARD) {
  const src = original.trim();
  const out = String(candidate ?? "").trim().replace(/^["“'`]+|["”'`]+$/g, "").trim();
  if (!out) return { ok: false, text: original, reason: "empty" };
  if (out === src) return { ok: true, text: src, reason: "unchanged" };
  const srcLen = [...src].length || 1;
  if (Math.abs([...out].length - srcLen) / srcLen > guard.maxLengthChange) return { ok: false, text: original, reason: "length" };
  if (editDistance(src, out) / srcLen > guard.maxEditRatio) return { ok: false, text: original, reason: "edit-distance" };
  return { ok: true, text: out, reason: "corrected" };
}

async function fetchJson(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// Ollama와 모델 상태: { ollama: bool, model: bool, models: [...] }
export async function ollamaStatus(model = DEFAULT_LLM_MODEL, { baseUrl = OLLAMA_URL, timeoutMs = 1500 } = {}) {
  try {
    const { models = [] } = await fetchJson(`${baseUrl}/api/tags`, {}, timeoutMs);
    const names = models.map((m) => m.name ?? m.model).filter(Boolean);
    const want = model.includes(":") ? model : `${model}:latest`;
    return { ollama: true, model: names.includes(want), models: names };
  } catch {
    return { ollama: false, model: false, models: [] };
  }
}

const logged = new Set();
function logOnce(key, message) {
  if (logged.has(key)) return;
  logged.add(key);
  console.log(message);
}

// 고친 글(또는 원문)을 돌려준다. 실패해도 절대 throw하지 않는다.
export async function correctWithLlm(text, { dictionary = [], model = DEFAULT_LLM_MODEL, baseUrl = OLLAMA_URL, timeoutMs = 3000, guard = GUARD } = {}) {
  if (!text?.trim()) return { text, applied: false, reason: "empty-input" };
  try {
    const data = await fetchJson(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: buildCorrectionMessages(text, dictionary), stream: false, think: false, keep_alive: "10m", options: { temperature: 0 } }),
    }, timeoutMs);
    const result = guardCorrection(text, data?.message?.content);
    if (!result.ok) logOnce(`guard-${result.reason}`, `[llm-correct] 결과가 원문과 너무 달라 원문을 씁니다 (${result.reason})`);
    return { text: result.text, applied: result.ok && result.reason === "corrected", reason: result.reason };
  } catch (error) {
    const reason = error.status === 404 ? "model-missing" : error.name === "TimeoutError" ? "timeout" : "unavailable";
    logOnce(reason, `[llm-correct] 건너뜀: ${reason === "model-missing" ? `모델 ${model} 없음 (ollama pull ${model})` : reason === "timeout" ? "시간 초과" : "Ollama가 실행 중이 아님"}`);
    return { text, applied: false, reason };
  }
}
