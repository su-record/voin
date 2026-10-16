// Obsidian 보관함에 저장된 기록을 다른 노트와 자동으로 연결한다 (정리·요약·화자 이름 바꾸기 뒤마다 다시 실행해도 같은 결과).
//  - daily: 그날 데일리 노트 [[2026-10-16]] (보관함의 데일리 노트 날짜 형식을 따른다)
//  - previous: 같은 제목의 직전 기록 [[2026-10-09 1000 주간 회의]]
//  - participants: 실제 이름으로 바꾼 화자 → [[홍길동]] ("화자 1"처럼 이름을 안 붙인 화자는 그대로)
//  - 요약 속 낱말 중 보관함에 이미 있는 노트 이름(제목·별칭 포함) → [[노트]] (없는 노트는 만들지 않는다)
import fs from "node:fs";
import path from "node:path";

const UNNAMED = /^(화자|원격) \d+$|^(마이크|화상회의|녹음)$/;

// 기록 파일에서 위로 올라가며 .obsidian 폴더가 있는 곳(보관함 루트)을 찾는다
export function vaultRootOf(filePath) {
  for (let dir = path.dirname(filePath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".obsidian"))) return dir;
  }
  return null;
}

// 데일리 노트 이름: 보관함 설정(.obsidian/daily-notes.json의 format, Moment 형식)을 따른다. 기본 YYYY-MM-DD
function dailyNoteName(vault, date) {
  let format = "YYYY-MM-DD";
  try {
    format = JSON.parse(fs.readFileSync(path.join(vault, ".obsidian/daily-notes.json"), "utf8")).format || format;
  } catch {}
  const pad = (n) => String(n).padStart(2, "0");
  const tokens = { YYYY: date.getFullYear(), YY: String(date.getFullYear()).slice(2), MM: pad(date.getMonth() + 1), M: date.getMonth() + 1, DD: pad(date.getDate()), D: date.getDate(), ddd: "일월화수목금토"[date.getDay()] };
  // [대괄호] 안은 글자 그대로
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|ddd/g, (m, literal) => literal ?? tokens[m]);
}

function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? { fm: m[1], body: text.slice(m[0].length) } : { fm: null, body: text };
}

function fmValue(fm, key) {
  return fm?.match(new RegExp(`^${key}: "?(.*?)"?$`, "m"))?.[1] ?? null;
}

function fmList(fm, key) {
  const block = fm?.match(new RegExp(`^${key}:\\n((?:\\s+- .*\\n?)*)`, "m"))?.[1] ?? "";
  return [...block.matchAll(/^\s+- "?(.*?)"?$/gm)].map((m) => m[1]);
}

// 키 하나를 바꾸거나(없으면 tags 앞에) 넣는다. value가 배열이면 목록으로 쓴다
function setFm(fm, key, value) {
  const lines = Array.isArray(value) ? `${key}:\n${value.map((v) => `  - ${JSON.stringify(v)}`).join("\n")}` : `${key}: ${JSON.stringify(value)}`;
  const existing = new RegExp(`^${key}:.*(?:\\n\\s+- .*)*`, "m");
  if (existing.test(fm)) return fm.replace(existing, lines);
  return /^tags:/m.test(fm) ? fm.replace(/^tags:/m, `${lines}\ntags:`) : `${fm}\n${lines}`;
}

// 같은 폴더에서 제목이 같은 직전 기록 (파일 이름이 "날짜 시각 제목"이라 이름순 = 시간순)
function previousRecord(filePath, title) {
  const dir = path.dirname(filePath);
  const self = path.basename(filePath);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f < self)
    .sort()
    .reverse()
    .find((f) => fmValue(splitFrontmatter(readHead(path.join(dir, f))).fm, "title") === title)
    ?.replace(/\.md$/, "");
}

function readHead(file, bytes = 4096) {
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(bytes);
  const text = buffer.subarray(0, fs.readSync(fd, buffer, 0, bytes, 0)).toString("utf8");
  fs.closeSync(fd);
  return text;
}

// 보관함 노트 목록: 파일 이름·제목·별칭 → 노트 이름. 기록 폴더(녹음 기록끼리)는 빼서 낱말이 엉뚱한 기록에 걸리지 않게 한다
function noteIndex(vault, recordDir) {
  const notes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== recordDir) walk(full);
      } else if (entry.name.endsWith(".md")) {
        const name = entry.name.replace(/\.md$/, "");
        const { fm } = splitFrontmatter(readHead(full));
        const names = new Set([name, fmValue(fm, "title"), ...fmList(fm, "aliases")].filter(Boolean));
        for (const text of names) notes.push({ text, target: name });
      }
    }
  };
  walk(vault);
  return notes;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 요약 글에 나온 노트 이름을 [[링크]]로. 노트마다 글에서 처음 나온 곳 한 번만, 이미 링크인 곳은 건드리지 않는다.
