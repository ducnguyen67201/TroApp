import {
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
  private hasAuthorization = false;
  private testId: string | null = null;
  private cancelTimer: (() => void) | undefined;

  constructor(private readonly dependencies: MicrophoneTestDependencies) {}

  isActive(): boolean {
    return this.testId !== null;
  }

  isAuthorized(): boolean {
    return this.isActive() && this.hasAuthorization;
  }

  async startTest(testId: string): Promise<MicrophoneTestReply> {
    if (this.isActive() || !this.dependencies.canStart()) {
      return { kind: 'failed' };
    }
    const generation = ++this.generation;
    this.testId = testId;
    this.cancelTimer = this.dependencies.schedule(() => {
      this.cancelTest();
    }, microphoneTestLeaseMs);
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

  stopTest(testId: string): MicrophoneTestReply {
    if (this.testId !== testId) {
      return { kind: 'failed' };
    }
    this.generation += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.testId = null;
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
