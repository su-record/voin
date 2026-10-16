// 화자 분리는 몇 분씩 걸리는 동기 작업이라 별도 스레드에서 돌린다.
// 입력: { wavFile, modelsDir, expectedSpeakers }  출력: [{ start, end, speaker }] (초 단위)
//
// 1) pyannote로 말소리 구간을 잘게 나눈다 (sherpa-onnx)
// 2) 구간마다 3D-Speaker로 목소리 특징을 뽑는다
// 3) 비슷한 목소리끼리 묶고(평균 연결 계층 군집), 말한 시간이 아주 짧은 묶음은 잡음·겹친 말로 보고 가장 가까운 화자에 붙인다
// sherpa의 기본 묶기를 그대로 쓰면 실제 회의 녹음(노트북 마이크, 52분)에서 135명으로 쪼개져 직접 묶는다.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { SAMPLE_RATE, readWav } from "./audio.mjs";

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const { wavFile, modelsDir, expectedSpeakers } = workerData;
// 코어를 넉넉히 쓰되 실시간 받아쓰기 몫은 남긴다
const threads = Math.max(2, Math.min(8, os.availableParallelism() - 2));
const EMBEDDING_MODEL = path.join(modelsDir, "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx");

const SIMILARITY = 0.5; // 실제 회의(노트북 마이크, 4명 52분)에서 0.4~0.5는 정확히 4명, 0.55부터 6명으로 쪼개졌다
const MIN_EMBED_SEC = 1.0; // 이보다 짧은 구간은 목소리 특징이 불안정해 시간상 가까운 구간을 따른다
const MAX_CLUSTER_ITEMS = 2500; // 3시간 넘는 녹음에서 묶기 계산이 너무 길어지지 않도록

const pcm = readWav(wavFile);

// 1) 구간 나누기: 묶기 기준을 아주 낮춰(=잘게) 화자가 바뀌는 지점을 최대한 살린다
const segmenter = new sherpa.OfflineSpeakerDiarization({
  segmentation: { pyannote: { model: path.join(modelsDir, "sherpa-onnx-pyannote-segmentation-3-0/model.onnx") }, numThreads: threads },
  embedding: { model: EMBEDDING_MODEL, numThreads: threads },
  clustering: { numClusters: -1, threshold: 0.2 },
  minDurationOn: 0.3,
  minDurationOff: 0.5,
});
const segments = segmenter.process(pcm).map(({ start, end }) => ({ start, end, dur: end - start }));

// 2) 목소리 특징(길이 1로 맞춘 벡터)
const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: EMBEDDING_MODEL, numThreads: threads });
for (const seg of segments) {
  if (seg.dur < MIN_EMBED_SEC) continue;
  const stream = extractor.createStream();
  const from = Math.floor(seg.start * SAMPLE_RATE);
  const to = Math.floor(Math.min(seg.end, seg.start + 15) * SAMPLE_RATE);
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: pcm.subarray(from, to) });
  stream.inputFinished();
  seg.embedding = normalize(Float64Array.from(extractor.compute(stream)));
}

parentPort.postMessage(assignSpeakers(segments));

function normalize(v) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// 3) 평균 연결 계층 군집: 가장 비슷한 두 묶음을 기준 이하가 될 때까지(인원을 정했으면 그 수가 될 때까지) 합친다
function agglomerate(items, targetCount) {
  const n = items.length;
  const sim = items.map((a) => Float64Array.from(items, (b) => dot(a.embedding, b.embedding)));
  const size = new Array(n).fill(1);
  const alive = new Array(n).fill(true);
  const members = items.map((_, i) => [i]);
  let count = n;
  while (count > 1) {
    let best = -2;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const row = sim[i];
      for (let j = i + 1; j < n; j++) if (alive[j] && row[j] > best) (best = row[j]), (bi = i), (bj = j);
    }
    if (targetCount > 0 ? count <= targetCount : best < SIMILARITY) break;
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      sim[bi][k] = sim[k][bi] = (sim[bi][k] * size[bi] + sim[bj][k] * size[bj]) / (size[bi] + size[bj]);
    }
    size[bi] += size[bj];
    alive[bj] = false;
    members[bi].push(...members[bj]);
    count--;
  }
  return members.filter((_, i) => alive[i]).map((m) => m.map((i) => items[i]));
}

function assignSpeakers(segs) {
  const embedded = segs.filter((s) => s.embedding);
  if (!embedded.length) return [];
  // 아주 긴 녹음은 긴 구간 위주로 묶고, 나머지는 아래에서 가장 가까운 화자에 붙인다
  const sample = embedded.length > MAX_CLUSTER_ITEMS ? [...embedded].sort((a, b) => b.dur - a.dur).slice(0, MAX_CLUSTER_ITEMS) : embedded;
  const clusters = agglomerate(sample, expectedSpeakers).map((items) => ({ items, total: items.reduce((s, x) => s + x.dur, 0) }));
  clusters.sort((a, b) => b.total - a.total);

  // 말한 시간이 전체의 3%(3~20초 사이) 미만인 묶음은 화자로 치지 않는다
  const speech = embedded.reduce((s, x) => s + x.dur, 0);
  const minTotal = Math.min(20, Math.max(3, speech * 0.03));
  const speakers = expectedSpeakers > 0 ? clusters.slice(0, expectedSpeakers) : clusters.filter((c, i) => i === 0 || c.total >= minTotal);
  const centroids = speakers.map(({ items }) => {
    const c = new Float64Array(items[0].embedding.length);
    for (const x of items) for (let k = 0; k < c.length; k++) c[k] += x.embedding[k] * x.dur;
    return normalize(c);
  });

  // 특징이 있는 구간: 가장 가까운 화자 중심으로
  for (const seg of embedded) {
    let best = -2;
    for (let i = 0; i < centroids.length; i++) {
      const s = dot(seg.embedding, centroids[i]);
      if (s > best) (best = s), (seg.speaker = i);
    }
  }
  // 짧은 구간: 시간상 가장 가까운 구간의 화자를 따른다
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  for (const seg of sorted) {
    if (seg.speaker !== undefined) continue;
    let best = Infinity;
    for (const other of embedded) {
      const gap = Math.max(0, other.start - seg.end, seg.start - other.end);
      if (gap < best) (best = gap), (seg.speaker = other.speaker);
    }
  }
  return sorted.map(({ start, end, speaker }) => ({ start, end, speaker }));
}
