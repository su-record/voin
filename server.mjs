// voin 서버: 마이크(화면)와 시스템 오디오(syscap)를 받아쓰고,
// 끝나면 화자 분리 후 설정한 폴더(앱 폴더/Obsidian/직접 지정)에 Markdown으로 저장한다.
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { TranscribeModel } from "transcribe-cpp";
import { WebSocketServer } from "ws";
import { SAMPLE_RATE, WavWriter, convertToWav, readWav } from "./lib/audio.mjs";
import { MeetingRecord, copyToTeamFolder, renameSpeaker, setSummary, transcriptOf } from "./lib/meeting-record.mjs";
import { linkRecord } from "./lib/obsidian-links.mjs";
import { getLang, pickLang, setLang, t } from "./lib/i18n.mjs";
import { verifyKey } from "./lib/license.mjs";
import { isLocalRequest } from "./lib/request-guard.mjs";
import { numbersWarning, uncheckedNumbers } from "./lib/summary-check.mjs";
import { applyDictionary, dictionaryTerms, removeFillers, removeRecordFillers } from "./lib/text-cleanup.mjs";
import { agentHistory, agentLastActivity, createAgent, tagOldHistory } from "./lib/agent.mjs";
import { cancelLogin, logout, startLogin } from "./lib/oauth-login.mjs";
import { nameSuggestions, renameVoices, saveNameSuggestions, voicePath, voiceUrls } from "./lib/voice-samples.mjs";
import { findSummaryModel } from "./lib/summary-catalog.mjs";
import {
  detectProviders,
  listModels as listSummaryModels,
  localSummaryModels,
  memoryGB,
  modelChoice,
  pickProvider,
  refreshModelLists,
  saveApiKey,
  suggestSpeakerNames,
  summarize,
  translateLocal,
} from "./lib/summarizer.mjs";
import { translateRecord } from "./lib/translation.mjs";
import { findCatalogModel } from "./lib/model-catalog.mjs";
import {
  activeModelEntry,
  deleteModel,
  describeDownloadError,
  downloadModel,
  languageFor,
  listModels,
  locateActive,
  partialBytes,
} from "./lib/model-store.mjs";
import { DATA_DIR, loadSettings, obsidianVaults, saveDir, saveSettings } from "./lib/settings.mjs";
import { SourceTranscriber } from "./lib/transcriber.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4310);
// 화면 언어: 맥 앱이 시스템 언어를 VOIN_LANG으로 넘긴다. 앱 없이 띄웠으면(개발 중) 맥 시스템 설정의 언어 목록을 읽는다
// (터미널의 로캘은 시스템 언어와 다를 수 있어 화면과 서버 글이 섞인다)
function systemLanguages() {
  try {
    return execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLanguages"], { encoding: "utf8" }).match(/[\w-]+/g) ?? [];
  } catch {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  }
}
setLang(pickLang(process.env.VOIN_LANG ? [process.env.VOIN_LANG] : systemLanguages()));
const PUBLIC_DIR = path.join(ROOT, "public");
const MODELS_DIR = path.join(ROOT, "models");
const TMP_DIR = path.join(DATA_DIR, "tmp");
const SYSCAP = path.join(ROOT, "native", "syscap");
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function ensureSyscap() {
  if (fs.existsSync(SYSCAP)) return;
  console.log("syscap(시스템 오디오 녹음 도우미)을 처음 빌드합니다...");
  execFileSync("npm", ["run", "build:native"], { cwd: ROOT, stdio: "inherit" });
}

class LiveMeeting {
  constructor({ title, includeSystem, send, settings }) {
    this.send = send;
    this.language = settings.language;
    this.startedAt = Date.now();
    this.systemProcess = null;
    // 시스템 오디오는 무음 구간에 데이터가 안 와서, 녹음 파일 위치 → 실제 시각 대응표를 따로 둔다
    this.systemSamples = 0;
    this.systemTimeline = []; // [샘플 위치, 회의 시작 후 ms]
    this.systemReceived = false;
    this.systemHasSound = false;
    const startedAt = this.startedAt;
    this.record = new MeetingRecord({
      title,
      settings,
      dir: saveDir(settings),
      startedAt,
      sourceDescription: includeSystem ? "마이크 + 화상회의 소리" : "마이크",
      modelsDir: MODELS_DIR,
    });

    fs.mkdirSync(TMP_DIR, { recursive: true });
    const id = randomUUID();
    this.wavFiles = { mic: path.join(TMP_DIR, `${id}-mic.wav`) };
    if (includeSystem) this.wavFiles.system = path.join(TMP_DIR, `${id}-system.wav`);
    this.wavs = Object.fromEntries(Object.entries(this.wavFiles).map(([s, f]) => [s, new WavWriter(f)]));
    // 정리(화자 분리)가 끝나기 전에 앱이 꺼져도 다음 실행 때 이어서 정리할 수 있도록 작업 기록을 남긴다
    this.jobFile = path.join(TMP_DIR, `${id}.json`);
    this.saveJob();
    console.log(`${new Date().toLocaleString("ko-KR")} 녹음 시작: ${this.record.fileName}`);

    const common = {
      transcribe: (pcm) => transcribeText(pcm, settings.language),
      silenceMs: settings.silenceMs,
      startedAt,
      onPartial: (source, text) => send({ type: "partial", source, text }),
      onFinal: (line) => send({ type: "final", ...this.record.addLine(line) }),
      onLevel: (source, level) => send({ type: "level", source, level }),
    };
    this.transcribers = {
      mic: new SourceTranscriber({ ...common, source: "mic", clock: "samples" }),
    };
    if (includeSystem) {
      this.transcribers.system = new SourceTranscriber({ ...common, source: "system", clock: "wall" });
      this.startSystemCapture();
    }
  }

  get fileName() {
    return this.record.fileName;
  }

  saveJob() {
    const { title, filePath, startedAt, endedAt, sourceDescription } = this.record;
    const data = { title, filePath, startedAt, endedAt, sourceDescription, wavFiles: this.wavFiles, systemTimeline: this.systemTimeline };
    fs.writeFileSync(this.jobFile, JSON.stringify(data));
  }

