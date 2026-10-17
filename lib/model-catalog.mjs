// 앱에서 고를 수 있는 받아쓰기 모델 (모두 무료, 이 맥에서만 동작).
// GGUF 파일(Handy가 transcribe.cpp용으로 변환한 것)을 voin 사본 저장소(Hugging Face tory-labs/voin-…-gguf)에서
// 커밋·SHA-256으로 고정해 받는다. 원본 출처·라이선스는 각 저장소의 설명서와 LICENSE에 있다.
// 장단점과 속도(rtf: 처리 시간 ÷ 녹음 길이)는 2026-10-15 실제 회의 녹음(노트북 마이크, 한국어 5분)을
// 이 앱과 같은 방식(발화 단위)으로 받아써 비교한 결과다. 정답 대본이 없어 정확도는 결과를 읽고 판단했다.
// Moonshine 한국어(base-ko)는 짧은 발화에 "audiotext"만 내놓아 목록에서 뺐다.
export const DEFAULT_MODEL_ID = "nemotron-3.5";

export const CATALOG = [
  {
    id: "nemotron-3.5",
    license: "OpenMDW-1.1", // 원본 모델 라이선스 (정보 화면에 표기)
    name: "Nemotron 3.5",
    family: "NVIDIA",
    repo: "tory-labs/voin-nemotron-3.5-gguf",
    handyRepo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf", // Handy 앱이 받아 둔 같은 파일을 찾을 때 (HF 캐시 폴더 이름)
    commit: "e62a3b8efa806be0025c23fb65d93e1eb197701c",
    file: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
    size: 751094240,
    sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
    badge: "기본",
    streaming: true,
    languages: "다국어 (한국어 포함 32개 언어)",
    rtf: 0.009,
    pros: ["가장 빠른 축 (1시간 녹음 약 30초)", "지금까지 실사용 회의(HR 미팅)로 검증한 모델", "모델 자체가 실시간 스트리밍을 지원"],
    cons: ["영어 약어를 한글 소리로 적음 (예: HRIS → 에이치 알 아이 에스)", "문장부호가 적고, 비슷한 소리로 잘못 적는 경우가 있음 (예: 저장 → 저당)", "실시간 스트리밍은 지금 이 앱에서 쓰지 않음 (모든 모델을 문장 단위로 받아씀)"],
  },
  {
    id: "whisper-large-v3-turbo",
    license: "MIT",
    name: "Whisper large-v3 turbo",
    family: "OpenAI",
    repo: "tory-labs/voin-whisper-large-v3-turbo-gguf",
    handyRepo: "handy-computer/whisper-large-v3-turbo-gguf", // Handy 앱이 받아 둔 같은 파일을 찾을 때 (HF 캐시 폴더 이름)
    commit: "495f1d4f5109fe7cdad1fe1bd7346052aa590433",
    file: "whisper-large-v3-turbo-Q8_0.gguf",
    size: 886381760,
    sha256: "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183",
    streaming: false,
    languages: "다국어 (100개 언어)",
    rtf: 0.052,
    pros: ["영어 용어를 영어로 적고 문장부호가 자연스러움", "가장 널리 쓰이는 모델이라 자료가 많음"],
    cons: ["조용하거나 짧은 소리에 엉뚱한 영어 문장을 지어냄 (시험에서 'Facebook worries')", "짧은 대답을 줄여 적거나 빠뜨림", "느린 편 (1시간 녹음 약 3분)"],
  },
  {
    id: "whisper-large-v3",
    license: "Apache 2.0",
    name: "Whisper large-v3",
    family: "OpenAI",
    repo: "tory-labs/voin-whisper-large-v3-gguf",
    handyRepo: "handy-computer/whisper-large-v3-gguf", // Handy 앱이 받아 둔 같은 파일을 찾을 때 (HF 캐시 폴더 이름)
    commit: "963b50bec96f8b576291069f07260a5b26a15031",
    file: "whisper-large-v3-Q5_K_M.gguf",
    size: 1161143008,
    sha256: "6053d0fd69a0fd48b8fea5ea7a52b9e0cde389343566fa30e453a1b2b258dc38",
    streaming: false,
    languages: "다국어 (100개 언어)",
    rtf: 0.079,
    pros: ["Whisper 중 가장 큰 모델", "영어 용어·문장부호 처리가 turbo와 비슷하게 자연스러움"],
    cons: ["이번 시험에서는 turbo보다 낫지 않았음", "가장 느림 (1시간 녹음 약 5분)", "메모리 약 1.3GB"],
  },
  {
    id: "whisper-small",
    license: "Apache 2.0",
    name: "Whisper small",
    family: "OpenAI",
    repo: "tory-labs/voin-whisper-small-gguf",
    handyRepo: "handy-computer/whisper-small-gguf", // Handy 앱이 받아 둔 같은 파일을 찾을 때 (HF 캐시 폴더 이름)
    commit: "4be4176aee897a36dfcb3dcf8d62ca1b5c0487d5",
    file: "whisper-small-Q8_0.gguf",
    size: 269751136,
    sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
    streaming: false,
    languages: "다국어 (99개 언어)",
    rtf: 0.026,
    pros: ["작고 가벼움 (270MB)", "짧은 대답도 비교적 빠짐없이 적음"],
    cons: ["큰 모델보다 잘못 알아듣는 단어가 많음 (예: 원 수준 → 원 투준)", "잡음에 뜻 없는 글자를 적음 (시험에서 '입술 es으')"],
  },
  {
    id: "qwen3-asr-0.6b",
    license: "Apache 2.0",
    name: "Qwen3-ASR 0.6B",
    family: "Alibaba",
    repo: "tory-labs/voin-qwen3-asr-0.6b-gguf",
    handyRepo: "handy-computer/Qwen3-ASR-0.6B-gguf", // Handy 앱이 받아 둔 같은 파일을 찾을 때 (HF 캐시 폴더 이름)
    commit: "1f627bfcd299c58e5c215c64516240858191fb4f",
    file: "Qwen3-ASR-0.6B-Q8_0.gguf",
    size: 850423456,
    sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
    badge: "추천",
    streaming: false,
    languages: "다국어 (한국어 포함 30개 언어)",
    rtf: 0.026,
    pros: ["이번 시험에서 문장이 가장 자연스럽고 빠짐이 적었음", "영어 용어를 영어로 적음 (HRIS)", "빠른 편 (1시간 녹음 약 1분 30초)"],
    cons: ["잡음이나 웅얼거림에 없는 말을 지어냄 (시험에서 '트익스북다')", "Nemotron보다 약 3배 느림"],
  },
  {
    id: "qwen3-asr-1.7b",
    license: "Apache 2.0",
    name: "Qwen3-ASR 1.7B",
    family: "Alibaba",
    repo: "tory-labs/voin-qwen3-asr-1.7b-gguf",
    handyRepo: "handy-computer/Qwen3-ASR-1.7B-gguf", // Handy 앱이 받아 둔 같은 파일을 찾을 때 (HF 캐시 폴더 이름)
    commit: "c94535c6e619882d22c3701d711c97b79a28f948",
    file: "Qwen3-ASR-1.7B-Q5_K_M.gguf",
    size: 1517290464,
    sha256: "034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0",
    streaming: false,
    languages: "다국어 (한국어 포함 30개 언어)",
    rtf: 0.039,
    pros: ["0.6B와 비슷하거나 조금 더 정확함 (오차도 좀 적고요 ← 0.6B는 '온차도')"],
    cons: ["가장 큰 파일 (1.5GB), 메모리 16GB 맥 권장", "잡음에 없는 말을 지어냄", "1시간 녹음 약 2분 20초"],
  },
];

export const findCatalogModel = (id) => CATALOG.find((m) => m.id === id);
