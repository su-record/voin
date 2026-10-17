// 받아쓴 글 다듬기 (순수 함수): 용어 사전 치환, 군말 제거.
// 뜻을 망가뜨리지 않는 게 우선이라 보수적으로만 지운다: 쉼표·문장 경계로 떨어져 있는 군말,
// 그리고 바로 이어서 반복된 같은 낱말("그 그", "the the")만.

// 낱말 경계: 한글·영문·숫자가 아닌 곳 (한국어는 조사가 붙으므로 뒤쪽은 조사도 허용)
const WORD = "[\\p{L}\\p{N}]";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 사전 항목 정리: {from, to} 문자열만, 빈 from·중복 from은 버린다 (먼저 적은 것이 이긴다)
export function normalizeDictionary(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const from = String(e?.from ?? "").trim();
    const to = String(e?.to ?? "").trim();
    if (!from || seen.has(from.toLowerCase())) continue;
    seen.add(from.toLowerCase());
    out.push({ from, to: to || from });
  }
  return out;
}

// 설정 화면의 글상자 "쿠버네티스 => Kubernetes" 한 줄에 하나. "=>" 없이 쓰면 그 말 자체를 용어로(받아쓰기 힌트용)
export function parseDictionaryText(text) {
  return normalizeDictionary(
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.split(/\s*(?:=>|→)\s*/))
      .map(([from, to]) => ({ from, to })),
  );
}

export function dictionaryToText(entries) {
  return normalizeDictionary(entries)
    .map(({ from, to }) => (from === to ? from : `${from} => ${to}`))
    .join("\n");
}

// 낱말 경계 기준으로만 바꾼다. 앞: 글자가 아닌 곳. 뒤: 영문·숫자가 이어지면 안 됨(한글 조사는 붙어도 됨).
// 긴 말부터 바꿔 "쿠버"가 "쿠버네티스"를 먼저 먹지 않게 한다. 영문은 대소문자 무시.
export function applyDictionary(text, entries) {
  const list = normalizeDictionary(entries)
    .filter((e) => e.from !== e.to)
    .sort((a, b) => b.from.length - a.from.length);
  if (!text || !list.length) return text;
  const pattern = new RegExp(`(?<!${WORD})(${list.map((e) => escape(e.from)).join("|")})(?![A-Za-z0-9])`, "giu");
  const map = new Map(list.map((e) => [e.from.toLowerCase(), e.to]));
  return text.replace(pattern, (m) => map.get(m.toLowerCase()) ?? m);
}

// 모델에 줄 용어 힌트(vocabulary): 바뀐 뒤의 말
export function dictionaryTerms(entries) {
  return [...new Set(normalizeDictionary(entries).map((e) => e.to))];
}

// 홀로 쓰인 군말. "그", "저기", "어"는 뜻이 있을 때가 많아("그 사람", "저기 있어", "어 맞아"),
// 쉼표나 문장 끝으로 앞뒤가 끊긴 경우에만 지운다.
const FILLERS_KO = ["음+", "으+음", "어+", "아+", "그+", "저기", "에+"];
const FILLERS_EN = ["um+", "uh+", "umm+", "erm", "hmm+", "you know"];

export function removeFillers(text) {
  if (!text) return text;
  let out = ` ${text} `;
  const fillers = [...FILLERS_KO, ...FILLERS_EN].join("|");
  // (경계)군말(쉼표·마침표·말줄임 또는 문장 끝) — 군말 뒤에 반드시 쉼표류가 있어야 지운다.
  // 단, "음", "um", "uh"처럼 그 자체로 뜻이 없는 소리는 뒤에 쉼표가 없어도 지운다.
  const separated = new RegExp(`(^|[\\s,.!?…])(?:${fillers})(?:[,，…]+|\\.{2,})(?=\\s|$)`, "giu");
  const pureSounds = new RegExp(`(^|[\\s,.!?…])(?:음+|으+음|um+|uh+|umm+|erm|hmm+)(?=[\\s,.!?…]|$)[,，…]*`, "giu");
  for (let i = 0; i < 3; i++) out = out.replace(separated, "$1").replace(pureSounds, "$1");
  out = removeRepetitions(out);
  return tidy(out);
}

// 바로 이어 반복한 같은 낱말(1~3어절 묶음)을 하나로: "제가 제가" → "제가", "I think I think" → "I think".
// 한 글자짜리 숫자 반복("1 1")은 뜻일 수 있어 그대로 둔다.
export function removeRepetitions(text) {
  if (!text) return text;
  let out = text;
  for (let n = 3; n >= 1; n--) {
    const unit = Array.from({ length: n }, () => `${WORD}+`).join("\\s+");
    const re = new RegExp(`(?<!${WORD})(${unit})(?:[,\\s]+\\1)+(?!${WORD})`, "giu");
    out = out.replace(re, (m, g) => (/^\p{N}+$/u.test(g) ? m : g));
  }
  return out;
}

function tidy(text) {
  return text
    .replace(/\s+([,.!?…])/g, "$1")
    .replace(/(^|[.!?…]\s*)[,，]\s*/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 받아쓰기 모드 후처리: 사전 → (켜져 있으면) 군말 제거
export function cleanupDictation(text, { dictionary = [], removeFillers: fillers = true } = {}) {
  let out = applyDictionary(text, dictionary);
  if (fillers) out = removeFillers(out);
  return out;
}

// 회의 기록 군말 지우기(설정 "기록 다듬기"): "[시각] **화자**: 말" 줄의 말에만 removeFillers를 쓴다
export function removeRecordFillers(recordText) {
  return recordText.replace(/^(\[\d+:\d\d:\d\d\] \*\*.+?\*\*: )(.*)$/gm, (_, head, said) => head + (removeFillers(said) || said));
}
