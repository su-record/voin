// 받아쓰기 모델 비교: 회의 녹음의 두 구간(0:00~2:30, 32:00~34:30)을 앱과 같은 방식(발화 단위)으로 받아쓴다.
// 사용: node scripts/compare-models.mjs <회의 녹음.wav> <결과 폴더> [모델id,모델id]
// 결과 폴더에 모델별 bench-<id>.json(속도·받아쓴 줄)이 생긴다. lib/model-catalog.mjs의 장단점은 이 결과로 적었다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscribeModel } from "transcribe-cpp";
import { readWav } from "../lib/audio.mjs";
import { CATALOG } from "../lib/model-catalog.mjs";
import { SourceTranscriber } from "../lib/transcriber.mjs";
const [, , wav, outDir, only] = process.argv;
const full = readWav(wav);
const clip = (a, b) => full.subarray(a * 16000, b * 16000);
const clips = { "앞부분": clip(0, 150), "질의응답": clip(1920, 2070) };
const dirs = [path.join(os.homedir(), "Library/Application Support/MeetingNotes/models")];
const handy = path.join(os.homedir(), ".cache/huggingface/hub");
function locate(m) {
  for (const d of dirs) if (fs.existsSync(path.join(d, m.file))) return path.join(d, m.file);
  const snaps = path.join(handy, `models--${m.repo.replace("/", "--")}`, "snapshots");
  if (fs.existsSync(snaps)) for (const s of fs.readdirSync(snaps)) if (fs.existsSync(path.join(snaps, s, m.file))) return path.join(snaps, s, m.file);
}
const results = [];
for (const m of CATALOG) {
  if (only && !only.split(",").includes(m.id)) continue;
  const file = locate(m);
  if (!file) { console.log(`${m.id}: 파일 없음`); continue; }
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const model = await TranscribeModel.load(file);
  const loadMs = Date.now() - t0;
  const langs = model.capabilities.languages;
  const language = langs.includes("ko") ? "ko" : langs.find((l) => l.startsWith("ko")) ?? undefined;
  const out = { id: m.id, loadMs, language, langs: langs.length, streaming: model.capabilities.supportsStreaming, rssMB: Math.round((process.memoryUsage().rss - rss0) / 1e6), texts: {} };
  let audioSec = 0, workMs = 0;
  for (const [name, pcm] of Object.entries(clips)) {
    const lines = [];
    const tr = new SourceTranscriber({
      transcribe: async (p) => (await model.transcribe(p, language ? { language } : {})).text,
      source: "file", silenceMs: 800, clock: "samples", startedAt: 0,
      onFinal: (l) => lines.push(`[${Math.round(l.offsetMs / 1000)}s] ${l.text}`),
    });
    const t1 = Date.now();
    try { await tr.run(pcm, () => {}); } catch (e) { lines.push(`오류: ${e.message}`); }
    workMs += Date.now() - t1; audioSec += pcm.length / 16000;
    out.texts[name] = lines;
  }
  out.rtf = +(workMs / 1000 / audioSec).toFixed(3);
  model.dispose();
  console.log(`${m.id}: 로드 ${loadMs}ms, 언어=${language}, 속도 ${out.rtf} (1이면 실시간), 메모리 +${out.rssMB}MB, 줄 ${Object.values(out.texts).flat().length}`);
  results.push(out);
  fs.writeFileSync(path.join(outDir, `bench-${m.id}.json`), JSON.stringify(out, null, 2));
}