  startSystemCapture() {
    ensureSyscap();
    // SYSCAP_MUTE=1: 자동 테스트에서 스피커로 소리를 내지 않기 위한 옵션
    const args = process.env.SYSCAP_MUTE === "1" ? ["--mute"] : [];
    const child = spawn(SYSCAP, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.systemProcess = child;
    let leftover = Buffer.alloc(0);
    const silentCheck = setTimeout(() => {
      // 권한이 없으면 오류 대신 전부 0인 소리가 들어온다
      if (this.systemProcess && this.systemReceived && !this.systemHasSound) {
        this.send({
          type: "warning",
          message: t("화상회의 소리가 무음으로만 들어옵니다. 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 'voin' 앱(터미널에서 실행했다면 그 터미널 앱)을 허용하세요."),
        });
      }
    }, 15000);
    child.stdout.on("data", (data) => {
      const bytes = Buffer.concat([leftover, data]);
      const usable = bytes.length - (bytes.length % 4);
      leftover = bytes.subarray(usable);
      const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable));
      this.systemReceived = true;
      if (!this.systemHasSound && samples.some((s) => s !== 0)) this.systemHasSound = true;
      const wallMs = Date.now() - this.startedAt - (samples.length * 1000) / SAMPLE_RATE;
      const last = this.systemTimeline.at(-1);
      const expected = last && last[1] + ((this.systemSamples - last[0]) * 1000) / SAMPLE_RATE;
      if (!last || wallMs - expected > 300) this.systemTimeline.push([this.systemSamples, wallMs]);
      this.systemSamples += samples.length;
      this.wavs.system.write(samples);
      this.transcribers.system.push(samples);
    });
    child.stderr.on("data", (data) => console.log(String(data).trim()));
    child.on("exit", (code) => {
      clearTimeout(silentCheck);
      if (this.systemProcess === child && code !== 0) {
        this.send({ type: "warning", message: t("화상회의 소리 녹음이 중단되었습니다 (syscap 종료 코드 {code}). 마이크 받아쓰기는 계속됩니다.", { code }) });
      }
      this.systemProcess = null;
    });
  }

  pushMic(samples) {
    this.wavs.mic.write(samples);
    this.transcribers.mic.push(samples);
  }

  // 앱 종료와 화면 연결 끊김이 동시에 오더라도 한 번만 마무리한다.
  // quick: 앱 종료 중이라 녹음만 닫고, 화자 분리(수 분)는 다음 실행 때 이어서 한다
  stop({ quick = false } = {}) {
    this.closing ??= this.closeRecording();
    if (quick) return this.closing;
    this.stopping ??= this.closing.then(() => this.finish());
    return this.stopping;
  }

  async closeRecording() {
    const child = this.systemProcess;
    this.systemProcess = null;
    child?.kill("SIGTERM");
    await Promise.all(Object.values(this.transcribers).map((t) => t.stop()));
    for (const wav of Object.values(this.wavs)) wav.close();
    this.record.endedAt = Date.now();
    this.record.write();
    this.saveJob();
    console.log(`${new Date().toLocaleString("ko-KR")} 녹음 종료: ${this.record.fileName} (${Math.round((this.record.endedAt - this.startedAt) / 60000)}분, 줄 ${this.record.lines.length}개)`);
  }

  async finish() {
    const t0 = Date.now();
    const warning = await this.record.finish({
      wavFiles: this.wavFiles,
      transcribe: (_, pcm) => transcribeText(pcm, this.language),
      toOffsetMs: (source, sample) => this.toOffsetMs(source, sample),
      onProgress: (message) => {
        job = message;
        this.send({ type: "processing", message });
      },
    });
    fs.rmSync(this.jobFile, { force: true });
    if (this.record.discarded) {
      console.log(`${new Date().toLocaleString("ko-KR")} 빈 녹음이라 저장하지 않음: ${this.record.fileName}`);
      return EMPTY_RECORDING;
    }
    const summaryWarning = await completeRecord(this.record.filePath, (message) => {
      job = message;
      this.send({ type: "processing", message });
    });
    const warnings = [warning, summaryWarning].filter(Boolean).join(" ") || undefined;
    console.log(`${new Date().toLocaleString("ko-KR")} 정리 완료: ${this.record.fileName} (${Math.round((Date.now() - t0) / 1000)}초)${warnings ? ` 경고: ${warnings}` : ""}`);
    return warnings;
  }

  toOffsetMs(source, sample) {
    return offsetFromTimeline(source === "system" ? this.systemTimeline : [], sample);
  }
}

// 녹음 파일 위치(샘플) → 회의 시작 후 ms. 시스템 오디오는 무음 구간이 빠져 있어 대응표로 계산한다.
function offsetFromTimeline(timeline, sample) {
  const anchor = timeline.findLast(([pos]) => pos <= sample) ?? [0, 0];
  return anchor[1] + ((sample - anchor[0]) * 1000) / SAMPLE_RATE;
}

// 설정에서 켰으면 외국어 줄 아래에 한국어 번역을 붙인다. 실패하면 경고 글을 돌려준다(기록은 그대로).
async function translateFile(filePath, settings, onProgress) {
  if (!settings.translateForeign) return undefined;
  onProgress(t("외국어 번역 중…"));
  try {
    await translateRecord(filePath, (text) => translateLocal(text, settings.summaryModels.voin));
  } catch (error) {
    console.error("번역 실패:", error);
    return t("번역하지 못했습니다: {message}", { message: error.message });
  }
}

// 기록 파일에 요약을 붙인다. 설정에서 끄거나 쓸 도구가 없으면 건너뛴다. 실패하면 경고 글을 돌려준다(기록은 그대로).
async function summarizeFile(filePath, onProgress, { required = false } = {}) {
  const settings = loadSettings();
  const setting = required && settings.summaryProvider === "off" ? "auto" : settings.summaryProvider;
  const options = { customUrl: settings.summaryCustomUrl };
  const provider = await pickProvider(setting, options);
  if (!provider) {
    return required || setting !== "auto"
      ? t("요약하지 못했습니다: 쓸 수 있는 요약 방법이 없습니다. 설정 → 요약에서 확인하세요.")
      : undefined;
  }
  const transcript = transcriptOf(filePath);
  if (!transcript.trim()) return undefined;
  onProgress(t("요약 중 ({name})…", { name: provider.name }));
  try {
    const { text, by } = await summarize(provider, transcript, { ...options, model: settings.summaryModels[provider.id] });
    // 요약의 날짜·숫자가 기록에 없으면 요약 아래에 경고를 붙인다 (작은 모델이 날짜를 잘못 옮기는 일이 있다)
    const warning = numbersWarning(uncheckedNumbers(text, transcript));
    setSummary(filePath, warning ? `${text}\n\n${warning}` : text, by);
    console.log(`${new Date().toLocaleString("ko-KR")} 요약 완료: ${path.basename(filePath)} (${by})`);
  } catch (error) {
    console.error("요약 실패:", error);
    return t("{message} 받아쓴 기록은 저장되었습니다.", { message: error.message });
  }
}

// 이름 없는 화자("화자 N")가 있으면 요약 도구로 이름 후보를 찾아 둔다 (화면의 참석자 카드에 추천으로 보임). 실패해도 넘어간다.
async function suggestNames(filePath, onProgress, { required = false } = {}) {
  const settings = loadSettings();
  const setting = required && settings.summaryProvider === "off" ? "auto" : settings.summaryProvider;
  const transcript = transcriptOf(filePath);
  if (!/\*\*(화자|원격) \d+\*\*:/.test(transcript)) return;
  const options = { customUrl: settings.summaryCustomUrl };
  const provider = await pickProvider(setting, options);
  if (!provider) return;
  onProgress(t("화자 이름 후보 찾는 중 ({name})…", { name: provider.name }));
  try {
    const found = await suggestSpeakerNames(provider, transcript, { ...options, model: settings.summaryModels[provider.id] });
    saveNameSuggestions(path.basename(filePath, ".md"), found);
    console.log(`${new Date().toLocaleString("ko-KR")} 이름 후보: ${path.basename(filePath)} ${JSON.stringify(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.name])))}`);
  } catch (error) {
    console.error("이름 후보 찾기 실패:", error.message);
  }
}

// 정리가 끝난 기록의 마무리: 요약 → Obsidian 연결 → 팀 공유 폴더 사본(요약·연결이 들어간 최신본). 경고 글을 모아 돌려준다.
async function completeRecord(filePath, onProgress, options) {
  const settings = loadSettings();
  if (settings.recordFillers) fs.writeFileSync(filePath, removeRecordFillers(fs.readFileSync(filePath, "utf8")));
  const warnings = [await translateFile(filePath, settings, onProgress)];
  warnings.push(await summarizeFile(filePath, onProgress, options));
  await suggestNames(filePath, onProgress, options);
  try {
    linkRecord(filePath, { frontmatter: settings.frontmatter });
  } catch (error) {
    console.error("Obsidian 연결 실패:", error);
  }
  warnings.push(copyToTeamFolder(filePath, settings.teamFolder));
  return warnings.filter(Boolean).join(" ") || undefined;
}

