// 이 맥 안에서 요약하는 모델 (무료, 기록이 밖으로 나가지 않음). 받아쓰기 모델처럼 내려받아 쓴다(model-store.mjs).
// Hugging Face의 GGUF 파일을 커밋·SHA-256으로 고정해 받는다. 모두 상업 이용이 허용된 라이선스(Apache 2.0)다.
// minMemoryGB: 받아쓰기 모델과 함께 돌려도 버틸 맥 메모리. 장단점은 실제 회의 기록으로 비교한 뒤 채운다.
export const SUMMARY_CATALOG = [
  {
    id: "gemma-4-e2b",
    name: "Gemma 4 E2B",
    family: "Google",
    repo: "unsloth/gemma-4-E2B-it-GGUF",
    commit: "0314792d7f1f7e229411f620751375812bb9faf2",
    file: "gemma-4-E2B-it-Q4_K_M.gguf",
    size: 3106738272,
    sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
    license: "Apache 2.0",
    minMemoryGB: 8,
    pros: ["가장 가벼운 축이라 메모리 8GB 맥에서도 돈다"],
    cons: ["작은 모델이라 긴 회의에서 할 일·결정을 빠뜨릴 수 있다"],
  },
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    family: "Google",
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    commit: "bfc15c382204943c3a8fff0c750b94ae2364d7a3",
    file: "gemma-4-E4B-it-Q4_K_M.gguf",
    size: 4977171584,
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
    license: "Apache 2.0",
    minMemoryGB: 16,
    pros: ["E2B보다 크고 같은 계열"],
    cons: ["메모리 16GB 이상 권장"],
  },
  {
    id: "qwen3.5-4b",
    name: "Qwen3.5 4B",
    family: "Alibaba",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    commit: "e87f176479d0855a907a41277aca2f8ee7a09523",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    size: 2740937888,
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    license: "Apache 2.0",
    minMemoryGB: 8,
    pros: ["가장 작은 파일 (2.7GB)"],
    cons: ["작은 모델이라 긴 회의에서 할 일·결정을 빠뜨릴 수 있다"],
  },
  {
    id: "qwen3.5-9b",
    name: "Qwen3.5 9B",
    family: "Alibaba",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    commit: "3885219b6810b007914f3a7950a8d1b469d598a5",
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    size: 5680522464,
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    license: "Apache 2.0",
    minMemoryGB: 16,
    pros: ["4B보다 크고 같은 계열"],
    cons: ["메모리 16GB 이상 권장"],
  },
  {
    id: "gpt-oss-20b",
    name: "gpt-oss 20B",
    family: "OpenAI",
    repo: "unsloth/gpt-oss-20b-GGUF",
    commit: "d449b42d93e1c2c7bda5312f5c25c8fb91dfa9b4",
    file: "gpt-oss-20b-Q4_K_M.gguf",
    size: 11624759488,
    sha256: "c27536640e410032865dc68781d80a08b98f8db5e93575919af8ccc0568aeb4f",
    license: "Apache 2.0",
    minMemoryGB: 24,
    pros: ["목록에서 가장 큰 모델"],
    cons: ["파일 11.6GB, 메모리 24GB 이상 필요"],
  },
];

export const findSummaryModel = (id) => SUMMARY_CATALOG.find((m) => m.id === id);

// 이 맥 메모리에 맞는 추천: 돌릴 수 있는 것 중 가장 큰 모델 (실측 후 바꿀 수 있게 한 곳에 둔다)
export function recommendedSummaryModel(memoryGB) {
  const fits = SUMMARY_CATALOG.filter((m) => m.minMemoryGB <= memoryGB);
  return fits.sort((a, b) => b.minMemoryGB - a.minMemoryGB || b.size - a.size)[0] ?? SUMMARY_CATALOG[0];
}
