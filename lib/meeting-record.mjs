// 회의록 한 건: 받아쓴 줄을 모아 Markdown(Obsidian 호환)으로 저장하고,
// 끝나면 화자 분리 → 화자 이름 붙이기 → 녹음 보관/삭제 → 팀 폴더 복사를 한다.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { SAMPLE_RATE, readWav } from "./audio.mjs";
import { expandHome } from "./settings.mjs";
import { saveVoiceSamples } from "./voice-samples.mjs";
import { t } from "./i18n.mjs";

const SOURCE_LABELS = { mic: "마이크", system: "화상회의", file: "녹음" };
const pad = (n) => String(n).padStart(2, "0");

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function safeFileName(title) {
  return title.replace(/[\\/:*?"<>|#^[\]\n\r]/g, " ").replace(/\s+/g, " ").slice(0, 60).trim() || "녹음";
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

// 저장된 회의록의 "[00:01:02] **마이크**: 내용" 줄을 다시 읽는다
const LABEL_SOURCES = Object.fromEntries(Object.entries(SOURCE_LABELS).map(([source, label]) => [label, source]));
function parseLines(text) {
  return [...text.matchAll(/^\[(\d+):(\d\d):(\d\d)\] \*\*(.+?)\*\*: (.*)$/gm)].map((m) => {
    const label = m[4];
    const source = LABEL_SOURCES[label] ?? (label.startsWith("원격") ? "system" : "mic");
    return { source, offsetMs: ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000, text: m[5], ...(label in LABEL_SOURCES ? {} : { speaker: label }) };
  });
}

export class MeetingRecord {
  // filePath: 이미 있는 회의록을 이어서 마무리할 때(앱이 정리 중에 꺼진 경우) 그 파일을 쓴다
  constructor({ title, settings, dir, startedAt, sourceDescription, modelsDir, filePath }) {
    this.title = title.trim() || "녹음";
    this.settings = settings;
    this.dir = dir;
    this.startedAt = startedAt;
    this.endedAt = null;
    this.sourceDescription = sourceDescription;
    this.modelsDir = modelsDir;
    this.lines = [];
    this.audioLinks = [];

    const d = new Date(startedAt);
    this.date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    this.startClock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (filePath) {
      this.baseName = path.basename(filePath, ".md");
      this.fileName = path.basename(filePath);
      this.filePath = filePath;
      this.lines = parseLines(fs.readFileSync(filePath, "utf8"));
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    const base = `${this.date} ${pad(d.getHours())}${pad(d.getMinutes())} ${safeFileName(this.title)}`;
    let name = base;
    for (let i = 2; fs.existsSync(path.join(dir, `${name}.md`)); i++) name = `${base} (${i})`;
    this.baseName = name;
    this.fileName = `${name}.md`;
    this.filePath = path.join(dir, this.fileName);
    this.write();
  }

  label(line) {
    return line.speaker ?? SOURCE_LABELS[line.source];
  }

  // 받아쓴 한 줄을 추가하고 파일에 바로 반영한다 (중간에 앱이 꺼져도 남도록)
  addLine(line) {
    this.lines.push(line);
    this.lines.sort((a, b) => a.offsetMs - b.offsetMs);
    this.write();
    return { time: formatClock(line.offsetMs), source: line.source, label: this.label(line), text: line.text };
  }

  render() {
    const participants = [...new Set(this.lines.map((l) => this.label(l)))];
    const endClock = this.endedAt
      ? `${pad(new Date(this.endedAt).getHours())}:${pad(new Date(this.endedAt).getMinutes())}`
      : "";
    const minutes = this.endedAt ? Math.max(1, Math.round((this.endedAt - this.startedAt) / 60000)) : null;
    const out = [];
    if (this.settings.frontmatter) {
      const tags = this.settings.tags.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
      out.push("---", `title: ${yamlString(this.title)}`, `date: ${this.date}`, `start: "${this.startClock}"`);
      if (endClock) out.push(`end: "${endClock}"`, `duration: ${minutes}분`);
      out.push(`source: ${yamlString(this.sourceDescription)}`);
      if (participants.length) out.push("participants:", ...participants.map((p) => `  - ${yamlString(p)}`));
      if (tags.length) out.push("tags:", ...tags.map((t) => `  - ${t}`));
      out.push("---", "");
    }
    out.push(`# ${this.title}`, "");
    if (!this.settings.frontmatter) {
      out.push(`- 날짜: ${this.date} ${this.startClock}${endClock ? ` ~ ${endClock} (${minutes}분)` : ""}`);
      out.push(`- 녹음: ${this.sourceDescription}`);
      if (participants.length) out.push(`- 참석자: ${participants.join(", ")}`);
      out.push("");
    }
    for (const line of this.lines) out.push(`[${formatClock(line.offsetMs)}] **${this.label(line)}**: ${line.text}`, "");
    if (this.audioLinks.length) out.push("## 녹음", "", ...this.audioLinks, "");
    return out.join("\n");
  }

  write() {
    fs.writeFileSync(this.filePath, this.render());
  }

  // wavFiles: { source: wav 경로 }. 화자 분리 후 녹음을 보관하거나 지운다.
  // transcribe(source, pcm) → 받아쓴 글, toOffsetMs(source, 샘플 위치) → 회의 시작 기준 시각
  async finish({ wavFiles, transcribe, toOffsetMs = (_, sample) => (sample * 1000) / SAMPLE_RATE, onProgress }) {
    this.endedAt ??= Date.now();
    const sources = Object.keys(wavFiles).filter((s) => this.lines.some((l) => l.source === s));
    if (this.settings.diarization) {
      const prefix = (source) => (source === "system" && sources.includes("mic") ? "원격" : "화자");
      for (const source of sources) {
        const label = SOURCE_LABELS[source];
        onProgress(t("화자 분석 중… ({label})", { label: t(label) }));
        try {
          const segments = await diarize(wavFiles[source], this.modelsDir, this.settings.expectedSpeakers);
          if (!segments.length) continue;
          // 실시간 줄은 화자가 바뀌어도 쉬는 틈이 짧으면 한 줄로 합쳐진다.
          // 그래서 화자 구간마다 다시 받아써 줄을 화자 경계에 맞춘다.
          const pcm = readWav(wavFiles[source]);
          const lines = await transcribeTurns(pcm, speakerTurns(segments), (piece) => transcribe(source, piece), (ratio) =>
            onProgress(t("화자별로 정리 중… ({label}) {percent}%", { label: t(label), percent: Math.round(ratio * 100) })),
          );
          if (!lines.length) continue;
          const numbering = new Map();
          for (const line of lines) {
            if (!numbering.has(line.speaker)) numbering.set(line.speaker, numbering.size + 1);
            line.speaker = `${prefix(source)} ${numbering.get(line.speaker)}`;
            line.source = source;
            line.offsetMs = toOffsetMs(source, line.startSample);
          }
          this.lines = [...this.lines.filter((l) => l.source !== source), ...lines].sort((a, b) => a.offsetMs - b.offsetMs);
          // 이름 붙일 때 들어 볼 목소리 조각 (전체 녹음은 아래에서 지워도 남는다)
          try {
            for (const label of new Set(lines.map((l) => l.speaker))) {
              saveVoiceSamples(this.baseName, label, pcm, lines.filter((l) => l.speaker === label));
            }
          } catch (error) {
            console.error("목소리 조각 저장 실패:", error);
          }
        } catch (error) {
          console.error("화자 분리 실패:", error);
          onProgress(t("화자 분석에 실패해 {label} 구분만 남깁니다: {message}", { label: t(label), message: error.message }));
        }
      }
    }

    for (const [source, wav] of Object.entries(wavFiles)) {
      if (this.settings.keepAudio && this.lines.length && fs.existsSync(wav)) {
        const attachDir = path.join(this.dir, "첨부");
        fs.mkdirSync(attachDir, { recursive: true });
        const name = `${this.baseName} ${SOURCE_LABELS[source]}.wav`;
        fs.renameSync(wav, path.join(attachDir, name));
        this.audioLinks.push(
          this.settings.saveMode === "obsidian" ? `![[${name}]]` : `- [${name}](<첨부/${name}>)`,
        );
      } else {
        fs.rmSync(wav, { force: true });
      }
    }
    this.write();
    // 받아쓴 말이 하나도 없으면 기록을 남기지 않는다 (녹음 시작 때 만든 파일도 지운다)
    if (!this.lines.length) {
      fs.rmSync(this.filePath, { force: true });
      this.discarded = true;
      return null;
    }
    return this.copyToTeamFolder();
  }

  // 팀 공유 폴더에 사본을 둔다. 실패해도 원본은 남아 있으므로 경고만 돌려준다.
  copyToTeamFolder() {
    return copyToTeamFolder(this.filePath, this.settings.teamFolder);
  }
}

// 팀 공유 폴더에 기록 사본을 둔다(음성 제외). 요약을 붙인 뒤에도 다시 불러 최신본으로 덮어쓴다.
export function copyToTeamFolder(filePath, teamFolder) {
  if (!teamFolder) return null;
  const team = expandHome(teamFolder);
  try {
    fs.mkdirSync(team, { recursive: true });
    fs.copyFileSync(filePath, path.join(team, path.basename(filePath)));
    return null;
  } catch (error) {
    return t("팀 공유 폴더에 복사하지 못했습니다 ({folder}): {message}", { folder: team, message: error.message });
  }
}

function diarize(wavFile, modelsDir, expectedSpeakers) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./diarize-worker.mjs", import.meta.url), {
      workerData: { wavFile, modelsDir, expectedSpeakers },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => code !== 0 && reject(new Error(t("화자 분리 작업이 종료되었습니다 (코드 {code})", { code }))));
  });
}

