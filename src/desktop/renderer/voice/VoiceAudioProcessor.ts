/* AudioWorklet globals belong to this module's audio-thread execution context. */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** Chromium resamples the microphone into the 24 kHz AudioContext. Emit
 * little-endian PCM16 in 20 ms chunks; flush the real tail without padding. */
class VoiceAudioProcessor extends AudioWorkletProcessor {
  private frame = new ArrayBuffer(960);
  private view = new DataView(this.frame);
  private offset = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === 'flush') {
        this.stopped = true;
        this.sendFrame();
        this.port.postMessage('flushed');
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) {
      return false;
    }
    const samples = inputs[0]?.[0];
    if (samples) {
      for (const sample of samples) {
        const clamped = Math.max(-1, Math.min(1, sample));
        this.view.setInt16(this.offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
        this.offset += 2;
        if (this.offset === 960) {
          this.sendFrame();
        }
      }
    }
    return true;
  }

  private sendFrame(): void {
    if (this.offset === 0) {
      return;
    }
    const frame = this.frame.slice(0, this.offset);
    this.port.postMessage(new Uint8Array(frame), [frame]);
    this.frame = new ArrayBuffer(960);
    this.view = new DataView(this.frame);
    this.offset = 0;
  }
}

registerProcessor('tro-voice-audio', VoiceAudioProcessor);

export {};