// 앱이 정리 중에(또는 녹음 중에) 꺼져 남은 회의를 이어서 정리한다.
// 받아쓰기 모델은 새 녹음과 함께 쓴다 (계산은 차례로 처리되어 새 녹음을 막지 않는다).
let recoveryRunning = false;
async function resumePendingMeetings() {
  if (recoveryRunning || !fs.existsSync(TMP_DIR)) return;
  const jobs = fs.readdirSync(TMP_DIR).filter((f) => f.endsWith(".json"));
  if (!jobs.length) return;
  recoveryRunning = true;
  try {
    for (const jobName of jobs) {
      const jobFile = path.join(TMP_DIR, jobName);
      let pending;
      try {
        pending = JSON.parse(fs.readFileSync(jobFile, "utf8"));
      } catch {
        fs.rmSync(jobFile, { force: true });
        continue;
      }
      const wavFiles = Object.fromEntries(Object.entries(pending.wavFiles).filter(([, f]) => fs.existsSync(f)));
      if (!fs.existsSync(pending.filePath) || !Object.keys(wavFiles).length) {
        Object.values(wavFiles).forEach((f) => fs.rmSync(f, { force: true }));
        fs.rmSync(jobFile, { force: true });
        continue;
      }
      console.log(`중단된 녹음 이어서 정리: ${pending.filePath}`);
      const settings = loadSettings();
      const record = new MeetingRecord({
        title: pending.title,
        settings,
        dir: path.dirname(pending.filePath),
        startedAt: pending.startedAt,
        sourceDescription: pending.sourceDescription,
        modelsDir: MODELS_DIR,
        filePath: pending.filePath,
      });
      // 녹음 중에 꺼졌으면 끝난 시각이 없다: 녹음 길이로 계산한다
      record.endedAt = pending.endedAt ?? pending.startedAt + (readWav(wavFiles.mic ?? Object.values(wavFiles)[0]).length * 1000) / SAMPLE_RATE;
      const label = `'${pending.title}'`;
      const warning = await record.finish({
        wavFiles,
        transcribe: (_, pcm) => transcribeText(pcm, settings.language),
        toOffsetMs: (source, sample) => offsetFromTimeline(source === "system" ? pending.systemTimeline ?? [] : [], sample),
        onProgress: (message) => {
          job = t("중단된 녹음 {label} 정리 중 · {message}", { label, message });
          broadcast({ type: "recovery-progress", message: job });
        },
      });
      fs.rmSync(jobFile, { force: true });
      if (record.discarded) {
        broadcast({ type: "recovery-done", file: null, message: t("중단된 녹음 {label}은 받아쓴 말이 없어 남기지 않았습니다.", { label }) });
        continue;
      }
      const summaryWarning = await completeRecord(record.filePath, (message) => {
        job = t("중단된 녹음 {label} 정리 중 · {message}", { label, message });
        broadcast({ type: "recovery-progress", message: job });
      });
      broadcast({
        type: "recovery-done",
        file: record.fileName,
        warning: [warning, summaryWarning].filter(Boolean).join(" ") || undefined,
        message: t("중단된 녹음 {label} 정리를 마쳤습니다.", { label }),
      });
    }
  } catch (error) {
    console.error("중단된 녹음 정리 실패:", error);
    broadcast({ type: "recovery-error", message: t("중단된 녹음을 정리하지 못했습니다: {message}", { message: error.message }) });
  } finally {
    job = null;
    recoveryRunning = false;
  }
}

const EMPTY_RECORDING = t("받아쓴 말이 없어 기록을 남기지 않았습니다.");

// ───────── 지금 상황 알아채기 ─────────
// 화면의 상태 줄(마이크·출력·회의 앱)에 쓴다. 이어폰 없이 스피커로 들으면 상대방 말이 마이크로 다시 들어와 두 번 기록된다.
const MEETING_APPS = [
  { name: "Zoom", inMeeting: /\/CptHost$/, running: /zoom\.us\.app\/Contents\/MacOS\/zoom\.us$/ },
  { name: "Teams", running: /(MSTeams|Microsoft Teams)$/ },
  { name: "Webex", running: /Webex\.app\/Contents\/MacOS\/Webex$/ },
  { name: "FaceTime", running: /FaceTime\.app\/Contents\/MacOS\/FaceTime$/ },
];
function sh(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000, maxBuffer: 4 << 20 }, (error, stdout) => resolve(error ? "" : stdout)));
}
async function currentContext() {
  const [audioJson, processes] = await Promise.all([sh("/usr/sbin/system_profiler", ["SPAudioDataType", "-json"]), sh("/bin/ps", ["-axo", "comm"])]);
  let input = null;
  let output = null;
  try {
    for (const group of JSON.parse(audioJson).SPAudioDataType ?? []) {
      for (const d of group._items ?? []) {
        const transport = String(d.coreaudio_device_transport ?? "").replace("coreaudio_device_type_", "");
        if (d.coreaudio_default_audio_input_device === "spaudio_yes") input = { name: d._name, transport };
        if (d.coreaudio_default_audio_output_device === "spaudio_yes") output = { name: d._name, transport, speaker: transport === "builtin" && !/헤드폰|headphone/i.test(d._name) };
      }
    }
  } catch {}
  const lines = processes.split("\n");
  const app = MEETING_APPS.map((a) => ({ name: a.name, inMeeting: a.inMeeting ? lines.some((l) => a.inMeeting.test(l)) : false, running: lines.some((l) => a.running.test(l)) })).find((a) => a.inMeeting || a.running);
  return { input, output, app: app ?? null };
}

// ───────── 음성 작업 (lib/agent.mjs) ─────────
tagOldHistory(loadSettings().agentFolder);
let agentAnswer = ""; // 소리로 읽을 답 (첫 문장)
const agent = createAgent({
  voinUrl: `http://127.0.0.1:${PORT}`,
  emit: (message) => {
    if (message.type === "agent-start") {
      agentAnswer = "";
      job = t("작업 중…");
    }
    if (message.type === "agent-delta") agentAnswer += message.text;
    if (message.type === "agent-done") {
      job = null;
      speak(message.error ? t("작업이 실패했어요.") : spokenAnswer(agentAnswer || message.text));
    }
    broadcast(message);
  },
});

// 소리로 읽을 답: 코드·표·기호를 빼고 앞의 3문장(최대 300자)까지. 긴 내용은 화면에서 본다
function spokenAnswer(text) {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#>\[\]()|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/.+?(?:[.!?。](?=\s|$)|$)/g) ?? []; // report.md 같은 점은 끊지 않는다
  let out = "";
  for (const s of sentences.slice(0, 3)) {
    if (out && (out + s).length > 300) break;
    out += s;
  }
  return (out || plain.slice(0, 300)).trim();
}

