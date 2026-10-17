// 외국어 줄 번역: 정리가 끝난 기록에서 한국어가 아닌 줄 아래에 "↳ 번역"을 붙인다.
// 번역은 voin 내장 모델로 이 맥 안에서 한다(summarizer.mjs translateLocal). 기록 줄 형식은 그대로라
// 요약 입력(transcriptOf)·화자 이름 바꾸기에 영향이 없다.
import fs from "node:fs";

const LINE = /^\[\d+:\d\d:\d\d\] \*\*.+?\*\*: (.*)$/;
export const TRANSLATION_PREFIX = "↳ ";

// 글자 중 한글이 30% 미만이면 외국어 (영어 낱말이 섞인 한국어는 그대로 둔다). 너무 짧은 말("OK")은 번역하지 않는다
export function isForeign(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  return (text.match(/[가-힣]/g)?.length ?? 0) < letters.length * 0.3;
}

// translate(원문) → 한국어. 이미 번역이 붙은 줄은 건너뛴다(정리를 다시 해도 한 번만)
export async function addTranslations(text, translate) {
  const lines = text.split("\n");
  const out = [];
  for (const [i, line] of lines.entries()) {
    out.push(line);
    const m = line.match(LINE);
    if (!m || !isForeign(m[1]) || lines[i + 1]?.startsWith(TRANSLATION_PREFIX)) continue;
    const ko = (await translate(m[1])).replace(/\s*\n\s*/g, " ").trim();
    if (ko) out.push(`${TRANSLATION_PREFIX}${ko}`);
  }
  return out.join("\n");
}

export async function translateRecord(filePath, translate) {
  const before = fs.readFileSync(filePath, "utf8");
  const after = await addTranslations(before, translate);
  if (after !== before) fs.writeFileSync(filePath, after);
  return after !== before;
}