// 한글만으로 된 두 글자 이름(예: "회의")은 다른 낱말 속에 섞이기 쉬워 뺀다. hr-os ↔ "HR OS"처럼 -, _ 와 띄어쓰기는 같게 본다.
function linkTopics(summary, notes, selfName) {
  const candidates = notes.filter(
    (n) => n.target !== selfName && n.text.length >= 2 && !/^\d{4}-\d{2}-\d{2}/.test(n.text) && !(/^[가-힣]+$/.test(n.text) && n.text.length < 3),
  );
  // 이미 있는 링크의 자리와 대상 (여러 번 실행해도 같은 결과가 되도록)
  const taken = [...summary.matchAll(/\[\[[^\]]*\]\]/g)].map((m) => [m.index, m.index + m[0].length]);
  const linked = new Set([...summary.matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]));
  const found = [];
  for (const { text, target } of candidates) {
    const pattern = escapeRe(text).replace(/(\\?[-_]|\s)+/g, "[-_\\s]+");
    for (const m of summary.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![A-Za-z0-9])`, "giu"))) {
      found.push({ start: m.index, end: m.index + m[0].length, word: m[0], target });
    }
  }
  // 앞에 나온 것부터, 같은 자리면 긴 이름 먼저
  found.sort((x, y) => x.start - y.start || y.end - y.start - (x.end - x.start));
  const chosen = [];
  for (const f of found) {
    if (linked.has(f.target)) continue;
    if ([...taken, ...chosen.map((c) => [c.start, c.end])].some(([s0, e0]) => f.start < e0 && f.end > s0)) continue;
    chosen.push(f);
    linked.add(f.target);
  }
  let out = summary;
  for (const c of chosen.sort((x, y) => y.start - x.start)) {
    const link = c.word === c.target ? `[[${c.target}]]` : `[[${c.target}|${c.word}]]`;
    out = out.slice(0, c.start) + link + out.slice(c.end);
  }
  return out;
}

export function linkRecord(filePath, { frontmatter = true } = {}) {
  const vault = vaultRootOf(filePath);
  if (!vault) return; // Obsidian 보관함 밖이면 하지 않는다
  const text = fs.readFileSync(filePath, "utf8");
  let { fm, body } = splitFrontmatter(text);
  const selfName = path.basename(filePath, ".md");
  const date = (fmValue(fm, "date") ?? selfName.slice(0, 10)).split("-").map(Number);
  const daily = `[[${dailyNoteName(vault, new Date(date[0], date[1] - 1, date[2]))}]]`;
  const title = fmValue(fm, "title") ?? body.match(/^# (.+)$/m)?.[1] ?? "";
  const previous = previousRecord(filePath, title);

  // 요약 구역만 낱말 연결 ("*… 요약 · …*" 꼬리말 제외)
  body = body.replace(/(^## 요약\n)([\s\S]*?)(?=^## 기록$)/m, (_, head, summary) => head + linkTopics(summary, noteIndex(vault, path.dirname(filePath)), selfName));

  if (fm !== null && frontmatter) {
    // 두 화자를 같은 이름으로 바꿔 합친 경우 한 번만 남긴다
    const names = [...new Set(fmList(fm, "participants").map((p) => p.replace(/^\[\[(.*)\]\]$/, "$1")))];
    const participants = names.map((p) => (UNNAMED.test(p) ? p : `[[${p}]]`));
    if (participants.length) fm = setFm(fm, "participants", participants);
    fm = setFm(fm, "daily", daily);
    if (previous) fm = setFm(fm, "previous", `[[${previous}]]`);
    fs.writeFileSync(filePath, `---\n${fm}\n---\n${body}`);
    return;
  }
  // 속성을 안 쓰는 설정이면 제목 아래 한 줄로 연결
  const names = [...new Set([...body.matchAll(/^\[\d+:\d\d:\d\d\] \*\*(.+?)\*\*: /gm)].map((m) => m[1]))].filter((n) => !UNNAMED.test(n));
  const line = ["연결: " + daily, previous && `이전 기록: [[${previous}]]`, names.length && `참석자: ${names.map((n) => `[[${n}]]`).join(", ")}`].filter(Boolean).join(" · ");
  body = /^연결: .*$/m.test(body) ? body.replace(/^연결: .*$/m, line) : body.replace(/^(# .+\n)/m, `$1\n${line}\n`);
  fs.writeFileSync(filePath, (fm !== null ? `---\n${fm}\n---\n` : "") + body);
}
