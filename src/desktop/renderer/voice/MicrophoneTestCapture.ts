import workletUrl from './MicrophoneTestProcessor.ts?worker&url';
import {
  MicrophoneMeasurementEventSchema,
  type MicrophoneMeasurementEvent,
} from './MicrophoneMeasurements.js';
import { createMicrophoneConstraints } from './Microphones.js';

/** One exact device, one six-second test, scalar results only. dispose also fences late setup. */
export class MicrophoneTestCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isClosed = false;
  private hasStarted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly receive: (event: MicrophoneMeasurementEvent) => void,
    private readonly fail: () => void,
  ) {}

  async startTest(deviceId: string): Promise<void> {
    if (this.isDisposed()) {
      return;
    }
    if (this.hasStarted || deviceId === 'default' || deviceId === 'communications') {
      throw new Error('Choose one explicit microphone for testing.');
    }
    this.hasStarted = true;
    this.timer = setTimeout(() => {
      this.failTest();
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
          this.failTest();
        };
      }
      const context = new AudioContext();
      this.context = context;
      await context.audioWorklet.addModule(workletUrl);
      if (this.isDisposed()) {
        return;
      }
      const worklet = new AudioWorkletNode(context, 'tro-microphone-test');
      this.worklet = worklet;
      worklet.onprocessorerror = () => {
        this.failTest();
      };
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (this.isDisposed()) {
          return;
        }
        const parsed = MicrophoneMeasurementEventSchema.safeParse(event.data);
        if (!parsed.success) {
          this.failTest();
          return;
        }
        if (parsed.data.kind === 'result') {
          this.dispose();
        }
        this.receive(parsed.data);
      };
      this.source = context.createMediaStreamSource(stream);
      this.source.connect(worklet);
      worklet.connect(context.destination);
      await context.resume();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private isDisposed(): boolean {
    return this.isClosed;
  }

  private failTest(): void {
    if (!this.isClosed) {
      this.dispose();
      this.fail();
    }
  }

  dispose(): void {
    this.isClosed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
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
