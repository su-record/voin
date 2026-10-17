// 이 맥 안에서 요약하는 모델 (무료, 기록이 밖으로 나가지 않음). 받아쓰기 모델처럼 내려받아 쓴다(model-store.mjs).
// Hugging Face의 GGUF 파일을 커밋·SHA-256으로 고정해 받는다. 모두 상업 이용이 허용된 라이선스다.
// 장단점·시간은 2026-10-17 시험 결과다: 결정 6·할 일 5·남은 질문 3을 심어 둔 6분 40초 합성 회의(5명, 유나 음성 변조)를
// voin으로 받아쓴 기록(받아쓰기 오류 포함)을 voin 요약 지시문으로 요약했다. M 시리즈 24GB 맥, 모델마다 1회.
// 같은 시험에서 뺀 모델: gpt-oss 20B(기한의 달을 모두 틀림), Gemma 4 E2B(달을 틀리고 결정 3개 놓침),
// LFM2.5 8B-A1B(요약 대신 기록을 베낌), A.X 3.1 Light·Qwen3.5 4B(결정 여럿 놓침), Mi:dm 2.0 Base(Mini보다 낫지 않음).
// 라이선스 때문에 뺀 모델: Kanana(기기 탑재 판매는 별도 계약), HyperCLOVA X SEED(경쟁 서비스 조항), EXAONE(상업 금지).
// minMemoryGB: 받아쓰기 모델과 함께 돌려도 버틸 맥 메모리 (시험 때 최대 사용량: Mini 3.0GB, 9B 5.9GB, E4B 5.8GB, 12B 8.8GB)
export const SUMMARY_CATALOG = [
  {
    id: "midm-2.0-mini",
    name: "Mi:dm 2.0 Mini",
    family: "KT",
    repo: "mykor/Midm-2.0-Mini-Instruct-gguf",
    commit: "152690816d5f03763fa32869c651c99a6d7c300f",
    file: "Midm-2.0-Mini-Instruct-Q4_K_M.gguf",
    size: 1426272640,
    sha256: "7a945a20ceae202ab7a96d461fa9c3710e62deaffd6654c2106ab5e813fd8225",
    license: "MIT",
    minMemoryGB: 8,
    pros: ["가장 작고 빠름 (6분 회의 요약 8초, 파일 1.4GB)", "한국어 특화 모델이라 작아도 결정 6개 중 5개를 찾음", "메모리 8GB 맥에서도 돈다"],
    cons: ["기한이 바뀐 할 일(\"금요일, 아니 수요일\")을 놓침", "남은 질문을 일부 빠뜨림", "KT 원본을 다른 사람이 변환한 파일"],
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
    pros: ["할 일 5개를 기한까지 모두 맞힘", "Gemma 4 E4B보다 빠름 (6분 회의 23초)"],
    cons: ["출시일 결정을 놓치고 남은 질문 하나를 빠뜨림"],
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
    pros: ["할 일 5개·남은 질문 3개를 모두 맞힘", "Qwen3.5 9B보다 파일이 작음"],
    cons: ["결정 하나(베타 인원)를 놓침", "느린 편 (6분 회의 35초)"],
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B",
    family: "Google",
    repo: "unsloth/gemma-4-12b-it-GGUF",
    commit: "fc034cfff751157913579611efad8462ac1be606",
    file: "gemma-4-12b-it-Q4_K_M.gguf",
    size: 7121861440,
    sha256: "0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42",
    license: "Apache 2.0",
    minMemoryGB: 24,
    badge: "품질 최고",
    pros: ["결정 6·할 일 5·남은 질문 3을 모두 맞히고 지어낸 내용이 없음", "화자 번호 대신 대화 속 이름으로 담당자를 찾아 적음"],
    cons: ["메모리 24GB 이상 권장 (요약 중 약 9GB 사용)", "느린 편 (6분 회의 35초)"],
  },
];

export const findSummaryModel = (id) => SUMMARY_CATALOG.find((m) => m.id === id);

// 이 맥 메모리에 맞는 추천: 돌릴 수 있는 것 중 요구 메모리가 가장 큰 모델, 같으면 앞에 있는 것
export function recommendedSummaryModel(memoryGB) {
  const fits = SUMMARY_CATALOG.filter((m) => m.minMemoryGB <= memoryGB);
  return fits.reduce((best, m) => (m.minMemoryGB > best.minMemoryGB ? m : best), fits[0] ?? SUMMARY_CATALOG[0]);
}
