// 16kHz 모노 WAV 쓰기/읽기와 녹음 파일 변환(macOS afconvert)
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

export const SAMPLE_RATE = 16000;
const execFileAsync = promisify(execFile);

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// 회의 중 들어오는 소리를 16bit WAV로 계속 이어 쓴다 (1시간 ≈ 115MB)
export class WavWriter {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, "w");
    fs.writeSync(this.fd, wavHeader(0));
    this.bytes = 0;
  }

  write(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
    }
    fs.writeSync(this.fd, buf);
    this.bytes += buf.length;
  }

  close() {
    if (this.fd === null) return;
    fs.writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

// 16bit PCM 또는 float32 WAV를 Float32Array로 읽는다
export function readWav(file) {
  const b = fs.readFileSync(file);
  let format = 1;
  let bits = 16;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString("ascii", o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === "fmt ") {
      format = b.readUInt16LE(o + 8);
      bits = b.readUInt16LE(o + 22);
      // WAVE_FORMAT_EXTENSIBLE: 실제 형식은 확장 영역의 SubFormat 앞 2바이트
      if (format === 0xfffe && size >= 40) format = b.readUInt16LE(o + 8 + 24);
    } else if (id === "data") {
      // 녹음 중에 앱이 꺼지면 헤더의 크기가 0으로 남는다: 그때는 파일 끝까지를 소리로 본다
      const end = size === 0 || o + 8 + size > b.length ? b.length : o + 8 + size;
      const data = b.subarray(o + 8, end - ((end - o - 8) % (bits / 8)));
      if (format === 3 && bits === 32) {
        return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
      }
      const out = new Float32Array(data.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("WAV 파일에서 소리 데이터를 찾지 못했습니다.");
}

// m4a/mp3/wav/aiff/caf 등을 16kHz 모노 WAV로 바꾼다 (맥 기본 도구 afconvert)
export async function convertToWav(input, output) {
  try {
    await execFileAsync("afconvert", ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", input, output]);
  } catch (error) {
    throw new Error("이 파일 형식은 열 수 없습니다. m4a, mp3, wav, aiff 파일을 사용하세요. (" + (error.stderr || error.message).trim() + ")");
  }
}
