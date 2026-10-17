// 말로 작업 폴더 고르기 (순수 함수, 화면과 서버가 함께 쓴다): 말의 맨 앞이 폴더 별칭이나 이름이면 그 폴더.
//   "보인 폴더로 바꿔 줘" → 폴더만 바꿈 (rest ""),  "보인에서 테스트 돌려 줘" → 바꾸고 "테스트 돌려 줘"를 작업으로.
// 이름 뒤에 조사("에서·로·폴더로" 등)나 문장 끝이 와야 폴더로 본다 ("블로그 글 써 줘"는 그냥 작업).
const PREFIX = /^\s*(?:작업\s*)?(?:폴더(?:를)?\s+)?/;
const PARTICLES = ["폴더에서", "폴더로", "폴더를", "폴더", "에서", "으로", "로", "에"];
const SWITCH_ONLY = /^(?:바꿔|바꾸|전환|열어|이동|가자|가\s*줘)/;

// text 맨 앞에서 label을 띄어쓰기·대소문자 무시하고 찾아, label이 끝나는 위치를 돌려준다 (없으면 -1)
function consume(text, label) {
  const want = label.replace(/\s+/g, "").toLowerCase();
  let i = 0;
  let j = 0;
  while (j < want.length && i < text.length) {
    if (/\s/.test(text[i])) i++;
    else if (text[i].toLowerCase() === want[j]) (i++, j++);
    else return -1;
  }
  return j === want.length ? i : -1;
}

// folders: [{ path, name, alias }] → { path, rest } | null
export function matchFolder(text, folders) {
  const body = text.replace(PREFIX, "");
  let best = null;
  for (const folder of folders) {
    for (const label of [folder.alias, folder.name].filter(Boolean)) {
      const end = consume(body, label);
      if (end < 0) continue;
      const after = body.slice(end).replace(/^\s+/, "");
      const particle = PARTICLES.find((p) => after.startsWith(p));
      const tail = particle ? after.slice(particle.length) : after;
      // 이름 바로 뒤에 다른 글자가 붙어 있으면(조사·문장 끝이 아니면) 폴더 이름이 아니다
      if (!particle && /^[\p{L}\p{N}]/u.test(after)) continue;
      if (!best || label.length > best.length) best = { path: folder.path, tail, length: label.length };
    }
  }
  if (!best) return null;
  const rest = best.tail.replace(/^[\s,.!?…]+/, "").trim();
  return { path: best.path, rest: !rest || (SWITCH_ONLY.test(rest) && rest.length <= 12) ? "" : rest };
}
