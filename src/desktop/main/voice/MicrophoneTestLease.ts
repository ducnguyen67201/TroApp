import {
  MicrophoneCaptureMode,
  microphoneTestLeaseMs,
  type MicrophoneTestEvent,
  type MicrophoneTestReply,
} from '#contracts/MicrophoneTest.js';

interface MicrophoneTestDependencies {
  canStart(): boolean;
  requestAccess(): Promise<boolean>;
  schedule(callback: () => void, delayMs: number): () => void;
  emit(event: MicrophoneTestEvent): void;
}

/** Reservation covers pending authorization too, so hold-to-talk cannot race a test. */
export class MicrophoneTestLease {
  private generation = 0;
  private expiryGeneration = 0;
  private hasAuthorization = false;
  private testId: string | null = null;
  private mode: MicrophoneCaptureMode = MicrophoneCaptureMode.TEST;
  private cancelTimer: (() => void) | undefined;

  constructor(private readonly dependencies: MicrophoneTestDependencies) {}

  isActive(): boolean {
    return this.testId !== null;
  }

  isAuthorized(): boolean {
    return this.isActive() && this.hasAuthorization;
  }

  async startTest(
    testId: string,
    mode: MicrophoneCaptureMode = MicrophoneCaptureMode.TEST,
  ): Promise<MicrophoneTestReply> {
    if (this.isActive() || !this.dependencies.canStart()) {
      return { kind: 'failed' };
    }
    const generation = ++this.generation;
    this.testId = testId;
    this.mode = mode;
    this.scheduleExpiry();
    try {
      const isAllowed = await this.dependencies.requestAccess();
      if (this.testId !== testId || generation !== this.generation) {
        return { kind: 'failed' };
      }
      if (!isAllowed || !this.dependencies.canStart()) {
        this.cancelTest();
        return { kind: 'failed' };
      }
      this.hasAuthorization = true;
      return { kind: 'ok' };
    } catch {
      if (generation === this.generation) {
        this.stopTest(testId);
      }
      return { kind: 'failed' };
    }
  }

  /** Only an authorized preview can extend its existing exclusive reservation. */
  renewTest(testId: string): MicrophoneTestReply {
    if (
      this.testId !== testId ||
      !this.hasAuthorization ||
      this.mode !== MicrophoneCaptureMode.PREVIEW ||
      !this.dependencies.canStart()
    ) {
      return { kind: 'failed' };
    }
    this.scheduleExpiry();
    return { kind: 'ok' };
  }

  private scheduleExpiry(): void {
    this.cancelTimer?.();
    const expiryGeneration = ++this.expiryGeneration;
    this.cancelTimer = this.dependencies.schedule(() => {
      if (expiryGeneration === this.expiryGeneration) {
        this.cancelTest();
      }
    }, microphoneTestLeaseMs);
  }

  stopTest(testId: string): MicrophoneTestReply {
    if (this.testId !== testId) {
      return { kind: 'failed' };
    }
    this.generation += 1;
    this.expiryGeneration += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.testId = null;
    this.mode = MicrophoneCaptureMode.TEST;
    this.hasAuthorization = false;
    return { kind: 'ok' };
  }

  cancelTest(): void {
    const testId = this.testId;
    if (testId) {
      this.stopTest(testId);
      this.dependencies.emit({ kind: 'canceled', testId });
    }
  }
}
