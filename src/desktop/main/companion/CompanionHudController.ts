import { CompletionMode, TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import { TeachingOutcome } from '#contracts/CursorCompanion.js';
import {
  CompanionHudPhase,
  type CompanionHudSnapshot,
  type VoiceMeter,
  type AgentProgress,
} from '#contracts/CompanionHud.js';
import { DesktopLocale, type DesktopLocale as Locale } from '#contracts/DesktopLocale.js';
import { VoiceState, type VoiceEvent } from '#contracts/VoiceInput.js';
import { AgentFailureCode, type AgentResult } from '#contracts/AgentSession.js';

export interface CompanionHudPort {
  showSnapshot(snapshot: CompanionHudSnapshot): void;
}

export interface CompanionHudClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

/** Reduces existing lifecycle events into an optional native presentation.
 * It cannot capture audio or submit a task. Capture/task identities fence late events. */
export class CompanionHudController {
  private captureId: string | null = null;
  private sessionId: string | null = null;
  private sequence = -1;
  private lastMeterAt = -Infinity;
  private acceptsMeter = false;
  private cancelHide: (() => void) | null = null;
  private snapshot: CompanionHudSnapshot = {
    phase: CompanionHudPhase.IDLE,
    locale: DesktopLocale.ENGLISH,
    level: 0,
  };

  constructor(
    private readonly port: CompanionHudPort,
    private readonly clock: CompanionHudClock,
  ) {}

  setLocale(locale: Locale): void {
    this.snapshot = { ...this.snapshot, locale };
  }

  setCaptureLocale(captureId: string, locale: Locale): void {
    if (captureId === this.captureId) {
      this.setLocale(locale);
      this.publish();
    }
  }

  receiveVoiceEvent(event: VoiceEvent): void {
    switch (event.kind) {
      case 'prepare':
        this.reset();
        this.captureId = event.captureId;
        this.acceptsMeter = true;
        this.showPhase(CompanionHudPhase.PREPARING);
        break;
      case 'record':
        // Relay readiness is not evidence that the microphone has opened.
        break;
      case 'release':
        if (event.captureId === this.captureId) {
          this.acceptsMeter = false;
          this.showPhase(CompanionHudPhase.TRANSCRIBING);
        }
        break;
      case 'admitting':
        if (event.captureId === this.captureId) {
          this.showPhase(CompanionHudPhase.SENDING);
        }
        break;
      case 'submitted':
        if (event.captureId === this.captureId) {
          this.sessionId = event.sessionId;
          this.showPhase(CompanionHudPhase.SENDING);
        }
        break;
      case 'result':
        if (event.captureId === this.captureId && event.sessionId === this.sessionId) {
          this.finishTask(event.result);
        }
        break;
      case 'cancel':
        if (event.captureId === this.captureId) {
          this.finishPresentation(CompanionHudPhase.CANCELED, 500);
        }
        break;
      case 'failed':
        if (this.snapshot.phase !== CompanionHudPhase.IDLE) {
          this.finishPresentation(CompanionHudPhase.ERROR, 1800);
        }
        break;
      case 'status':
        if (event.status.state === VoiceState.DISABLED) {
          this.reset();
        } else if (
          event.status.state === VoiceState.IDLE &&
          this.captureId &&
          !this.sessionId &&
          this.snapshot.phase === CompanionHudPhase.TRANSCRIBING
        ) {
          this.reset();
        }
        break;
      case 'preview':
        break;
    }
  }

  updateMeter(meter: VoiceMeter): void {
    const now = this.clock.now();
    if (
      !this.acceptsMeter ||
      meter.captureId !== this.captureId ||
      meter.sequence <= this.sequence ||
      now - this.lastMeterAt < 45
    ) {
      return;
    }
    this.sequence = meter.sequence;
    this.lastMeterAt = now;
    this.snapshot = { ...this.snapshot, phase: CompanionHudPhase.LISTENING, level: meter.level };
    this.publish();
  }

  startTask(sessionId: string, locale: Locale): void {
    this.reset();
    this.sessionId = sessionId;
    this.setLocale(locale);
    this.showPhase(CompanionHudPhase.SENDING);
  }

  receiveProgress(progress: AgentProgress): void {
    if (progress.sessionId === this.sessionId) {
      this.showPhase(progress.phase);
    }
  }

  finishTask(result: AgentResult, sessionId?: string): void {
    if (sessionId && sessionId !== this.sessionId) {
      return;
    }
    const phase = this.readResultPhase(result);
    this.finishPresentation(phase, phase === CompanionHudPhase.DONE ? 650 : 1800);
  }

  private readResultPhase(result: AgentResult): CompanionHudSnapshot['phase'] {
    if (result.kind === 'teaching') {
      switch (result.result.outcome) {
        case TeachingOutcome.DEMONSTRATED:
        case TeachingOutcome.EXPLAINED:
          return CompanionHudPhase.DONE;
        case TeachingOutcome.CANCELED:
          return CompanionHudPhase.CANCELED;
        case TeachingOutcome.NEEDS_INPUT:
          return CompanionHudPhase.NEEDS_INPUT;
        case TeachingOutcome.FAILED:
          return CompanionHudPhase.ERROR;
      }
    }
    if (result.kind === 'completed') {
      if (
        result.completion.kind === CompletionMode.TASK &&
        result.completion.outcome.status !== TaskOutcomeStatus.SUCCEEDED
      ) {
        return result.completion.outcome.status === TaskOutcomeStatus.BLOCKED
          ? CompanionHudPhase.NEEDS_INPUT
          : CompanionHudPhase.ERROR;
      }
      return CompanionHudPhase.DONE;
    }
    if (result.kind === 'stopped') {
      return CompanionHudPhase.CANCELED;
    }
    if (result.kind === 'failed' && result.code === AgentFailureCode.DAILY_LIMIT) {
      return CompanionHudPhase.DAILY_LIMIT;
    }
    return CompanionHudPhase.ERROR;
  }

  reset(): void {
    this.cancelHide?.();
    this.cancelHide = null;
    this.captureId = null;
    this.sessionId = null;
    this.acceptsMeter = false;
    this.sequence = -1;
    this.lastMeterAt = -Infinity;
    this.showPhase(CompanionHudPhase.IDLE);
  }

  private finishPresentation(phase: CompanionHudSnapshot['phase'], delayMs: number): void {
    this.captureId = null;
    this.sessionId = null;
    this.acceptsMeter = false;
    this.cancelHide?.();
    this.showPhase(phase);
    this.cancelHide = this.clock.schedule(() => {
      this.reset();
    }, delayMs);
  }

  private showPhase(phase: CompanionHudSnapshot['phase']): void {
    this.snapshot = { ...this.snapshot, phase, level: 0 };
    this.publish();
  }

  private publish(): void {
    try {
      this.port.showSnapshot(this.snapshot);
    } catch {
      /* Presentation failure never interrupts voice. */
    }
  }
}