// 같은 화자의 구간이 1초 안쪽으로 이어지면 한 차례 발언으로 합친다
function speakerTurns(segments) {
  const turns = [];
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    const last = turns.at(-1);
    if (last && last.speaker === s.speaker && s.start - last.end < 1) last.end = Math.max(last.end, s.end);
    else turns.push({ ...s });
  }
  return turns;
}

const MAX_PIECE = 30 * SAMPLE_RATE;
const MIN_PIECE = 20 * SAMPLE_RATE;
const PAD = Math.round(0.2 * SAMPLE_RATE);

// 30초가 넘는 발언은 20~30초 사이에서 가장 조용한 지점을 골라 나눈다 (단어가 잘리지 않게)
function splitLong(pcm, start, end) {
  const pieces = [];
  let from = start;
  while (end - from > MAX_PIECE) {
    let cut = from + MAX_PIECE;
    let quietest = Infinity;
    for (let p = from + MIN_PIECE; p + 1600 <= from + MAX_PIECE; p += 800) {
      let energy = 0;
      for (let i = p; i < p + 1600; i++) energy += pcm[i] * pcm[i];
      if (energy < quietest) {
        quietest = energy;
        cut = p + 800;
      }
    }
    pieces.push([from, cut]);
    from = cut;
  }
  pieces.push([from, end]);
  return pieces;
}

