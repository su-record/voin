// 사용자 설정: ~/Library/Application Support/voin/settings.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR, migrateLegacyDataDir } from "./data-dir.mjs";
import { normalizeDictionary } from "./text-cleanup.mjs";
import { t } from "./i18n.mjs";

export { DATA_DIR };
migrateLegacyDataDir();
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export const DEFAULTS = {
  saveMode: "folder", // obsidian | folder
  obsidianVault: "",
  reviewedPages: [], // 기본값으로도 되는 설정 항목 중 사용자가 한 번 열어 확인한 것 (설정 첫 화면에서 컬러로 바뀜)
  obsidianSubfolder: "녹음 기록",
  customFolder: "", // 처음에는 비어 있다: 사용자가 설정 → 저장 위치에서 고른다 (고르기 전에는 녹음하지 않음)
  teamFolder: "", // 비어 있지 않으면 녹음이 끝날 때 사본을 복사
  frontmatter: true,
  tags: "녹음기록", // Obsidian 태그는 띄어쓰기를 못 쓴다
  language: "ko-KR",
  includeSystemDefault: true,
  silenceMs: 800,
  diarization: true,
  expectedSpeakers: 0, // 0 = 자동
  keepAudio: false,
  hotkey: "alt+KeyR", // 녹음 시작/중지 전역 단축키 (⌥R). 비우면 사용 안 함
  menuBarIcon: true,
  asrModel: "", // 받아쓰기 모델 (lib/model-catalog.mjs의 id). 처음에는 비어 있다: 사용자가 내려받아 "사용하기"로 고른다
  agentEngine: "codex", // 음성 작업 도구: codex | claude
  agentFolder: "", // 지금 고른 작업 폴더 (도구가 이 폴더에서 일한다)
  agentFolders: [], // ✦를 누르면 고르는 작업 폴더 목록 (사용자가 지울 때까지 유지)
  agentPermission: "workspace", // workspace(폴더 안 수정만 바로, 나머지 승인) | read-only | full
  agentSpeak: true, // 답변 첫 문장을 소리로 읽기
  agentModels: {}, // 도구별 모델 (비우면 도구 기본값)
  agentHotkey: "alt+KeyV", // 음성 작업 말하기 단축키 (⌥V)
  dictationHotkey: "alt+KeyD", // 아무 앱에 받아쓰기 단축키 (⌥D): 누르면 듣기, 다시 누르면 지금 앱에 붙여넣기
  dictationFillers: true, // 받아쓰기 모드에서 군말(음, 어, um…)과 바로 이은 반복을 지운다 (회의록은 원문 그대로)
  dictionary: [], // 용어 사전 [{ from, to }]: 받아쓴 뒤 바꾸고, 모델이 지원하면 용어 힌트로도 준다
  summaryProvider: "auto", // 요약 방법: auto(쓸 수 있는 첫 번째) | lib/summarizer.mjs의 PROVIDERS id | off
  summaryModels: {}, // 방법별로 고른 모델 { openai: "...", ollama: "..." }. 비우면 알아서 고른다
  recordFillers: false, // 정리할 때 회의 기록에서도 군말(음, 어, um…)과 바로 이은 반복을 지운다 (기본은 원문 그대로)
  translateForeign: false, // 정리할 때 외국어 줄 아래에 한국어 번역을 붙인다 (voin 내장 모델, 이 맥 안에서)
  summaryCustomUrl: "", // "OpenAI 호환 주소" 방법의 서버 주소 (예: http://localhost:1234/v1)
};

export function loadSettings() {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
    // 목록이 생기기 전에 고른 폴더는 목록에 넣는다
    if (!saved.agentFolders.length && saved.agentFolder) saved.agentFolders = [saved.agentFolder];
    if (saved.saveMode !== "obsidian") saved.saveMode = "folder"; // 예전 "앱 폴더" 설정 포함
    return saved;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("설정 파일을 읽지 못해 기본값을 씁니다:", error.message);
      return { ...DEFAULTS };
    }
    return saveSettings({});
  }
}

// 알려진 키만, 기본값과 같은 타입으로 받아 저장한다
export function saveSettings(input) {
  const next = fs.existsSync(SETTINGS_FILE) ? loadSettings() : { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === "dictionary") {
      next.dictionary = normalizeDictionary(value);
      continue;
    }
    if (Array.isArray(fallback)) next[key] = Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : next[key];
    else if (typeof fallback === "number") next[key] = Number(value) || 0;
    else if (typeof fallback === "object") next[key] = { ...next[key], ...(typeof value === "object" && value ? value : {}) };
    else if (typeof fallback === "boolean") next[key] = Boolean(value);
    else next[key] = String(value ?? "").trim();
  }
  if (next.saveMode !== "obsidian") next.saveMode = "folder";
  next.silenceMs = Math.min(3000, Math.max(300, next.silenceMs));
  next.expectedSpeakers = Math.min(30, Math.max(0, Math.round(next.expectedSpeakers)));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function expandHome(p) {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

// 회의록을 저장할 폴더. 설정한 보관함이 사라졌으면 이유와 함께 오류를 낸다.
// 저장 위치를 골랐는지: 폴더 방식은 폴더, Obsidian 방식은 보관함
export function saveLocationChosen(settings) {
  return settings.saveMode === "obsidian" ? Boolean(settings.obsidianVault) : Boolean(settings.customFolder);
}

export function saveDir(settings) {
  if (settings.saveMode === "obsidian") {
    const vault = expandHome(settings.obsidianVault);
    if (!vault || !fs.existsSync(vault)) throw new Error(t("Obsidian 보관함을 찾을 수 없습니다: {vault}", { vault: vault || t("(선택 안 됨)") }));
    return path.join(vault, settings.obsidianSubfolder || DEFAULTS.obsidianSubfolder);
  }
  if (!settings.customFolder) throw new Error(t("저장 위치를 아직 고르지 않았습니다. 설정 → 저장 위치에서 고르세요."));
  return expandHome(settings.customFolder);
}

// Obsidian 앱이 기억하는 보관함 목록
export function obsidianVaults() {
  const file = path.join(os.homedir(), "Library/Application Support/obsidian/obsidian.json");
  try {
    const { vaults } = JSON.parse(fs.readFileSync(file, "utf8"));
    // 지금 Obsidian에서 열려 있는 보관함, 그다음 최근에 연 순서로 보여 준다 (첫 항목이 기본 선택)
    return Object.values(vaults)
      .filter((v) => fs.existsSync(v.path))
      .sort((a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)) || (b.ts ?? 0) - (a.ts ?? 0))
      .map((v) => ({ path: v.path, name: path.basename(v.path), open: Boolean(v.open) }));
  } catch {
    return [];
  }
}
