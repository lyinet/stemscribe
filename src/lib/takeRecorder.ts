export interface RecordedTake {
  id: string;
  label: string;
  createdAt: string;
  durationSec: number;
  playbackRate: number;
  blobUrl: string;
  wavBytes: Uint8Array;
  savedPath?: string;
}

function encodeAudioBufferToWav(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const dataSize = len * numCh * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: numCh }, (_, c) => buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, Math.round(s * 32767), true);
      offset += 2;
    }
  }
  return new Uint8Array(ab);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class OverdubTakeRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startTimeMs = 0;

  public async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前环境不支持麦克风录音");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.chunks = [];
    this.startTimeMs = performance.now();
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();
  }

  public async stop(label: string, playbackRate: number): Promise<RecordedTake> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error("当前没有进行中的录音"));
        return;
      }
      const rec = this.mediaRecorder;
      rec.onstop = async () => {
        try {
          const rawBlob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
          const rawBuf = await rawBlob.arrayBuffer();
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
          const ctx = new Ctx();
          const decoded = await ctx.decodeAudioData(rawBuf);
          const wavBytes = encodeAudioBufferToWav(decoded);
          await ctx.close().catch(() => {});

          const wavBlob = new Blob([wavBytes], { type: "audio/wav" });
          const blobUrl = URL.createObjectURL(wavBlob);
          const durationSec = Math.max(0.1, (performance.now() - this.startTimeMs) / 1000);

          this.cleanupStream();
          resolve({
            id: `take_${Date.now()}`,
            label,
            createdAt: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
            durationSec,
            playbackRate,
            blobUrl,
            wavBytes,
          });
        } catch (err) {
          this.cleanupStream();
          reject(err);
        }
      };
      rec.stop();
    });
  }

  private cleanupStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.mediaRecorder = null;
  }
}
