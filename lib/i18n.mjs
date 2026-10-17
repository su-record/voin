// 화면 언어: 시스템 언어가 한국어·일본어·영어 중 하나면 그 언어, 아니면 영어.
// 한국어 원문을 열쇠로 쓰고 lib/locales의 사전에서 찾는다 (없으면 원문). 화면(/shared/i18n.mjs)과 서버가 함께 쓴다.
// 기록 파일(.md) 안의 형식(## 요약, 화자 1 등)은 번역하지 않는다.
import en from "./locales/en.mjs";
import ja from "./locales/ja.mjs";

const DICTS = { en, ja };
export const LANGS = ["ko", "en", "ja"];
let lang = "ko";

// ["ja-JP", "en-US"] → "ja". 셋 중 없으면 영어
export function pickLang(preferred) {
  for (const tag of preferred ?? []) {
    const code = String(tag).toLowerCase().slice(0, 2);
    if (LANGS.includes(code)) return code;
  }
  return "en";
}

export const setLang = (code) => (lang = LANGS.includes(code) ? code : "en");
export const getLang = () => lang;

// t("{name} 불러오는 중…", { name }) → 지금 언어의 글
export function t(key, vars) {
  const text = lang === "ko" ? key : (DICTS[lang]?.[key] ?? key);
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;
}

// 고정된 화면 글(index.html) 바꾸기: 글자 조각과 title·aria-label·placeholder 속성
const ATTRS = ["title", "aria-label", "placeholder"];
export function translateDom(root) {
  if (lang === "ko") return;
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const key = node.nodeValue.trim();
    if (key && /[가-힣]/.test(key)) node.nodeValue = node.nodeValue.replace(key, t(key));
  }
  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(","))) {
    for (const a of ATTRS) if (el.hasAttribute(a) && /[가-힣]/.test(el.getAttribute(a))) el.setAttribute(a, t(el.getAttribute(a)));
  }
}