// macOS 음성(유나)으로 읽어 준다. 설정에서 끌 수 있다.
// 대화 모드로 듣는 중이면, 다 읽은 뒤 띵 소리로 "이제 말하세요"를 알린다
let speaking = null;
const dictations = new Set();
const yourTurn = () => {
  if (!dictations.size) return;
  spawn("/usr/bin/afplay", ["-v", "0.4", "/System/Library/Sounds/Tink.aiff"], { stdio: "ignore" });
  for (const d of dictations) d.send({ type: "dictate-ready" });
};
function speak(text) {
  if (!text || !loadSettings().agentSpeak) return yourTurn();
  speaking?.kill();
  // 화면 언어에 맞는 맥 기본 목소리 (파일 저장이 아니라 바로 읽어서 어느 목소리든 된다)
  const voice = { ko: "Yuna", ja: "Kyoko", en: "Samantha" }[getLang()];
  const me = spawn("/usr/bin/say", ["-v", voice, text], { stdio: "ignore" });
  speaking = me;
  me.on("exit", (code, signal) => signal !== "SIGTERM" && speaking === me && yourTurn());
}

// 대화 모드 말하기: ✦를 한 번 누르면 마이크가 켜진 채로 계속 듣는다. 말이 1.5초 멈출 때마다 그 말을 보내고 다시 듣는다.
// 말하는 동안에는 짧게 끊어 미리보기만 보여 주고, 보낼 때는 그 말 전체를 한 번에 다시 받아쓴다(짧은 조각은 맥락이 없어 틀리기 쉽다).
// voin이 답을 소리로 읽는 동안에는 자기 목소리를 듣지 않도록 마이크 소리를 버린다. 2분 동안 말이 없으면 스스로 끈다.
const DICTATION_IDLE_MS = 2 * 60 * 1000;
class Dictation {
  // mode: "agent" = 말이 멈출 때마다 작업으로 보냄 | "paste" = 끝낼 때(⌥D 다시) 한 번에 받아써서 지금 앱에 붙여넣기
  constructor(send, language, mode = "agent") {
    this.send = send;
    this.language = language;
    this.mode = mode;
    this.done = false;
    this.ready = false;
    this.lastVoiceAt = Date.now();
    dictations.add(this);
    // 작업 중이거나 답을 읽는 동안은 기다리는 시간으로 치지 않는다
    this.idleTimer = setInterval(() => {
      if (agent.busy || (speaking && speaking.exitCode === null)) this.lastVoiceAt = Date.now();
      else if (Date.now() - this.lastVoiceAt > DICTATION_IDLE_MS) this.finish(t("2분 동안 말이 없어 듣기를 멈췄습니다."));
    }, 5000);
    this.resetSegment();
  }
  resetSegment() {
    this.chunks = [];
    this.preview = [];
    this.heard = false;
    clearTimeout(this.timer);
    this.transcriber = new SourceTranscriber({
      transcribe: (pcm) => transcribeText(pcm, this.language),
      source: "mic",
      silenceMs: 700,
      clock: "samples",
      startedAt: Date.now(),
      onPartial: (_, text) => {
        if (text) {
          clearTimeout(this.timer);
          this.lastVoiceAt = Date.now();
        }
        if (!this.done) this.send({ type: "dictate-partial", text: [...this.preview, text].join(" ").trim() });
      },
      onFinal: (line) => {
        this.heard = true;
        this.lastVoiceAt = Date.now();
        this.preview.push(line.text);
        this.send({ type: "dictate-partial", text: this.preview.join(" ") });
        clearTimeout(this.timer);
        if (this.mode === "agent") this.timer = setTimeout(() => this.emitSegment(), 1500);
      },
      onLevel: () => {},
    });
  }
  push(samples) {
    if (this.done) return;
    // 마이크 소리가 실제로 들어오기 시작한 때를 알린다: 신호음 + 화면의 "말하세요" (그 전에 한 말은 녹음되지 않는다)
    if (!this.ready) {
      this.ready = true;
      spawn("/usr/bin/afplay", ["-v", "0.4", "/System/Library/Sounds/Tink.aiff"], { stdio: "ignore" });
      this.send({ type: "dictate-ready" });
    }
    if (speaking && speaking.exitCode === null) return; // voin이 말하는 중: 자기 목소리를 받아쓰지 않는다
    this.chunks.push(samples);
    this.transcriber.push(samples);
  }
  // 말 한마디가 끝났다: 그 말 전체를 다시 받아써서 보내고, 다음 말을 들을 준비
  async emitSegment() {
    const { chunks, preview, heard, transcriber } = this;
    this.resetSegment();
    await transcriber.stop();
    if (!heard) return;
    let text = preview.join(" ");
    const seconds = chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
    if (seconds <= 12) text = (await transcribeWhole(chunks, this.language).catch(() => "")) || text;
    if (text.trim()) this.send({ type: "dictation", text: text.trim() });
  }
  // discard: 하던 말을 보내지 않고 끝낸다 (녹음을 시작했거나 화면이 닫혔을 때)
  async finish(reason, { discard = false } = {}) {
    if (this.done) return;
    this.done = true;
    dictations.delete(this);
    clearInterval(this.idleTimer);
    clearTimeout(this.timer);
    if (this.heard && !discard) {
      const { chunks, preview, transcriber } = this;
      await transcriber.stop();
      const seconds = chunks.reduce((n, c) => n + c.length, 0) / SAMPLE_RATE;
      let text = preview.join(" ");
      // 붙여넣기 모드는 길어도 전체를 다시 받아쓴다 (끊긴 조각보다 정확하고, 실시간으로 보낼 필요가 없다)
      if (seconds <= 12 || this.mode === "paste") text = (await transcribeWhole(chunks, this.language).catch(() => "")) || text;
      if (this.mode === "paste") {
        // 사전은 transcribeText에서 이미 바꿨다 (두 번 바꾸지 않게 여기선 군말만)
        if (loadSettings().dictationFillers) text = removeFillers(text);
      }
      if (text.trim()) this.send({ type: "dictation", text: text.trim(), mode: this.mode });
    } else {
      await this.transcriber.stop();
    }
    this.send({ type: "dictate-end", reason: reason ?? null });
  }
}

// 이어 붙인 소리에서 앞뒤 무음을 걷어 내고, 25초씩(그보다 짧으면 한 번에) 받아쓴다
async function transcribeWhole(chunks, language) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  const frame = SAMPLE_RATE / 10;
  const loud = (i) => {
    let sum = 0;
    for (let k = i; k < Math.min(i + frame, pcm.length); k++) sum += pcm[k] * pcm[k];
    return Math.sqrt(sum / frame) > 0.01;
  };
  let start = 0;
  while (start < pcm.length && !loud(start)) start += frame;
  let end = pcm.length;
  while (end > start && !loud(end - frame)) end -= frame;
  start = Math.max(0, start - frame * 5);
  end = Math.min(pcm.length, end + frame * 3);
  const parts = [];
  for (let a = start; a < end; a += SAMPLE_RATE * 25) parts.push((await transcribeText(pcm.subarray(a, Math.min(end, a + SAMPLE_RATE * 25)), language)).trim());
  return parts.filter(Boolean).join(" ");
}

// 모델을 쓰는 작업(실시간 회의 또는 파일 불러오기)은 한 번에 하나만
let activeMeeting = null;
let busy = null;
// 녹음 뒤 정리·파일 불러오기·중단된 회의 정리의 진행 글. 메뉴 막대 아이콘이 /api/status로 읽는다
// (앱 창이 안 보이면 웹 화면이 멈춰, 아이콘은 화면이 아니라 서버에 직접 묻는다)
let job = null;
const summarizing = new Set(); // 지금 요약 중인 기록 파일
const clients = new Set();
const broadcast = (message) => {
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
};

// 받아쓰기 모델: 설정에서 고른 모델 하나를 불러와 마이크·화상회의·불러오기·복구가 함께 쓴다.
// 상태(activeState): loading | missing | downloading | error | ready. 화면 맨 위 줄과 메뉴 막대에 표시된다.
let asr = null; // { entry, path, model }
let activeState = { state: "loading" };
let download = null; // { id, abort, progress }

