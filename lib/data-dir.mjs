// 앱 데이터 폴더. 예전 이름(MeetingNotes)으로 쓰던 폴더가 있으면 처음 한 번 voin으로 옮긴다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SUPPORT_DIR = path.join(os.homedir(), "Library/Application Support");
export const DATA_DIR = path.join(SUPPORT_DIR, "voin");
const LEGACY_DIR = path.join(SUPPORT_DIR, "MeetingNotes");

// 정리 대기 작업(tmp/*.json)에는 음성 파일의 절대 경로가 있어 함께 고친다. 안 고치면 이어서 정리할 때 음성을 못 찾아 지운다.
export function migrateDataDir(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  fs.renameSync(from, to);
  const tmp = path.join(to, "tmp");
  if (!fs.existsSync(tmp)) return true;
  for (const name of fs.readdirSync(tmp).filter((f) => f.endsWith(".json"))) {
    const file = path.join(tmp, name);
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [source, wav] of Object.entries(job.wavFiles ?? {})) {
      if (wav.startsWith(`${from}/`)) job.wavFiles[source] = path.join(to, path.relative(from, wav));
    }
    fs.writeFileSync(file, JSON.stringify(job));
  }
  return true;
}

export function migrateLegacyDataDir() {
  try {
    if (migrateDataDir(LEGACY_DIR, DATA_DIR)) console.log(`앱 데이터 폴더를 옮겼습니다: ${LEGACY_DIR} → ${DATA_DIR}`);
  } catch (error) {
    console.error("예전 앱 데이터 폴더를 옮기지 못했습니다:", error);
  }
}
