// 화자 목소리 조각: 이름을 붙일 때 들어 보도록 화자마다 몇 초짜리 음성을 3개까지 남긴다.
// 전체 녹음은 지워도(기본) 이 조각은 앱 데이터 폴더에 둔다 (Obsidian 보관함·팀 폴더에는 넣지 않는다).
// voices/<기록 이름>/index.json = { "화자 1": ["1-0.wav", ...] } — 화자 이름을 바꾸면 키도 바꾼다.
import fs from "node:fs";
import path from "node:path";
import { SAMPLE_RATE, WavWriter } from "./audio.mjs";
import { DATA_DIR } from "./settings.mjs";

export const VOICES_DIR = path.join(DATA_DIR, "voices");
const MAX_CLIPS = 3;
const MAX_SECONDS = 7;

const dirOf = (baseName) => path.join(VOICES_DIR, baseName);
const indexFile = (baseName) => path.join(dirOf(baseName), "index.json");

export function voiceIndex(baseName) {
  try {
    return JSON.parse(fs.readFileSync(indexFile(baseName), "utf8"));
  } catch {
    return {};
  }
}

function writeIndex(baseName, index) {
  fs.mkdirSync(dirOf(baseName), { recursive: true });
  fs.writeFileSync(indexFile(baseName), JSON.stringify(index, null, 2));
}

// segments: [{ startSample, endSample, text }] — 3~7초 남짓 또렷한 발언을 고른다 (말이 많은 = 글자가 긴 구간 우선)
export function saveVoiceSamples(baseName, label, pcm, segments) {
  const picked = segments
    .filter((s) => s.endSample - s.startSample >= SAMPLE_RATE * 2)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, MAX_CLIPS);
  if (!picked.length) return;
  const index = voiceIndex(baseName);
  const key = `${Object.keys(index).length}`;
  index[label] = picked.map((s, i) => {
    // 긴 구간은 가운데 7초만
    const length = Math.min(s.endSample - s.startSample, MAX_SECONDS * SAMPLE_RATE);
    const start = s.startSample + Math.floor((s.endSample - s.startSample - length) / 2);
    const name = `${key}-${i}.wav`;
    fs.mkdirSync(dirOf(baseName), { recursive: true });
    const wav = new WavWriter(path.join(dirOf(baseName), name));
    wav.write(pcm.subarray(start, start + length));
    wav.close();
    return name;
  });
  writeIndex(baseName, index);
}

// 화자 이름이 바뀌면 조각도 따라간다 (같은 이름으로 합치면 조각도 합친다)
export function renameVoices(baseName, from, to) {
  // 이름을 붙였으니 그 화자의 추천은 지운다
  const suggestions = nameSuggestions(baseName);
  if (suggestions[from]) {
    delete suggestions[from];
    saveNameSuggestions(baseName, suggestions);
  }
  const index = voiceIndex(baseName);
  if (!index[from] || from === to) return;
  index[to] = [...(index[to] ?? []), ...index[from]];
  delete index[from];
  writeIndex(baseName, index);
}

// 화면에서 쓸 주소 목록
export function voiceUrls(baseName) {
  const index = voiceIndex(baseName);
  return Object.fromEntries(Object.entries(index).map(([label, files]) => [label, files.map((f) => `/voices/${encodeURIComponent(baseName)}/${f}`)]));
}

// /voices/<기록 이름>/<파일> 요청을 실제 파일 경로로 (폴더 밖으로 나가는 경로는 거부)
export function voicePath(urlPath) {
  const [, base, file] = urlPath.match(/^\/voices\/([^/]+)\/([^/]+\.wav)$/) ?? [];
  if (!base) return null;
  const full = path.join(VOICES_DIR, decodeURIComponent(base), decodeURIComponent(file));
  return full.startsWith(VOICES_DIR + path.sep) && fs.existsSync(full) ? full : null;
}

// 화자 이름 추천 (AI): voices/<기록 이름>/suggestions.json = { "화자 2": { name, reason } }
const suggestionsFile = (baseName) => path.join(dirOf(baseName), "suggestions.json");
export function nameSuggestions(baseName) {
  try {
    return JSON.parse(fs.readFileSync(suggestionsFile(baseName), "utf8"));
  } catch {
    return {};
  }
}
export function saveNameSuggestions(baseName, suggestions) {
  fs.mkdirSync(dirOf(baseName), { recursive: true });
  fs.writeFileSync(suggestionsFile(baseName), JSON.stringify(suggestions, null, 2));
}
