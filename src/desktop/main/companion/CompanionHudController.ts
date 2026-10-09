import {
  PracticeCheckStatus,
  PracticeFailure,
  type PracticeReply,
} from '#contracts/PracticeCheck.js';
import { AgentProgressPhase } from '#contracts/CompanionHud.js';
import { CompletionMode, TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import { TeachingOutcome, type GuidanceReason } from '#contracts/CursorCompanion.js';
import {
  CompanionHudPhase,
  type CompanionHudSnapshot,
  type VoiceMeter,
  type AgentProgress,
} from '#contracts/CompanionHud.js';
import { DesktopLocale, type DesktopLocale as Locale } from '#contracts/DesktopLocale.js';
import { VoiceState, type VoiceEvent } from '#contracts/VoiceInput.js';
import { AgentFailureCode, type AgentResult } from '#contracts/AgentSession.js';
import { randomUUID } from 'node:crypto';
import {
  TeachingMessageKind,
  TeachingPresentationLimits,
  type TeachingMessage,
} from '#contracts/TeachingStep.js';

export interface CompanionHudPort {
  showSnapshot(snapshot: CompanionHudSnapshot): void;
}

export interface CompanionHudClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export const CompanionHudTransitionSource = {
  VOICE_EVENT: 'voice_event',
  VOICE_METER: 'voice_meter',
  AGENT_PROGRESS: 'agent_progress',
  AGENT_RESULT: 'agent_result',
  TASK_START: 'task_start',
  PRACTICE_START: 'practice_start',
  PRACTICE_REPLY: 'practice_reply',
  HIDE_TIMER: 'hide_timer',
  RESET: 'reset',
} as const;

interface CompanionHudTransitionCause {
  source: (typeof CompanionHudTransitionSource)[keyof typeof CompanionHudTransitionSource];
  voiceEventKind?: VoiceEvent['kind'];
  voiceState?: (typeof VoiceState)[keyof typeof VoiceState];
  progressPhase?: AgentProgress['phase'];
  resultKind?: AgentResult['kind'];
  teachingOutcome?: TeachingOutcome;
  teachingReason?: GuidanceReason;
  taskOutcomeStatus?: (typeof TaskOutcomeStatus)[keyof typeof TaskOutcomeStatus];
  failureCode?: (typeof AgentFailureCode)[keyof typeof AgentFailureCode];
  practiceReplyKind?: PracticeReply['kind'];
  practiceStatus?: (typeof PracticeCheckStatus)[keyof typeof PracticeCheckStatus];
  practiceFailureCode?: (typeof PracticeFailure)[keyof typeof PracticeFailure];
}

/** Lifecycle metadata only. Teaching messages, answers and transcripts are excluded. */
export interface CompanionHudTransition extends CompanionHudTransitionCause {
  previousPhase: CompanionHudSnapshot['phase'];
  nextPhase: CompanionHudSnapshot['phase'];
  sessionId: string | null;
  captureId: string | null;
  lessonId: string | null;
}

interface CompanionHudTransitionContext extends CompanionHudTransitionCause {
  sessionId?: string | null;
  captureId?: string | null;
  lessonId?: string | null;
}

/** Reduces existing lifecycle events into an optional native presentation.
 * It cannot capture audio or submit a task. Capture/task identities fence late events. */
export class CompanionHudController {
  private practiceRequestId: string | null = null;
  private practiceCheckId: string | null = null;
  private captureId: string | null = null;
  private sessionId: string | null = null;
  private sequence = -1;
  private lastMeterAt = -Infinity;
  private acceptsMeter = false;
  private cancelHide: (() => void) | null = null;
  private publishedPhase: CompanionHudSnapshot['phase'] = CompanionHudPhase.IDLE;
  private snapshot: CompanionHudSnapshot = {
    phase: CompanionHudPhase.IDLE,
    locale: DesktopLocale.ENGLISH,
    level: 0,
  };

  constructor(
    private readonly port: CompanionHudPort,
    private readonly clock: CompanionHudClock,
    private readonly reportTransition?: (transition: CompanionHudTransition) => void,
  ) {}

  /** Practice owns the HUD only while voice/teaching is idle. No evidence enters presentation. */
  startPractice(
    requestId: string,
    kind: 'check' | 'submit-snapshot',
    locale: Locale = this.snapshot.locale,
  ): boolean {
    if (
      this.captureId ||
      this.sessionId ||
      this.snapshot.speakingSequence != null ||
      (this.practiceRequestId && this.practiceRequestId !== requestId)
    ) {
      return false;
    }
    const cause = { source: CompanionHudTransitionSource.PRACTICE_START };
    this.resetPresentation(cause);
    this.practiceRequestId = requestId;
    this.setLocale(locale);
    this.showPhase(
      kind === 'check' ? CompanionHudPhase.CHECKING : CompanionHudPhase.SUBMITTING,
      cause,
    );
    this.cancelHide = this.clock.schedule(() => {
      this.receivePracticeReply(requestId, { kind: 'failed', code: PracticeFailure.UNAVAILABLE });
    }, 100_000);
    return true;
  }

  receivePracticeReply(requestId: string, reply: PracticeReply): void {
    if (requestId !== this.practiceRequestId) {
      return;
    }
    if (reply.kind === 'check' && reply.check.status === PracticeCheckStatus.RUNNING) {
      this.practiceCheckId = reply.check.id;
      return;
    }
    if (reply.kind === 'history') {
      const check = reply.checks.find((item) => item.id === this.practiceCheckId);
      if (!check || check.status === PracticeCheckStatus.RUNNING) {
        return;
      }
      this.receivePracticeReply(requestId, { kind: 'check', check });
      return;
    }
    this.practiceRequestId = null;
    this.practiceCheckId = null;
    this.finishPresentation(
      reply.kind === 'submitted'
        ? CompanionHudPhase.SUBMITTED
        : reply.kind === 'check' && reply.check.status === PracticeCheckStatus.COMPLETED
          ? CompanionHudPhase.CHECKED
          : CompanionHudPhase.ERROR,
      2200,
      {
        source: CompanionHudTransitionSource.PRACTICE_REPLY,
        practiceReplyKind: reply.kind,
        ...(reply.kind === 'check' ? { practiceStatus: reply.check.status } : {}),
        ...(reply.kind === 'failed' ? { practiceFailureCode: reply.code } : {}),
      },
    );
  }

  receivePracticeHistory(reply: PracticeReply): void {
    if (this.practiceRequestId && this.practiceCheckId) {
      this.receivePracticeReply(this.practiceRequestId, reply);
    }
  }

  setSpeakingMessage(message: TeachingMessage | null): void {
    this.snapshot = {
      ...this.snapshot,
      ...(message ? { message } : {}),
      speakingSequence: message?.sequence ?? null,
    };
    if (message) {
      this.cancelHide?.();
      this.cancelHide = null;
    }
    this.publish();
    if (!message && !this.sessionId && this.snapshot.phase === CompanionHudPhase.DONE) {
      this.cancelHide = this.clock.schedule(() => {
        this.resetPresentation({ source: CompanionHudTransitionSource.HIDE_TIMER });
      }, 2000);
    }
  }

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
    const cause: CompanionHudTransitionContext = {
      source: CompanionHudTransitionSource.VOICE_EVENT,
      voiceEventKind: event.kind,
      ...(event.kind === 'status' ? { voiceState: event.status.state } : {}),
      ...('captureId' in event ? { captureId: event.captureId } : {}),
      ...('sessionId' in event ? { sessionId: event.sessionId } : {}),
    };
    switch (event.kind) {
      case 'prepare':
        if (!this.snapshot.message || !this.sessionId) {
          this.resetPresentation(cause);
        }
        this.cancelHide?.();
        this.cancelHide = null;
        this.sequence = -1;
        this.lastMeterAt = -Infinity;
        this.captureId = event.captureId;
        this.acceptsMeter = true;
        this.showPhase(CompanionHudPhase.PREPARING, cause);
        break;
      case 'record':
        // Relay readiness is not evidence that the microphone has opened.
        break;
      case 'release':
        if (event.captureId === this.captureId) {
          this.acceptsMeter = false;
          this.showPhase(CompanionHudPhase.TRANSCRIBING, cause);
        }
        break;
      case 'admitting':
        if (event.captureId === this.captureId) {
          this.showPhase(CompanionHudPhase.SENDING, cause);
        }
        break;
      case 'submitted':
        if (event.captureId === this.captureId) {
          this.sessionId = event.sessionId;
          this.showPhase(CompanionHudPhase.SENDING, cause);
        }
        break;
      case 'result':
        if (
          event.sessionId === this.sessionId &&
          (event.captureId === this.captureId || event.result.kind === 'teaching')
        ) {
          this.finishTaskResult(event.result, cause);
        }
        break;
      case 'cancel':
        if (event.captureId === this.captureId) {
          if (this.snapshot.message && this.sessionId) {
            this.captureId = null;
            this.acceptsMeter = false;
            this.showPhase(CompanionHudPhase.WAITING, cause);
          } else {
            this.finishPresentation(CompanionHudPhase.CANCELED, 500, cause);
          }
        }
        break;
      case 'failed':
        if (this.snapshot.phase !== CompanionHudPhase.IDLE) {
          if (this.sessionId && this.snapshot.message?.lessonId) {
            this.showLessonVoiceFailure(cause, this.sessionId, this.snapshot.message.lessonId);
          } else {
            this.finishPresentation(CompanionHudPhase.ERROR, 1800, cause);
          }
        }
        break;
      case 'status':
        if (event.status.state === VoiceState.DISABLED) {
          this.resetPresentation(cause);
        } else if (
          event.status.state === VoiceState.IDLE &&
          this.captureId &&
          !this.sessionId &&
          this.snapshot.phase === CompanionHudPhase.TRANSCRIBING
        ) {
          this.resetPresentation(cause);
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
    this.publish({ source: CompanionHudTransitionSource.VOICE_METER });
  }

  startTask(sessionId: string, locale: Locale): void {
    const cause = { source: CompanionHudTransitionSource.TASK_START };
    this.resetPresentation(cause);
    this.sessionId = sessionId;
    this.setLocale(locale);
    this.showPhase(CompanionHudPhase.SENDING, cause);
  }

  receiveProgress(progress: AgentProgress): void {
    if (progress.sessionId === this.sessionId) {
      const message = progress.teachingMessage;
      const current = this.snapshot.message;
      if (
        message &&
        current &&
        message.lessonId === current.lessonId &&
        (message.sequence < current.sequence ||
          (message.sequence === current.sequence &&
            (message.stepId !== current.stepId ||
              message.text !== current.text ||
              message.kind !== current.kind)))
      ) {
        return;
      }
      this.cancelHide?.();
      this.cancelHide = null;
      if (progress.locale) {
        this.setLocale(progress.locale);
      }
      if (message) {
        this.snapshot = { ...this.snapshot, message };
      } else if (
        progress.teachingStep &&
        progress.lessonId &&
        progress.teachingStep !== current?.text
      ) {
        this.snapshot = {
          ...this.snapshot,
          message: {
            lessonId: progress.lessonId,
            stepId: randomUUID(),
            sequence: (current?.sequence ?? 0) + 1,
            kind:
              progress.phase === AgentProgressPhase.NEEDS_INPUT ||
              progress.phase === AgentProgressPhase.PAUSED
                ? TeachingMessageKind.QUESTION
                : TeachingMessageKind.INSTRUCTION,
            text: progress.teachingStep.slice(0, TeachingPresentationLimits.MAX_CHARACTERS),
          },
        };
      }
      this.showPhase(
        message?.kind === TeachingMessageKind.COMPLETION
          ? CompanionHudPhase.DONE
          : progress.phase === AgentProgressPhase.WAITING
            ? CompanionHudPhase.WAITING
            : progress.phase === AgentProgressPhase.PAUSED
              ? CompanionHudPhase.NEEDS_INPUT
              : progress.phase,
        {
          source: CompanionHudTransitionSource.AGENT_PROGRESS,
          progressPhase: progress.phase,
          lessonId: progress.lessonId ?? this.snapshot.message?.lessonId ?? null,
        },
      );
    }
  }

  finishTask(result: AgentResult, sessionId?: string): void {
    if (sessionId && sessionId !== this.sessionId) {
      return;
    }
    this.finishTaskResult(result, { source: CompanionHudTransitionSource.AGENT_RESULT });
  }

  private finishTaskResult(result: AgentResult, cause: CompanionHudTransitionContext): void {
    if (result.kind === 'accepted') {
      return;
    }
    const phase = this.readResultPhase(result);
    const message = this.snapshot.message;
    const delayMs =
      phase === CompanionHudPhase.DONE && message?.kind === TeachingMessageKind.COMPLETION
        ? message.text.split(/\s+/).length * TeachingPresentationLimits.WORD_MS +
          TeachingPresentationLimits.HOLD_MS +
          TeachingPresentationLimits.FADE_MS
        : phase === CompanionHudPhase.DONE
          ? 650
          : 1800;
    if (phase !== CompanionHudPhase.DONE) {
      this.snapshot = { ...this.snapshot, message: null };
    }
    this.finishPresentation(phase, delayMs, {
      ...cause,
      resultKind: result.kind,
      lessonId: message?.lessonId ?? null,
      ...(result.kind === 'teaching' ? { teachingOutcome: result.result.outcome } : {}),
      ...(result.kind === 'teaching' && 'reason' in result.result
        ? { teachingReason: result.result.reason }
        : {}),
      ...(result.kind === 'completed' && result.completion.kind === CompletionMode.TASK
        ? { taskOutcomeStatus: result.completion.outcome.status }
        : {}),
      ...(result.kind === 'failed' && result.code ? { failureCode: result.code } : {}),
    });
  }

  private readResultPhase(result: AgentResult): CompanionHudSnapshot['phase'] {
    if (result.kind === 'teaching') {
      switch (result.result.outcome) {
        case TeachingOutcome.GOAL_REACHED:
        case TeachingOutcome.DEMONSTRATED:
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
    this.resetPresentation({ source: CompanionHudTransitionSource.RESET });
  }

  private resetPresentation(cause: CompanionHudTransitionContext): void {
    const identity = {
      captureId: this.captureId,
      sessionId: this.sessionId,
      lessonId: this.snapshot.message?.lessonId ?? null,
    };
    this.practiceRequestId = null;
    this.practiceCheckId = null;
    this.cancelHide?.();
    this.cancelHide = null;
    this.captureId = null;
    this.sessionId = null;
    this.acceptsMeter = false;
    this.sequence = -1;
    this.lastMeterAt = -Infinity;
    this.snapshot = { phase: CompanionHudPhase.IDLE, locale: this.snapshot.locale, level: 0 };
    this.showPhase(CompanionHudPhase.IDLE, { ...identity, ...cause });
  }

  private finishPresentation(
    phase: CompanionHudSnapshot['phase'],
    delayMs: number,
    cause: CompanionHudTransitionContext,
  ): void {
    const identity = {
      captureId: this.captureId,
      sessionId: this.sessionId,
      lessonId: this.snapshot.message?.lessonId ?? null,
    };
    this.captureId = null;
    this.sessionId = null;
    this.acceptsMeter = false;
    this.cancelHide?.();
    this.showPhase(phase, { ...identity, ...cause });
    this.cancelHide = this.clock.schedule(() => {
      if (this.snapshot.speakingSequence !== null && this.snapshot.speakingSequence !== undefined) {
        return;
      }
      this.resetPresentation({ source: CompanionHudTransitionSource.HIDE_TIMER });
    }, delayMs);
  }

  /** A failed follow-up capture does not end the lesson that owns the question. */
  private showLessonVoiceFailure(
    cause: CompanionHudTransitionContext,
    sessionId: string,
    lessonId: string,
  ): void {
    const captureId = this.captureId;
    this.captureId = null;
    this.acceptsMeter = false;
    this.cancelHide?.();
    this.cancelHide = null;
    this.showPhase(CompanionHudPhase.ERROR, { ...cause, sessionId, captureId, lessonId });
    this.cancelHide = this.clock.schedule(() => {
      this.cancelHide = null;
      if (
        this.sessionId === sessionId &&
        this.snapshot.message?.lessonId === lessonId &&
        this.snapshot.phase === CompanionHudPhase.ERROR
      ) {
        this.showPhase(CompanionHudPhase.NEEDS_INPUT, {
          source: CompanionHudTransitionSource.HIDE_TIMER,
          sessionId,
          lessonId,
        });
      }
    }, 1800);
  }

  private showPhase(
    phase: CompanionHudSnapshot['phase'],
    cause: CompanionHudTransitionContext,
  ): void {
    this.snapshot = { ...this.snapshot, phase, level: 0 };
    this.publish(cause);
  }

  private publish(cause?: CompanionHudTransitionContext): void {
    const previousPhase = this.publishedPhase;
    const nextPhase = this.snapshot.phase;
    this.publishedPhase = nextPhase;
    try {
      this.port.showSnapshot(this.snapshot);
    } catch {
      /* Presentation failure never interrupts voice. */
    }
    if (cause && previousPhase !== nextPhase) {
      try {
        this.reportTransition?.({
          previousPhase,
          nextPhase,
          sessionId: this.sessionId,
          captureId: this.captureId,
          lessonId: this.snapshot.message?.lessonId ?? null,
          ...cause,
        });
      } catch {
        /* Diagnostics never interrupt presentation or lifecycle handling. */
      }
    }
  }
}
