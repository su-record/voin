// 받아쓰기 모델 찾기·내려받기·지우기. 모델 목록은 model-catalog.mjs.
// 내려받은 모델은 DATA_DIR/models에 둔다. Handy 앱이 받아 둔 모델이 있으면 그대로 함께 쓴다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t } from "./i18n.mjs";
import { CATALOG, DEFAULT_MODEL_ID, findCatalogModel } from "./model-catalog.mjs";
import { DATA_DIR } from "./settings.mjs";

export const DOWNLOAD_DIR = path.join(DATA_DIR, "models");
const HANDY_CACHE = path.join(os.homedir(), ".cache/huggingface/hub");

// 모델 파일 위치와 출처: bundled(앱 안) | downloaded(이 앱이 받음) | handy(Handy 앱이 받아 둠)
export function locateModel(entry, bundledDir) {
  const candidates = [
    [path.join(bundledDir, entry.file), "bundled"],
    [path.join(DOWNLOAD_DIR, entry.file), "downloaded"],
  ];
  for (const [file, source] of candidates) if (fs.existsSync(file)) return { path: file, source };
  const snapshots = path.join(HANDY_CACHE, `models--${(entry.handyRepo ?? entry.repo).replace("/", "--")}`, "snapshots");
  if (fs.existsSync(snapshots)) {
    for (const snapshot of fs.readdirSync(snapshots)) {
      const file = path.join(snapshots, snapshot, entry.file);
      if (fs.existsSync(file)) return { path: file, source: "handy" };
    }
  }
  return null;
}

// 설정에서 고른 모델. MODEL_PATH 환경변수가 있으면 그 파일을 쓴다(개발·시험용).
export function activeModelEntry(settings) {
  if (process.env.MODEL_PATH) {
    const file = path.basename(process.env.MODEL_PATH);
    return { id: "custom", name: file, file, size: 0, custom: process.env.MODEL_PATH };
  }
  return findCatalogModel(settings.asrModel) ?? findCatalogModel(DEFAULT_MODEL_ID);
}

export function locateActive(entry, bundledDir) {
  if (entry.custom) return fs.existsSync(entry.custom) ? { path: entry.custom, source: "custom" } : null;
  return locateModel(entry, bundledDir);
}

const partPath = (entry) => path.join(DOWNLOAD_DIR, `${entry.file}.part`);
export const partialBytes = (entry) => (fs.existsSync(partPath(entry)) ? fs.statSync(partPath(entry)).size : 0);

// 카탈로그의 화면 글(배지·언어·장단점)을 지금 언어로
export function localizeEntry(info) {
  const out = { ...info, pros: info.pros.map((p) => t(p)), cons: info.cons.map((c) => t(c)) };
  if (info.badge) out.badge = t(info.badge);
  if (info.languages) out.languages = t(info.languages);
  return out;
}

// 목록 화면용: 카탈로그 + 설치 여부
export function listModels(bundledDir) {
  return CATALOG.map((entry) => {
    const found = locateModel(entry, bundledDir);
    const { repo, commit, sha256, ...info } = entry;
    return { ...localizeEntry(info), installed: Boolean(found), source: found?.source ?? null, path: found?.path ?? null, partial: partialBytes(entry) };
  });
}

// 끊겼다가 다시 받으면 받은 곳부터 이어 받는다(.part). 다 받으면 SHA-256으로 확인한 뒤 이름을 바꾼다.
export async function downloadModel(entry, { signal, onProgress }) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const target = path.join(DOWNLOAD_DIR, entry.file);
  const part = partPath(entry);
  let received = partialBytes(entry);
  if (received > entry.size) {
    fs.rmSync(part);
    received = 0;
  }

  if (received < entry.size) {
    const url = `https://huggingface.co/${entry.repo}/resolve/${entry.commit}/${entry.file}`;
    const response = await fetch(url, { signal, headers: received ? { range: `bytes=${received}-` } : {} });
    if (!response.ok) throw new Error(t("서버 응답 {status}", { status: response.status }));
    if (received && response.status !== 206) received = 0; // 이어 받기를 지원하지 않으면 처음부터
    const out = fs.createWriteStream(part, { flags: received ? "a" : "w" });
    try {
      let lastReport = 0;
      for await (const chunk of response.body) {
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        received += chunk.length;
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          onProgress({ received, total: entry.size });
        }
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  }

  onProgress({ received, total: entry.size, verifying: true });
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(part)) hash.update(chunk);
  if (hash.digest("hex") !== entry.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(t("받은 파일이 손상되었습니다. 다시 시도하세요."));
  }
  fs.renameSync(part, target);
  return target;
}

// 이 앱이 내려받은 파일만 지운다 (앱 안·Handy 모델은 건드리지 않는다)
export function deleteModel(entry) {
  fs.rmSync(path.join(DOWNLOAD_DIR, entry.file), { force: true });
  fs.rmSync(partPath(entry), { force: true });
}

// 설정 언어(ko-KR)를 모델이 아는 표기(ko-KR 또는 ko)로 맞춘다. 모르면 자동 감지에 맡긴다.
export function languageFor(model, language) {
  const langs = model.capabilities.languages;
  if (langs.includes(language)) return language;
  const short = language.split("-")[0];
  return langs.includes(short) ? short : langs.find((l) => l.startsWith(`${short}-`));
}

// 네트워크 오류를 사람이 읽을 수 있는 말로 바꾼다
export function describeDownloadError(error) {
  const code = error.cause?.code ?? error.code ?? "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return t("회사망 보안 인증서 때문에 연결하지 못했습니다. 다른 네트워크에서 다시 시도하세요.");
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(code)) return t("인터넷에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.");
  if (code === "ENOSPC") return t("디스크 공간이 부족합니다. 공간을 비우고 다시 시도하세요.");
  return error.message;
}
