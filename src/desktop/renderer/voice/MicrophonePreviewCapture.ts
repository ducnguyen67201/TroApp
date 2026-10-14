import workletUrl from './MicrophonePreviewProcessor.ts?worker&url';
import { MicrophoneMeasurementEventSchema } from './MicrophoneMeasurements.js';
import { createMicrophoneConstraints } from './Microphones.js';

/** One local input-level preview. Disposal fences permission/setup replies and stops every track. */
export class MicrophonePreviewCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isClosed = false;
  private hasStarted = false;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly receive: (levelDb: number) => void,
    private readonly fail: () => void,
  ) {}

  async startPreview(deviceId: string): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    if (this.hasStarted || deviceId === 'communications') {
      throw new Error('Choose one microphone route for the input preview.');
    }
    this.hasStarted = true;
    this.startupTimer = setTimeout(() => {
      this.failPreview();
    }, 15_000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        createMicrophoneConstraints(deviceId),
      );
      if (this.isDisposed()) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          this.failPreview();
        };
      }
      const context = new AudioContext();
      this.context = context;
      await context.audioWorklet.addModule(workletUrl);
      if (this.isDisposed()) {
        return;
      }
      const worklet = new AudioWorkletNode(context, 'tro-microphone-preview');
      this.worklet = worklet;
      worklet.onprocessorerror = () => {
        this.failPreview();
      };
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (this.isDisposed()) {
          return;
        }
        const parsed = MicrophoneMeasurementEventSchema.safeParse(event.data);
        if (!parsed.success || parsed.data.kind !== 'level') {
          this.failPreview();
          return;
        }
        this.receive(parsed.data.levelDb);
      };
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(worklet);
      worklet.connect(context.destination);
      await context.resume();
      if (this.isDisposed()) {
        return;
      }
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private isDisposed(): boolean {
    return this.isClosed;
  }

  private failPreview(): void {
    if (!this.isDisposed()) {
      this.dispose();
      this.fail();
    }
  }

  dispose(): void {
    this.isClosed = true;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      this.stream = null;
    }
    this.source?.disconnect();
    this.source = null;
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.onprocessorerror = null;
      this.worklet.disconnect();
      this.worklet.port.close();
      this.worklet = null;
    }
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