// 받아쓰기 한 번: 용어 사전은 모델이 지원하면 힌트(vocabulary)로 주고, 결과에도 낱말 경계 기준으로 치환한다 (회의록·받아쓰기 모두)
async function transcribeText(pcm, language) {
  const lang = languageFor(asr.model, language);
  const { dictionary } = loadSettings();
  const options = lang ? { language: lang } : {};
  const terms = dictionaryTerms(dictionary);
  if (terms.length && supportsVocabulary(asr.model)) options.vocabulary = terms;
  return applyDictionary((await asr.model.transcribe(pcm, options)).text, dictionary);
}
function supportsVocabulary(model) {
  try {
    return Boolean(model.supports?.("vocabulary"));
  } catch {
    return false;
  }
}

function setActiveState(next) {
  const entry = activeModelEntry(loadSettings());
  activeState = { id: entry?.id ?? null, name: entry?.name ?? null, sizeMB: entry ? Math.round(entry.size / 1e6) : null, ...next };
  broadcast({ type: "model", ...activeState });
}

// 고른 모델을 불러온다. 없으면 missing으로 두고 내려받기를 안내한다.
async function loadActiveModel() {
  const entry = activeModelEntry(loadSettings());
  // 아직 고른 모델이 없다: 설정의 받아쓰기 모델 목록에서 고르게 한다
  if (!entry) {
    asr?.model.dispose();
    asr = null;
    return setActiveState({ state: "missing", canDownload: false, paused: false });
  }
  const found = locateActive(entry, MODELS_DIR);
  if (!found) {
    asr?.model.dispose();
    asr = null;
    return setActiveState({ state: "missing", canDownload: !entry.custom, paused: partialBytes(entry) > 0 });
  }
  if (asr?.path === found.path) return setActiveState({ state: "ready", path: found.path, source: found.source });
  setActiveState({ state: "loading" });
  console.log(`모델 로드 중: ${found.path}`);
  try {
    const model = await TranscribeModel.load(found.path);
    asr?.model.dispose();
    asr = { entry, path: found.path, model };
    setActiveState({ state: "ready", path: found.path, source: found.source });
    resumePendingMeetings();
  } catch (error) {
    console.error("모델 로드 실패:", error);
    setActiveState({ state: "error", message: t("모델을 불러오지 못했습니다: {message}", { message: error.message }), canDownload: found.source === "downloaded" });
  }
}

// 모델 하나를 내려받는다(한 번에 하나). 지금 고른 모델이면 받은 뒤 바로 불러온다.
async function startDownload(entry) {
  if (download) return;
  download = { id: entry.id, abort: new AbortController(), progress: { received: partialBytes(entry), total: entry.size } };
  const isActive = () => activeModelEntry(loadSettings())?.id === entry.id;
  const report = () => {
    broadcast({ type: "models-changed" });
    if (isActive()) setActiveState({ state: "downloading", ...download.progress });
  };
  report();
  try {
    await downloadModel(entry, {
      signal: download.abort.signal,
      onProgress: (p) => {
        download.progress = p;
        report();
      },
    });
    download = null;
    broadcast({ type: "models-changed" });
    if (isActive()) await loadActiveModel();
  } catch (error) {
    download = null;
    broadcast({ type: "models-changed" });
    if (error.name !== "AbortError") console.error("모델 내려받기 실패:", error);
    if (!isActive()) {
      if (error.name !== "AbortError") broadcast({ type: "models-error", id: entry.id, message: describeDownloadError(error) });
      return;
    }
    if (error.name === "AbortError") return setActiveState({ state: "missing", canDownload: true, paused: true });
    setActiveState({ state: "error", message: describeDownloadError(error), canDownload: true });
  }
}

// voin 내장 요약 모델 내려받기 (받아쓰기 모델과 따로, 한 번에 하나)
let llmDownload = null; // { id, abort, progress }
async function startLlmDownload(entry) {
  if (llmDownload) return;
  llmDownload = { id: entry.id, abort: new AbortController(), progress: { received: partialBytes(entry), total: entry.size } };
  const report = () => broadcast({ type: "summary-models-changed" });
  report();
  try {
    await downloadModel(entry, {
      signal: llmDownload.abort.signal,
      onProgress: (p) => {
        llmDownload.progress = p;
        report();
      },
    });
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("요약 모델 내려받기 실패:", error);
      broadcast({ type: "summary-models-error", id: entry.id, message: describeDownloadError(error) });
    }
  } finally {
    llmDownload = null;
    await detectProviders({ refresh: true });
    report();
  }
}

function summaryModelsPayload() {
  const models = localSummaryModels(loadSettings().summaryModels.voin);
  return { memoryGB: memoryGB(), models: models.map((m) => ({ ...m, downloading: llmDownload?.id === m.id ? llmDownload.progress : null })) };
}

function modelsPayload() {
  const activeId = activeModelEntry(loadSettings())?.id ?? null;
  return {
    activeId,
    active: activeState,
    models: listModels(MODELS_DIR).map((m) => ({
      ...m,
      active: m.id === activeId,
      downloading: download?.id === m.id ? download.progress : null,
    })),
  };
}

function modelNotReady() {
  if (activeState.state === "ready") return null;
  if (activeState.state === "loading") return t("받아쓰기 모델을 불러오는 중입니다. 잠시 후 다시 시도하세요.");
  return t("받아쓰기 모델이 아직 없습니다. 설정 → 받아쓰기 모델에서 내려받으세요.");
}

async function runImport({ inputFile, originalName, title }) {
  const settings = loadSettings();
  const wavFile = path.join(TMP_DIR, `${randomUUID()}-file.wav`);
  const progress = (message) => {
    job = message;
    broadcast({ type: "import-progress", message });
  };
  try {
    progress(t("파일 변환 중…"));
    await convertToWav(inputFile, wavFile);
    const samples = readWav(wavFile);
    const startedAt = Date.now();
    const record = new MeetingRecord({
      title: title || path.parse(originalName).name,
      settings,
      dir: saveDir(settings),
      startedAt,
      sourceDescription: `녹음 파일 (${originalName})`,
      modelsDir: MODELS_DIR,
    });
    const transcriber = new SourceTranscriber({
      transcribe: (pcm) => transcribeText(pcm, settings.language),
      source: "file",
      silenceMs: settings.silenceMs,
      clock: "samples",
      startedAt,
      onFinal: (line) => record.addLine(line),
    });
    await transcriber.run(samples, (ratio) => progress(t("받아쓰는 중… {percent}%", { percent: Math.round(ratio * 100) })));
    record.endedAt = startedAt + (samples.length * 1000) / SAMPLE_RATE;
    const warning = await record.finish({
      wavFiles: { file: wavFile },
      transcribe: (_, pcm) => transcribeText(pcm, settings.language),
      onProgress: progress,
    });
    if (record.discarded) {
      broadcast({ type: "import-done", file: null, warning: t("'{name}'에서 받아쓴 말이 없어 기록을 남기지 않았습니다.", { name: originalName }) });
      return;
    }
    const summaryWarning = await completeRecord(record.filePath, progress);
    broadcast({ type: "import-done", file: record.fileName, warning: [warning, summaryWarning].filter(Boolean).join(" ") || undefined });
  } catch (error) {
    console.error("파일 불러오기 실패:", error);
    fs.rmSync(wavFile, { force: true });
    broadcast({ type: "import-error", message: error.message });
  } finally {
    fs.rmSync(inputFile, { force: true });
    job = null;
    busy = null;
  }
}

