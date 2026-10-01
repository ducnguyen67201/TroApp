import processorUrl from './VoiceAudioProcessor.ts?worker&url';
import { AudioFormat } from '#contracts/Transcription.js';

/** Owns only microphone resources. No URLs, credentials, or agent submission.
 * Cancellation during permission/setup still stops late-arriving media tracks. */
export class VoiceAudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private closed = false;
  private resolveFlush: (() => void) | null = null;

  constructor(
    private readonly appendFrame: (pcm: Uint8Array) => void,
    private readonly fail: () => void,
  ) {}

  async startCapture(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    if (this.isCaptureClosed()) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return;
    }
    this.stream = stream;
    const context = new AudioContext({ sampleRate: AudioFormat.SAMPLE_RATE });
    this.context = context;
    if (context.sampleRate !== AudioFormat.SAMPLE_RATE) {
      throw new Error('Unsupported microphone sample rate.');
    }
    await context.audioWorklet.addModule(processorUrl);
    if (this.isCaptureClosed()) {
      return;
    }
    const worklet = new AudioWorkletNode(context, 'tro-voice-audio', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.worklet = worklet;
    worklet.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === 'flushed') {
        this.resolveFlush?.();
        return;
      }
      if (
        event.data instanceof Uint8Array &&
        event.data.byteLength > 0 &&
        event.data.byteLength <= AudioFormat.FRAME_BYTES &&
        event.data.byteLength % 2 === 0 &&
        !this.closed
      ) {
        this.appendFrame(event.data);
      } else if (!this.closed) {
        this.fail();
      }
    };
    worklet.onprocessorerror = () => {
      this.fail();
    };
    const source = context.createMediaStreamSource(stream);
    source.connect(worklet);
    // A connected output keeps the worklet running; its unwritten output is silence.
    worklet.connect(context.destination);
    await context.resume();
  }

  async flushCapture(): Promise<void> {
    const worklet = this.worklet;
    // Stop the physical microphone immediately, while flushing already captured samples.
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    if (this.closed || !worklet) {
      this.dispose();
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Audio flush timed out.'));
        }, 1500);
        this.resolveFlush = () => {
          clearTimeout(timer);
          resolve();
        };
        worklet.port.postMessage('flush');
      });
    } finally {
      this.dispose();
    }
  }

  private isCaptureClosed(): boolean {
    return this.closed;
  }

  dispose(): void {
    if (this.isCaptureClosed()) {
      return;
    }
    this.closed = true;
    this.resolveFlush?.();
    this.resolveFlush = null;
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.worklet?.disconnect();
    this.worklet?.port.close();
    if (this.context) {
      void this.context.close().catch(() => {});
    }
    this.stream = null;
    this.context = null;
    this.worklet = null;
  }
}
