// 오디오 한 갈래(마이크/화상회의/불러온 파일)를 발화 단위로 끊어 받아쓴다.
// 말이 멈추면 그 발화를 통째로 받아쓴다(Whisper처럼 실시간 스트림을 못 하는 모델도 쓸 수 있게).
// 모델 하나를 여러 갈래가 함께 쓴다: transcribe-cpp가 계산을 한 번에 하나씩 차례로 처리한다.
import { SAMPLE_RATE } from "./audio.mjs";

const CHUNK_SAMPLES = 1600; // 100ms
const MAX_UTTERANCE_MS = 30000;
const PREROLL_CHUNKS = 3; // 말 시작 직전 0.3초도 함께 넣어 첫 음절이 잘리지 않게 한다
const PARTIAL_EVERY_MS = 1500; // 말하는 중 미리보기 자막을 다시 받아쓰는 간격

function rms(samples) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

function concat(chunks) {
  const out = new Float32Array(chunks.length * CHUNK_SAMPLES);
  chunks.forEach((c, i) => out.set(c, i * CHUNK_SAMPLES));
  return out;
}

export class SourceTranscriber {
  // transcribe(pcm) → 글자. clock: "samples" = 들어온 소리 길이로 시간 계산(마이크·파일),
  // "wall" = 실제 시각으로 계산(시스템 오디오는 무음 구간에 데이터가 안 와서)
  constructor({ transcribe, source, silenceMs, clock, startedAt, onPartial, onFinal, onLevel }) {
    Object.assign(this, { transcribe, source, silenceMs, clock, startedAt });
    this.onPartial = onPartial ?? (() => {});
    this.onFinal = onFinal;
    this.onLevel = onLevel ?? (() => {});
    this.pending = new Float32Array(0);
    this.preroll = [];
    this.processedSamples = 0;
    this.noiseFloor = 0.003;
    this.utterance = null;
    this.lastLevelAt = 0;
    this.finals = Promise.resolve(); // 발화 받아쓰기를 순서대로 처리
    this.partialBusy = false;
    this.live = true;
    this.stopped = false;
  }

  // 실시간 입력: 100ms 단위로 잘라 처리한다
  push(samples) {
    if (this.stopped) return;
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= CHUNK_SAMPLES) {
      this.processChunk(merged.slice(offset, offset + CHUNK_SAMPLES));
      offset += CHUNK_SAMPLES;
    }
    this.pending = merged.slice(offset);
  }

  // 파일 입력: 발화마다 받아쓰기가 끝나길 기다리며 순서대로 처리한다 (진행률이 실제와 맞도록)
  async run(samples, onProgress) {
    this.live = false;
    let lastReport = 0;
    for (let i = 0; i + CHUNK_SAMPLES <= samples.length; i += CHUNK_SAMPLES) {
      this.processChunk(samples.slice(i, i + CHUNK_SAMPLES));
      await this.finals;
      const ratio = i / samples.length;
      if (ratio - lastReport >= 0.02) {
        lastReport = ratio;
        onProgress(ratio);
      }
    }
    await this.stop();
  }

  processChunk(chunk) {
    const level = rms(chunk);
    const now = Date.now();
    if (this.live && now - this.lastLevelAt > 150) {
      this.lastLevelAt = now;
      this.onLevel(this.source, level);
    }
    // 주변 소음 수준을 천천히 따라가며, 그보다 충분히 크면 말소리로 본다
    const voiced = level > Math.max(0.01, this.noiseFloor * 3);
    if (!voiced) this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
    this.processedSamples += chunk.length;

    if (!this.utterance) {
      this.preroll.push(chunk);
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
      if (!voiced) return;
      const prerollSamples = this.preroll.length * CHUNK_SAMPLES;
      this.utterance = {
        startSample: this.processedSamples - prerollSamples,
        wallMs: now - (prerollSamples * 1000) / SAMPLE_RATE - this.startedAt,
        chunks: this.preroll,
        silenceMs: 0,
        partialAt: 0,
      };
      this.preroll = [];
      return;
    }

    const u = this.utterance;
    u.chunks.push(chunk);
    u.silenceMs = voiced ? 0 : u.silenceMs + 100;
    const lengthMs = u.chunks.length * 100;
    if (u.silenceMs >= this.silenceMs || lengthMs >= MAX_UTTERANCE_MS) this.finishUtterance();
    else if (this.live && lengthMs - u.partialAt >= PARTIAL_EVERY_MS) this.updatePartial(u, lengthMs);
  }

  // 말하는 중 미리보기: 앞선 미리보기가 끝났을 때만 지금까지의 소리를 다시 받아쓴다
  updatePartial(u, lengthMs) {
    if (this.partialBusy) return;
    u.partialAt = lengthMs;
    this.partialBusy = true;
    this.transcribe(concat(u.chunks))
      .then((text) => this.utterance === u && this.onPartial(this.source, text.trim()))
      .catch(() => {})
      .finally(() => (this.partialBusy = false));
  }

  finishUtterance() {
    const u = this.utterance;
    if (!u) return;
    this.utterance = null;
    const endSample = this.processedSamples;
    const pcm = concat(u.chunks);
    this.finals = this.finals.then(async () => {
      try {
        const text = (await this.transcribe(pcm)).trim();
        if (this.live) this.onPartial(this.source, "");
        if (!text) return;
        this.onFinal({
          source: this.source,
          startSample: u.startSample,
          endSample,
          offsetMs: this.clock === "wall" ? u.wallMs : (u.startSample * 1000) / SAMPLE_RATE,
          text,
        });
      } catch (error) {
        console.error(`[${this.source}] 받아쓰기 오류:`, error);
      }
    });
  }

  // 남은 소리까지 모두 받아쓴 뒤 끝낸다
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.finishUtterance();
    await this.finals;
  }
}