function meetingPath(fileParam) {
  const file = path.basename(decodeURIComponent(fileParam));
  const filePath = path.join(saveDir(loadSettings()), file);
  if (!file.endsWith(".md") || !fs.existsSync(filePath)) throw Object.assign(new Error(t("기록을 찾을 수 없습니다")), { status: 404 });
  return filePath;
}

// 목록에 보여 줄 요약: 파일 앞부분의 Obsidian 속성(제목·날짜·시간·길이·참석자)만 읽는다
function meetingSummary(filePath, file) {
  const fallback = file.replace(/\.md$/, "");
  const [, date, hhmm] = fallback.match(/^(\d{4}-\d{2}-\d{2}) (\d{4})/) ?? [];
  const summary = { title: fallback, date: date ?? null, start: hhmm ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : null, duration: null, speakers: 0 };
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(4096);
    const head = buffer.subarray(0, fs.readSync(fd, buffer, 0, 4096, 0)).toString("utf8");
    fs.closeSync(fd);
    const fm = head.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const value = (key) => fm.match(new RegExp(`^${key}: "?(.*?)"?$`, "m"))?.[1];
    summary.title = value("title") ?? head.match(/^# (.+)$/m)?.[1] ?? fallback;
    summary.duration = value("duration") ?? null;
    summary.speakers = (fm.match(/participants:\n((?:\s+- .*\n?)*)/)?.[1].match(/- /g) ?? []).length;
  } catch {}
  return summary;
}