async function transcribeTurns(pcm, turns, transcribe, onProgress) {
  const lines = [];
  for (const [index, turn] of turns.entries()) {
    const start = Math.max(0, Math.floor(turn.start * SAMPLE_RATE) - PAD);
    const end = Math.min(pcm.length, Math.ceil(turn.end * SAMPLE_RATE) + PAD);
    for (const [a, b] of splitLong(pcm, start, end)) {
      if (b - a < SAMPLE_RATE / 4) continue;
      const text = (await transcribe(pcm.slice(a, b))).trim();
      if (text) lines.push({ speaker: turn.speaker, startSample: a, endSample: b, text });
    }
    onProgress((index + 1) / turns.length);
  }
  return lines;
}

// 저장된 회의록에서 화자 이름을 바꾼다 (본문 줄과 참석자 목록 모두)
export function renameSpeaker(filePath, from, to) {
  const name = to.trim();
  if (!name || /[*\n\r[\]]/.test(name)) throw new Error(t("이름에는 *, [, ], 줄바꿈을 쓸 수 없습니다."));
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = fs
    .readFileSync(filePath, "utf8")
    .replace(new RegExp(`\\*\\*${escape(from)}\\*\\*:`, "g"), `**${name}**:`)
    .replace(new RegExp(`^  - ${escape(yamlString(from))}$`, "gm"), `  - ${yamlString(name)}`)
    // Obsidian 연결이 붙은 참석자("[[홍길동]]")와 속성을 안 쓸 때의 "연결:" 줄
    .replace(new RegExp(`^  - "\\[\\[${escape(from)}\\]\\]"$`, "gm"), `  - "[[${name}]]"`)
    .replace(/^연결: .*$/m, (line) => line.replaceAll(`[[${from}]]`, `[[${name}]]`))
    .replace(/^- 참석자: (.*)$/m, (_, list) => `- 참석자: ${list.split(", ").map((p) => (p === from ? name : p)).join(", ")}`)
    // 요약 속 "화자 2"도 같이 바꾼다 ("화자 1"을 바꿀 때 "화자 10"은 건드리지 않음)
    .replace(/(^## 요약\n)([\s\S]*?)(?=^## 기록$)/m, (_, head, summary) =>
      head + summary.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(from)}(?!\\p{N})`, "gu"), name),
    );
  fs.writeFileSync(filePath, text);
}

// ───────── 요약 붙이기 ─────────
// 파일 모양: "# 제목" → "## 요약"(요약 글) → "## 기록"(받아쓴 줄). 다시 요약하면 요약 부분만 바꾼다.
const LINE_PATTERN = /^\[\d+:\d\d:\d\d\] \*\*.+?\*\*: /m;

export function transcriptOf(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => LINE_PATTERN.test(line))
    .join("\n");
}

export function setSummary(filePath, summary, by) {
  const text = fs.readFileSync(filePath, "utf8");
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const block = `## 요약\n\n${summary.trim()}\n\n*${by}로 요약 · ${stamp}*\n\n`;
  let next;
  if (/^## 요약$/m.test(text) && /^## 기록$/m.test(text)) {
    next = text.replace(/^## 요약\n[\s\S]*?(?=^## 기록$)/m, block);
  } else {
    const first = text.search(LINE_PATTERN);
    const at = first >= 0 ? first : text.length;
    next = `${text.slice(0, at)}${block}## 기록\n\n${text.slice(at)}`;
  }
  fs.writeFileSync(filePath, next);
}
