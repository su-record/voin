// 받아쓰기 전에 용어 사전을 모델에 힌트로 준다 (transcribe-cpp).
// vocabulary(용어 목록)를 먼저 쓰고, 없으면 context_prompt(맥락 문장)로, 둘 다 없으면 힌트 없이 받아쓴다.
// 참고: voin의 받아쓰기는 transcribe-cpp만 쓴다. sherpa-onnx는 화자 분리에만 써서 sherpa 핫워드는 해당 없음.
const MAX_TERMS = 100;
const MAX_PROMPT_CHARS = 400;

function supports(model, feature) {
  try {
    return Boolean(model?.supports?.(feature));
  } catch {
    return false;
  }
}

export function buildContextPrompt(terms) {
  let out = "";
  for (const t of terms) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > MAX_PROMPT_CHARS) break;
    out = next;
  }
  return out ? `용어: ${out}.` : "";
}

// 반환: { options, hint: "vocabulary" | "context_prompt" | "none" }
export function asrHintOptions(model, terms, base = {}) {
  const list = [...new Set((terms ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, MAX_TERMS);
  const options = { ...base };
  if (!list.length) return { options, hint: "none" };
  if (supports(model, "vocabulary")) return { options: { ...options, vocabulary: list }, hint: "vocabulary" };
  if (supports(model, "context_prompt")) {
    const prompt = buildContextPrompt(list);
    if (prompt) return { options: { ...options, prompt }, hint: "context_prompt" };
  }
  return { options, hint: "none" };
}