function listMeetings() {
  const settings = loadSettings();
  let dir;
  try {
    dir = saveDir(settings);
  } catch (error) {
    return { dir: null, error: error.message, items: [] };
  }
  if (!fs.existsSync(dir)) return { dir, items: [] };
  const items = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((file) => ({ file, ...meetingSummary(path.join(dir, file), file) }));
  return { dir, items };
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

const CONTENT_TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

async function handleApi(req, res, url) {
  const json = (status, data) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/settings") {
    const diarizationReady = fs.existsSync(path.join(MODELS_DIR, "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"));
    const settings = loadSettings();
    let currentDir = null;
    try {
      currentDir = saveDir(settings);
    } catch (error) {
      currentDir = error.message;
    }
    return json(200, { settings, vaults: obsidianVaults(), diarizationReady, appVersion: APP_VERSION, saveDir: currentDir });
  }
  if (route === "GET /api/model") return json(200, activeState);
  // 허용 키 상태 (키 자체는 돌려주지 않는다)
  if (route === "GET /api/license") {
    const key = loadSettings().accessKey;
    if (!key) return json(200, { state: "none" });
    const r = verifyKey(key);
    return json(200, r.ok ? { state: "ok", ...r.payload } : { state: r.reason, expires: r.payload?.expires ?? null });
  }
  if (route === "GET /api/status") {
    const live = activeMeeting && !activeMeeting.closing ? activeMeeting : null;
    return json(200, { recording: Boolean(live), startedAt: live?.startedAt ?? null, processing: job, model: activeState });
  }
  if (route === "POST /api/model/download") {
    if (activeState.state === "ready" || activeState.state === "loading") return json(409, { error: t("모델이 이미 있습니다.") });
    const entry = activeModelEntry(loadSettings());
    if (!entry) return json(409, { error: t("받아쓰기 모델을 고르지 않았습니다. 설정 → 받아쓰기 모델에서 고르세요.") });
    startDownload(entry);
    return json(202, {});
  }
  if (route === "GET /api/models") return json(200, modelsPayload());
  const modelRoute = url.pathname.match(/^\/api\/models\/([\w.-]+)\/(download|cancel|delete|use)$/);
  if (modelRoute && req.method === "POST") {
    const entry = findCatalogModel(modelRoute[1]);
    if (!entry) return json(404, { error: t("없는 모델입니다.") });
    const action = modelRoute[2];
    if (action === "download") {
      if (download && download.id !== entry.id) return json(409, { error: t("다른 모델을 내려받는 중입니다. 끝난 뒤 다시 시도하세요.") });
      startDownload(entry);
      return json(202, {});
    }
    if (action === "cancel") {
      if (download?.id === entry.id) download.abort.abort();
      return json(200, {});
    }
    if (action === "delete") {
      if (activeModelEntry(loadSettings())?.id === entry.id) return json(409, { error: t("지금 쓰는 모델은 지울 수 없습니다. 다른 모델을 먼저 고르세요.") });
      if (download?.id === entry.id) return json(409, { error: t("내려받는 중입니다. 먼저 취소하세요.") });
      deleteModel(entry);
      broadcast({ type: "models-changed" });
      return json(200, {});
    }
    // use: 녹음·불러오기·복구 중에는 모델을 바꾸지 않는다
    if (busy || recoveryRunning) return json(409, { error: t("녹음이나 정리가 끝난 뒤에 모델을 바꿀 수 있습니다.") });
    saveSettings({ asrModel: entry.id });
    await loadActiveModel();
    broadcast({ type: "models-changed" });
    return json(200, modelsPayload());
  }
  if (route === "POST /api/model/reveal") {
    if (activeState.path) execFile("open", ["-R", activeState.path]);
    return json(200, {});
  }
  if (route === "POST /api/reveal-log") {
    const log = path.join(os.homedir(), "Library/Logs/voin.log");
    execFile("open", fs.existsSync(log) ? ["-R", log] : [path.dirname(log)]);
    return json(200, {});
  }
  if (route === "POST /api/model/cancel") {
    download?.abort.abort();
    return json(200, {});
  }
  if (route === "POST /api/settings") return json(200, { settings: saveSettings(await readJson(req)) });
  if (route === "GET /api/meetings") return json(200, listMeetings());

  if (route === "POST /api/open-folder") {
    const dir = saveDir(loadSettings());
    fs.mkdirSync(dir, { recursive: true });
    execFile("open", [dir]);
    return json(200, {});
  }

  if (route === "POST /api/import") {
    if (modelNotReady()) return json(409, { error: modelNotReady() });
    if (busy) return json(409, { error: busy === "meeting" ? t("녹음 중에는 파일을 불러올 수 없습니다.") : t("다른 파일을 처리하는 중입니다.") });
    busy = "import";
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const originalName = path.basename(url.searchParams.get("name") || "녹음.m4a");
    const inputFile = path.join(TMP_DIR, `${randomUUID()}${path.extname(originalName)}`);
    try {
      await pipeline(req, fs.createWriteStream(inputFile));
    } catch (error) {
      busy = null;
      throw error;
    }
    json(202, {});
    runImport({ inputFile, originalName, title: url.searchParams.get("title") ?? "" });
    return;
  }

  if (route === "GET /api/context") return json(200, await currentContext());
  if (route === "GET /api/agent") {
    const s = loadSettings();
    return json(200, { busy: Boolean(agent.busy), folder: s.agentFolder, history: agentHistory(s.agentFolder) });
  }
  // 작업 도구별 준비 상태: Codex·Claude Code는 요약 쪽 점검을 함께 쓰고, Grok Build는 grok 명령과 로그인 파일로 본다
  if (route === "GET /api/agent/engines") {
    const providers = await detectProviders();
    const cli = (id) => providers.find((p) => p.id === id);
    const grokInstalled = await new Promise((resolve) => execFile("/bin/zsh", ["-lc", "command -v grok"], { timeout: 10000 }, (e, out) => resolve(!e && out.trim().startsWith("/"))));
    const grokLoggedIn = fs.existsSync(path.join(os.homedir(), ".grok", "auth.json")) || Boolean(process.env.XAI_API_KEY);
    return json(200, {
      engines: [
        { id: "codex", ready: Boolean(cli("codex")?.ready), status: cli("codex")?.status },
        { id: "claude", ready: Boolean(cli("claude")?.ready), status: cli("claude")?.status },
        { id: "grok", ready: grokInstalled && grokLoggedIn, status: !grokInstalled ? t("설치 안 됨") : grokLoggedIn ? t("설치됨 · 로그인됨") : t("로그인 필요 — 터미널에서 'grok login'") },
      ],
    });
  }
  // 작업 폴더 목록: ✦를 누르면 여기서 고른다. add·remove·select 중 하나를 보낸다
  if (route === "GET /api/agent/folders" || route === "POST /api/agent/folders") {
    let s = loadSettings();
    if (req.method === "POST") {
      const { add, remove, select } = await readJson(req);
      const target = add ?? select;
      if (target !== undefined) {
        if (agent.busy && target !== s.agentFolder) return json(409, { error: t("작업이 끝난 뒤 폴더를 바꿀 수 있습니다.") });
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return json(400, { error: t("폴더를 찾을 수 없습니다.") });
        s = saveSettings({ agentFolder: target, agentFolders: [target, ...s.agentFolders.filter((f) => f !== target)] });
      }
      if (remove !== undefined) {
        const rest = s.agentFolders.filter((f) => f !== remove);
        s = saveSettings({ agentFolders: rest, agentFolder: s.agentFolder === remove ? (rest[0] ?? "") : s.agentFolder });
      }
    }
    const last = agentLastActivity();
    const folders = s.agentFolders.map((f) => ({ path: f, name: path.basename(f) || f, exists: fs.existsSync(f), lastAt: last[f] ?? null }));
    return json(200, { folders, current: s.agentFolder, busy: Boolean(agent.busy), home: os.homedir() });
  }
  if (route === "POST /api/agent/send") {
    const { text } = await readJson(req);
    if (!String(text ?? "").trim()) return json(400, { error: t("보낼 말이 없습니다.") });
    // 작업 중이면 진행 중인 작업에 더하거나(Codex) 끝난 뒤 보낸다
    agent.add(String(text).trim(), loadSettings()).catch((error) => broadcast({ type: "warning", message: error.message }));
    return json(202, {});
  }
  if (route === "POST /api/agent/interrupt") {
    await agent.interrupt();
    return json(200, {});
  }
  if (route === "POST /api/agent/new") {
    if (agent.busy) return json(409, { error: t("작업 중에는 새 대화를 시작할 수 없습니다.") });
    agent.newConversation(loadSettings());
    return json(200, {});
  }
  // Claude 승인 연결(approval-mcp)이 부른다: 사용자가 화면에서 고를 때까지 기다린다
  if (route === "POST /api/agent/approval") {
    const { tool, input } = await readJson(req);
    return json(200, { allow: await agent.askApproval(tool, input) });
  }
  const approvalRoute = url.pathname.match(/^\/api\/agent\/approval\/(a\d+)$/);
  if (approvalRoute && req.method === "POST") {
    const { allow } = await readJson(req);
    return json(agent.answerApproval(approvalRoute[1], allow) ? 200 : 404, {});
  }
  if (route === "GET /api/summary/providers") {
    const providers = await detectProviders({ refresh: url.searchParams.has("refresh") });
    const pinned = loadSettings().summaryModels;
    return json(200, { providers: providers.map(({ path: _, ...p }) => ({ ...p, choice: modelChoice(p, pinned[p.id]) })) });
  }
  // API 키는 키체인에만 두고 화면에는 돌려주지 않는다 (등록 여부만)
  if (route === "POST /api/summary/key") {
    const { id, key } = await readJson(req);
    await saveApiKey(id, String(key ?? "").trim());
    refreshSummaryModels();
    return json(200, {});
  }
  // ChatGPT·Grok 구독 로그인 (기기 코드): 코드를 화면에 보여 주고 브라우저로 확인 주소를 연다
  const loginRoute = url.pathname.match(/^\/api\/summary\/login\/(chatgpt|grok)\/(start|cancel|logout)$/);
  if (loginRoute && req.method === "POST") {
    const [, id, action] = loginRoute;
    if (action === "cancel") cancelLogin(id);
    if (action === "logout") await logout(id);
    if (action !== "start") {
      await detectProviders({ refresh: true });
      return json(200, {});
    }
    try {
      const login = await startLogin(id, {
        onDone: async (error) => {
          if (error) console.error(`${id} 로그인 실패:`, error);
          await detectProviders({ refresh: true });
          if (!error) refreshSummaryModels();
          broadcast({ type: "login-done", id, error });
        },
      });
      execFile("open", [login.url]);
      return json(200, login);
    } catch (error) {
      return json(400, { error: error.message });
    }
  }
  if (route === "GET /api/summary/local-models") return json(200, summaryModelsPayload());
  const llmRoute = url.pathname.match(/^\/api\/summary\/local-models\/([\w.-]+)\/(download|cancel|delete|use)$/);
  if (llmRoute && req.method === "POST") {
    const entry = findSummaryModel(llmRoute[1]);
    if (!entry) return json(404, { error: t("없는 모델입니다.") });
    const action = llmRoute[2];
    if (action === "download") {
      if (llmDownload && llmDownload.id !== entry.id) return json(409, { error: t("다른 요약 모델을 내려받는 중입니다. 끝난 뒤 다시 시도하세요.") });
      startLlmDownload(entry);
      return json(202, {});
    }
    if (action === "cancel") {
      if (llmDownload?.id === entry.id) llmDownload.abort.abort();
      return json(200, {});
    }
    if (action === "delete") {
      if (llmDownload?.id === entry.id) return json(409, { error: t("내려받는 중입니다. 먼저 취소하세요.") });
      deleteModel(entry);
      if (loadSettings().summaryModels.voin === entry.id) saveSettings({ summaryModels: { voin: "" } }); // 고른 모델을 지우면 선택도 비운다
    } else saveSettings({ summaryModels: { voin: entry.id } });
    await detectProviders({ refresh: true });
    broadcast({ type: "summary-models-changed" });
    return json(200, summaryModelsPayload());
  }
  if (route === "GET /api/summary/models") {
    const settings = loadSettings();
    try {
      return json(200, { models: await listSummaryModels(url.searchParams.get("id"), { customUrl: settings.summaryCustomUrl }) });
    } catch (error) {
      return json(400, { error: error.message });
    }
  }

  const match = url.pathname.match(/^\/api\/meetings\/([^/]+)(?:\/(rename|reveal|summarize|suggest-names))?$/);
  if (match) {
    const filePath = meetingPath(match[1]);
    if (req.method === "GET" && !match[2]) {
      const settings = loadSettings();
      return json(200, {
        voices: voiceUrls(path.basename(filePath, ".md")),
        suggestions: nameSuggestions(path.basename(filePath, ".md")),
        content: fs.readFileSync(filePath, "utf8"),
        path: filePath,
        obsidianUrl: settings.saveMode === "obsidian" ? `obsidian://open?path=${encodeURIComponent(filePath)}` : null,
      });
    }
    if (req.method === "POST" && match[2] === "rename") {
      const { from, to } = await readJson(req);
      renameSpeaker(filePath, from, to);
      renameVoices(path.basename(filePath, ".md"), from, to.trim());
      // 실제 이름이 생기면 참석자 → 사람 노트 연결, 팀 공유 사본도 새로
      const settings = loadSettings();
      linkRecord(filePath, { frontmatter: settings.frontmatter });
      copyToTeamFolder(filePath, settings.teamFolder);
      return json(200, {});
    }
    if (req.method === "POST" && match[2] === "reveal") {
      execFile("open", ["-R", filePath]);
      return json(200, {});
    }
    // 이름 후보만 다시 찾는다 (요약은 그대로)
    if (req.method === "POST" && match[2] === "suggest-names") {
      if (summarizing.has(filePath)) return json(409, { error: t("이미 처리하는 중입니다.") });
      summarizing.add(filePath);
      json(202, {});
      const file = path.basename(filePath);
      const progress = (message) => {
        job = message;
        broadcast({ type: "summary-progress", file, message });
      };
      suggestNames(filePath, progress, { required: true })
        .then(() => broadcast({ type: "summary-done", file, message: t("이름 후보를 찾았습니다.") }))
        .finally(() => {
          summarizing.delete(filePath);
          if (!summarizing.size && !busy && !recoveryRunning) job = null;
        });
      return;
    }
    // 저장된 기록을 (다시) 요약한다. 오래 걸려 바로 202로 답하고 결과는 WebSocket으로 알린다
    if (req.method === "POST" && match[2] === "summarize") {
      if (summarizing.has(filePath)) return json(409, { error: t("이미 요약하는 중입니다.") });
      summarizing.add(filePath);
      json(202, {});
      const file = path.basename(filePath);
      const progress = (message) => {
        job = message;
        broadcast({ type: "summary-progress", file, message });
      };
      completeRecord(filePath, progress, { required: true })
        .then((warning) => broadcast(warning ? { type: "summary-error", file, message: warning } : { type: "summary-done", file }))
        .finally(() => {
          summarizing.delete(filePath);
          if (!summarizing.size && !busy && !recoveryRunning) job = null;
        });
      return;
    }
  }
  json(404, { error: t("없는 API입니다") });
}

