// 요약에 쓸 외부 모델 고르기 (순수 함수). 모델 이름을 코드에 박지 않고 "등급"만 정해 두어,
// 회사가 새 버전을 내면 목록을 다시 받는 것만으로 자동 선택이 따라간다.
const NOT_TEXT = /embed|tts|whisper|transcribe|audio|realtime|image|imagine|dall-e|moderation|vision|search/i;
const SMALL = /(^|-)(mini|nano|lite)(-|$)|gemma|-oss/i; // "gemini" 안의 mini는 빼지 않는다. Gemma·gpt-oss는 공개 소형 모델
// 회사마다 가장 새 버전 안에서 요약에 알맞은 등급 (없으면 그 버전의 첫 번째). 새 세대가 등급 이름을 바꿔도 새 세대를 고른다
const TIERS = { anthropic: /sonnet/, gemini: /-pro/ };

// "claude-sonnet-4-5-20250929" → 4.5, "gpt-5.1" → 5.1, "gpt-4o" → 4. 숫자가 없으면 0
export function modelVersion(id) {
  const name = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  const match = name.match(/(\d+)(?:[.-](\d{1,2}))?(?!\d|b\b)/); // "120b"(모델 크기)는 버전이 아니다
  return match ? Number(`${match[1]}.${match[2] ?? 0}`) : 0;
}

// 요약에 쓸 만한 모델을 좋은 순서로: 새 버전 먼저, 같은 버전이면 짧은 이름(날짜 없는 별칭) 먼저
export function rankModels(providerId, ids) {
  return ids
    .filter((id) => !NOT_TEXT.test(id) && !SMALL.test(id))
    .sort((a, b) => modelVersion(b) - modelVersion(a) || a.length - b.length || a.localeCompare(b));
}

export function bestModel(providerId, ids) {
  const ranked = rankModels(providerId, ids);
  if (!ranked.length) return null;
  const newest = ranked.filter((id) => modelVersion(id) === modelVersion(ranked[0]));
  const tier = TIERS[providerId];
  return (tier && newest.find((id) => tier.test(id))) ?? newest[0];
}

// pinned: 사용자가 고른 모델(비면 자동), available: 마지막으로 받은 목록(못 받았으면 null)
// 결과: { model, auto?, newer?(고른 것보다 새 추천), retired?(목록에서 사라진 고른 모델) }
export function chooseModel({ providerId, pinned, available }) {
  if (!available) return { model: pinned || null, ...(pinned ? {} : { auto: true }) };
  const best = bestModel(providerId, available);
  if (!pinned) return { model: best, auto: true };
  if (!available.includes(pinned)) return { model: best, auto: true, retired: pinned };
  return best && best !== pinned && modelVersion(best) > modelVersion(pinned) ? { model: pinned, newer: best } : { model: pinned };
}
