// 요약의 날짜·숫자 확인 (순수 함수): 요약에 나온 날짜·숫자가 받아쓴 기록에 실제로 있는지 본다.
// 작은 모델이 "11월 20일"을 "21일"로 옮기는 일이 있어(2026-10-17 시험), 기록에 없는 것은 요약 아래에 경고로 붙인다.
// 받아쓰기는 숫자를 "십일월 이십일", "오 달러", "November twentieth"처럼 적으므로 한글·영어 숫자를 읽어 비교한다.

const SINO_DIGITS = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
const SINO_UNITS = { 십: 10, 백: 100, 천: 1000 };
const NATIVE = { 하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 넷: 4, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50 };
const EN_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EN_ORD = { first: 1, second: 2, third: 3, fifth: 5, eighth: 8, ninth: 9, twelfth: 12 };
const EN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// "이천이십육" → 2026, "만오천" → 15000. 숫자 글자가 아니면 NaN
export function sinoKorean(word) {
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of word) {
    if (ch in SINO_DIGITS) digit = SINO_DIGITS[ch];
    else if (ch in SINO_UNITS) {
      section += (digit || 1) * SINO_UNITS[ch];
      digit = 0;
    } else if (ch === "만") {
      total += (section + digit || 1) * 10000;
      section = 0;
      digit = 0;
    } else return NaN;
  }
  return total + section + digit;
}

// 영어 낱말 하나("fourteen", "twentieth") → 숫자, 아니면 NaN
function englishWord(word) {
  const w = word.toLowerCase();
  if (EN_ONES.includes(w)) return EN_ONES.indexOf(w);
  if (w in EN_TENS) return EN_TENS[w];
  if (w in EN_ORD) return EN_ORD[w];
  const stem = w.replace(/ieth$/, "y").replace(/th$/, "");
  if (EN_ONES.includes(stem)) return EN_ONES.indexOf(stem);
  return EN_TENS[stem] ?? NaN;
}

// "twenty first", "twenty-one" 같은 두 낱말 숫자도 읽어 낱말 배열을 숫자 배열로
function englishNumbers(text) {
  const words = text.split(/[^A-Za-z]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const n = englishWord(words[i]);
    if (Number.isNaN(n)) {
      out.push(NaN);
      continue;
    }
    const next = englishWord(words[i + 1] ?? "");
    if (n >= 20 && n % 10 === 0 && next > 0 && next < 10) {
      out.push(n + next);
      i++;
    } else out.push(n);
  }
  return { words, values: out };
}

// 날짜 (월-일): "십일월 이십일", "11월 7일", "November twentieth", "December 3"
export function datesSpoken(text) {
  const dates = new Set();
  // 한글: 월 바로 뒤의 "…일"은 날짜라 끝의 일 하나를 떼고 읽는다 ("이십일" → 20, "이십일일" → 21)
  for (const m of text.matchAll(/([일이삼사오육칠팔구십\d]+)\s*월\s*([일이삼사오육칠팔구십\d]+)\s*일/g)) {
    const month = /\d/.test(m[1]) ? Number(m[1]) : sinoKorean(m[1]);
    const day = /\d/.test(m[2]) ? Number(m[2]) : sinoKorean(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) dates.add(`${month}-${day}`);
  }
  const { words, values } = englishNumbers(text);
  words.forEach((w, i) => {
    const month = EN_MONTHS.indexOf(w.toLowerCase()) + 1;
    if (!month) return;
    if (values[i + 1] >= 1 && values[i + 1] <= 31) dates.add(`${month}-${values[i + 1]}`);
  });
  // "December 3"처럼 영어 월 뒤 아라비아 숫자
  for (const m of text.matchAll(new RegExp(`(${EN_MONTHS.join("|")})\\s+(\\d{1,2})(?!\\d)`, "gi"))) {
    dates.add(`${EN_MONTHS.indexOf(m[1].toLowerCase()) + 1}-${Number(m[2])}`);
  }
  return dates;
}

// 기록에 나온 숫자들 (날짜 제외 확인용): 아라비아 숫자, 한자어 숫자 낱말(끝의 일·월은 떼어 읽은 것도), 고유어, 영어
export function numbersSpoken(text) {
  const nums = new Set();
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) nums.add(Number(m[0]));
  for (const m of text.matchAll(/[일이삼사오육륙칠팔구십백천만]+/g)) {
    for (const w of [m[0], m[0].replace(/[일월]$/, "")]) {
      const n = sinoKorean(w);
      if (n > 0) nums.add(n);
    }
  }
  for (const [word, n] of Object.entries(NATIVE)) if (new RegExp(`(^|[^가-힣])${word}`).test(text)) nums.add(n);
  for (const n of englishNumbers(text).values) if (!Number.isNaN(n)) nums.add(n);
  return nums;
}

// 요약에서 기록으로 확인되지 않는 날짜·숫자 (요약에 적힌 그대로). "화자 2" 같은 이름 번호는 보지 않는다
export function uncheckedNumbers(summary, transcript) {
  const dates = datesSpoken(transcript);
  const nums = numbersSpoken(transcript);
  const out = [];
  const text = summary.replace(/(화자|원격)\s*\d+/g, "").replace(/^(\s*)\d+[.)]\s/gm, "$1"); // 이름 번호, 줄 앞 목록 번호
  for (const m of text.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    if (!dates.has(`${Number(m[1])}-${Number(m[2])}`)) out.push(m[0]);
  }
  const rest = text.replace(/\d{1,2}\s*월\s*\d{1,2}\s*일/g, "");
  for (const m of rest.matchAll(/(\d+(?:\.\d+)?)\s*([가-힣A-Za-z%]*)/g)) {
    if (!nums.has(Number(m[1]))) out.push(`${m[1]}${m[2]}`);
  }
  return [...new Set(out)];
}

export function numbersWarning(unchecked) {
  if (!unchecked.length) return "";
  return `> ⚠ 기록에서 찾지 못한 날짜·숫자: ${unchecked.join(", ")} — 요약을 만든 모델이 잘못 옮겼을 수 있습니다. 원문을 확인하세요.`;
}