const server = http.createServer(async (req, res) => {
  if (!isLocalRequest(req.headers, PORT)) return res.writeHead(403).end("Forbidden");
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(error.status ?? 500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error.message }));
      }
    }
    return;
  }
  if (url.pathname.startsWith("/voices/")) {
    const file = voicePath(url.pathname);
    if (!file) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "content-type": "audio/wav" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  // 화면과 서버가 같이 쓰는 모듈 (사전 글상자 파싱, 화면 언어): 이 파일들만 내준다
  const shared = { "/shared/text-cleanup.mjs": "./lib/text-cleanup.mjs", "/shared/i18n.mjs": "./lib/i18n.mjs", "/shared/locales/en.mjs": "./lib/locales/en.mjs", "/shared/locales/ja.mjs": "./lib/locales/ja.mjs" };
  if (url.pathname in shared) {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
    fs.createReadStream(new URL(shared[url.pathname], import.meta.url)).pipe(res);
    return;
  }
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, path.normalize(requested));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404).end("Not found");
    return;
  }
  // 앱을 새 버전으로 바꿨을 때 예전 화면 코드가 남지 않도록 매번 새로 확인하게 한다
  res.writeHead(200, { "content-type": `${CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream"}; charset=utf-8`, "cache-control": "no-cache" });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ req }) => isLocalRequest(req.headers, PORT) });

wss.on("connection", (ws) => {
  clients.add(ws);
  const send = (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
  send({ type: "model", ...activeState });
  let meeting = null;

  const stopMeeting = async () => {
    if (!meeting) return;
    const current = meeting;
    meeting = null;
    job = t("저장하는 중…");
    try {
      const warning = await current.stop();
      send({ type: "stopped", file: current.record.discarded ? null : current.fileName, warning });
    } finally {
      job = null;
      if (activeMeeting === current) activeMeeting = null;
      if (busy === "meeting") busy = null;
    }
  };

  let dictation = null;
  // 잘못된 메시지 하나로 서버(녹음 중인 회의 포함)가 꺼지지 않도록 오류는 화면에만 알린다
  ws.on("message", (data, isBinary) =>
    handleMessage(data, isBinary).catch((error) => send({ type: "error", message: t("요청을 처리하지 못했습니다: {message}", { message: error.message }) })),
  );
  async function handleMessage(data, isBinary) {
    if (isBinary) {
      const samples = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      if (meeting) meeting.pushMic(samples);
      else dictation?.push(samples);
      return;
    }
    const message = JSON.parse(String(data));
    // 음성 작업 말하기: 녹음 중이 아닐 때만
    if (message.type === "dictate-start") {
      if (modelNotReady()) return send({ type: "error", message: modelNotReady() });
      if (meeting) return send({ type: "error", message: t("녹음 중에는 음성 작업을 할 수 없습니다.") });
      dictation = new Dictation(send, loadSettings().language, message.mode === "paste" ? "paste" : "agent");
      return;
    }
    if (message.type === "dictate-stop" || message.type === "dictate-cancel") {
      const current = dictation;
      dictation = null;
      await current?.finish(null, { discard: message.type === "dictate-cancel" });
      return;
    }
    if (message.type === "start") {
      if (modelNotReady()) {
        send({ type: "error", message: modelNotReady() });
        return;
      }
      if (busy) {
        send({ type: "error", message: busy === "meeting" ? t("이미 다른 창에서 녹음 중입니다.") : t("녹음 파일을 처리하는 중입니다. 끝난 뒤 시작하세요.") });
        return;
      }
      try {
        const settings = loadSettings();
        meeting = activeMeeting = new LiveMeeting({ ...message, send, settings });
        busy = "meeting";
        send({ type: "started", file: meeting.fileName });
      } catch (error) {
        meeting = activeMeeting = null;
        send({ type: "error", message: t("녹음을 시작하지 못했습니다: {message}", { message: error.message }) });
      }
    } else if (message.type === "stop") {
      await stopMeeting().catch((e) => send({ type: "error", message: t("저장 중 오류: {message}", { message: e.message }) }));
    }
  }

  // 화면을 닫아도 그때까지의 내용은 저장하고 끝낸다
  ws.on("close", () => {
    clients.delete(ws);
    dictation?.finish(null, { discard: true });
    dictation = null;
    stopMeeting().catch((e) => console.error("녹음 종료 중 오류:", e));
  });
});

// 요약에 쓸 외부 모델 목록을 뒤에서 받는다 (실패해도 요약은 받아 둔 목록이나 그때 받은 목록으로 한다)
function refreshSummaryModels() {
  refreshModelLists().catch((error) => console.error("요약 모델 목록 갱신 실패:", error.message));
}

// 맥 앱을 닫으면 SIGTERM이 온다: 녹음 중이던 회의를 (화자 분석 없이) 저장하고 끝낸다
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    await activeMeeting?.stop({ quick: true }).catch((e) => console.error("녹음 저장 중 오류:", e));
    agent.stop();
    process.exit(0);
  });
}

// 모델을 불러오기 전에 화면부터 띄워, 모델이 없을 때 내려받기 안내를 보여 줄 수 있게 한다
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nvoin 준비 완료 → http://localhost:${PORT}\n`);
  refreshSummaryModels();
  setInterval(refreshSummaryModels, 6 * 60 * 60 * 1000); // 켜 둔 채로 지내도 하루에 한 번은 새 목록을 받는다
  loadActiveModel();
});
