import processorUrl from './VoiceAudioProcessor.ts?worker&url';
import { createMicrophoneConstraints, defaultMicrophoneId } from './Microphones.js';
import { AudioFormat } from '#contracts/Transcription.js';

/** Owns one hold's microphone, context and worklet. Setup failures release resources;
 * cancellation also stops tracks that arrive after a pending media request. */
export class VoiceAudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private started = false;
  private closed = false;
  private resolveFlush: (() => void) | null = null;

  constructor(
    private readonly appendFrame: (pcm: Uint8Array) => void,
    private readonly fail: () => void,
  ) {}

  async startCapture(deviceId: string = defaultMicrophoneId): Promise<void> {
    if (this.isCaptureClosed()) {
      return;
    }
    if (this.started) {
      throw new Error('Microphone capture has already started.');
    }
    this.started = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        createMicrophoneConstraints(deviceId),
      );
      if (this.isCaptureClosed()) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      this.stream = stream;
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          this.failCapture();
        };
      });

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
        this.receiveWorkletMessage(event.data);
      };
      worklet.onprocessorerror = () => {
        this.failCapture();
      };
      const source = context.createMediaStreamSource(stream);
      source.connect(worklet);
      // A connected output keeps the worklet running; its unwritten output is silence.
      worklet.connect(context.destination);
      await context.resume();
    } catch (error: unknown) {
      this.dispose();
      throw error;
    }
  }

  async flushCapture(): Promise<void> {
    const worklet = this.worklet;
    // Stop physical capture before waiting for the already captured samples.
    this.stopMicrophoneTracks();
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

  private receiveWorkletMessage(message: unknown): void {
    if (message === 'flushed') {
      this.resolveFlush?.();
      return;
    }
    if (this.closed) {
      return;
    }
    if (
      message instanceof Uint8Array &&
      message.byteLength > 0 &&
      message.byteLength <= AudioFormat.FRAME_BYTES &&
      message.byteLength % 2 === 0
    ) {
      this.appendFrame(message);
      return;
    }
    this.failCapture();
  }

  private failCapture(): void {
    if (this.isCaptureClosed()) {
      return;
    }
    this.dispose();
    this.fail();
  }

  private stopMicrophoneTracks(): void {
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
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
    this.stopMicrophoneTracks();
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.onprocessorerror = null;
      this.worklet.disconnect();
      this.worklet.port.close();
    }
    if (this.context) {
      void this.context.close().catch(() => {});
    }
    this.context = null;
    this.worklet = null;
  }
}
