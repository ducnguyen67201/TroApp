import type { VoiceMeter } from '#contracts/CompanionHud.js';

/** RMS from the existing PCM16 frames; no additional microphone or audio context. */
export function readVoiceLevel(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) {
    return 0;
  }
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let squares = 0;
  for (let index = 0; index < samples; index += 1) {
    squares += (view.getInt16(index * 2, true) / 32768) ** 2;
  }
  return Math.min(1, Math.sqrt(squares / samples) * 4);
}

/** Bounded, fire-and-forget presentation updates. Flush frames cannot revive listening. */
export class VoiceLevelMeter {
  private sequence = 0;
  private lastSentAt = -Infinity;
  private stopped = false;
  constructor(
    private readonly captureId: string,
    private readonly send: (meter: VoiceMeter) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  appendFrame(pcm: Uint8Array): void {
    const time = this.now();
    if (this.stopped || time - this.lastSentAt < 50) {
      return;
    }
    this.lastSentAt = time;
    try {
      this.send({
        captureId: this.captureId,
        sequence: this.sequence++,
        level: readVoiceLevel(pcm),
      });
    } catch {
      /* Meter availability does not affect audio. */
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
