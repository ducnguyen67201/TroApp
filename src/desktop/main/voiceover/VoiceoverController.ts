import { randomUUID } from 'node:crypto';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { AgentProgress } from '#contracts/CompanionHud.js';
import { TeachingMessageKind, type TeachingMessage } from '#contracts/TeachingStep.js';
import {
  VoiceoverLimits,
  VoiceoverState,
  type VoiceoverPlayback,
  type VoiceoverRequest,
  type VoiceoverStatus,
} from '#contracts/Voiceover.js';

const VoiceoverStopReason = {
  INTERRUPTED: 'interrupted',
  MESSAGE_REPLACED: 'message_replaced',
  MESSAGE_HIDDEN: 'message_hidden',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

type VoiceoverStopReason = (typeof VoiceoverStopReason)[keyof typeof VoiceoverStopReason];

const VoiceoverEventKind = {
  COMPLETION_RETAINED: 'completion_retained',
  PLAYBACK_FINISHED: 'playback_finished',
  STOPPED: 'stopped',
} as const;

export interface VoiceoverEvent {
  kind: (typeof VoiceoverEventKind)[keyof typeof VoiceoverEventKind];
  utteranceId: string;
  messageKind: TeachingMessage['kind'];
  messageSequence: number;
  reason?: VoiceoverStopReason;
}

interface ActiveUtterance {
  id: string;
  abort: AbortController;
  message: TeachingMessage;
}

export interface VoiceoverDependencies {
  canSpeak(): boolean;
  fetchSpeech(request: VoiceoverRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  sendPlayback(command: VoiceoverPlayback): Promise<boolean>;
  showStatus(status: VoiceoverStatus): void;
  holdMessage(message: TeachingMessage | null): void;
  reportFailure(stage: string): void;
  reportEvent?(event: VoiceoverEvent): void;
}

/** Reads only the current accepted and natively visible message, once per sequence. */
export class VoiceoverController {
  private sessionId: string | null = null;
  private candidate: AgentProgress | null = null;
  private visible: TeachingMessage | null = null;
  private lastIdentity: string | null = null;
  private active: ActiveUtterance | null = null;
  private stopping: Promise<boolean> = Promise.resolve(true);
  private enabled = true;
  private locale: DesktopLocale | null = null;
  private pendingStopId: string | null = null;

  constructor(private readonly dependencies: VoiceoverDependencies) {}

  startTask(sessionId: string, locale?: DesktopLocale): void {
    void this.stopSpeaking();
    this.sessionId = sessionId;
    if (locale) {
      this.locale = locale;
    }
    this.candidate = null;
    this.visible = null;
    this.lastIdentity = null;
  }

  receiveProgress(progress: AgentProgress): void {
    if (
      progress.sessionId !== this.sessionId ||
      !progress.teachingMessage ||
      !progress.locale ||
      (this.locale !== null && progress.locale !== this.locale)
    ) {
      return;
    }
    const current = this.candidate?.teachingMessage;
    if (
      current &&
      current.lessonId === progress.teachingMessage.lessonId &&
      progress.teachingMessage.sequence < current.sequence
    ) {
      return;
    }
    if (
      current &&
      current.lessonId === progress.teachingMessage.lessonId &&
      current.sequence === progress.teachingMessage.sequence &&
      (current.text !== progress.teachingMessage.text ||
        current.kind !== progress.teachingMessage.kind ||
        current.stepId !== progress.teachingMessage.stepId ||
        this.candidate?.locale !== progress.locale)
    ) {
      return;
    }
    if (current && this.readIdentity(current) !== this.readIdentity(progress.teachingMessage)) {
      void this.stopSpeaking();
    }
    this.candidate = progress;
    if (progress.presentationRevoked) {
      // Retain the identity so a late native poll or ordinary progress cannot replay it.
      this.lastIdentity = this.readIdentity(progress.teachingMessage);
      void this.stopSpeaking();
      return;
    }
    this.trySpeak();
  }

  receiveVisibleMessage(message: TeachingMessage | null): void {
    const active = this.active;
    /* A completion was already verified as visible before speech started.
       Native frame polling can briefly return null during repaint or fade;
       audio drain, rather than that visibility loss, releases its final hold. */
    if (!message && active?.message.kind === TeachingMessageKind.COMPLETION) {
      if (this.visible) {
        this.dependencies.holdMessage(active.message);
        this.reportEvent(VoiceoverEventKind.COMPLETION_RETAINED, active);
      }
      this.visible = null;
      return;
    }
    if (
      message &&
      active?.message.kind === TeachingMessageKind.COMPLETION &&
      message.lessonId === active.message.lessonId &&
      message.sequence < active.message.sequence
    ) {
      return;
    }
    const currentMessage = active?.message ?? this.visible;
    if (
      !message ||
      (currentMessage && this.readIdentity(currentMessage) !== this.readIdentity(message))
    ) {
      void this.stopSpeaking(
        message ? VoiceoverStopReason.MESSAGE_REPLACED : VoiceoverStopReason.MESSAGE_HIDDEN,
      );
    }
    this.visible = message;
    this.trySpeak();
  }

  setLocale(locale: DesktopLocale): void {
    if (locale !== this.locale) {
      this.locale = locale;
      this.candidate = null;
      void this.stopSpeaking();
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.candidate?.teachingMessage) {
      this.lastIdentity = this.readIdentity(this.candidate.teachingMessage);
    }
    if (!enabled) {
      void this.stopSpeaking();
    }
  }

  clearTask(): void {
    this.sessionId = null;
    this.candidate = null;
    this.visible = null;
    void this.stopSpeaking();
  }

  stopSpeaking(reason: VoiceoverStopReason = VoiceoverStopReason.INTERRUPTED): Promise<boolean> {
    const active = this.active;
    this.active = null;
    if (active) {
      this.reportEvent(VoiceoverEventKind.STOPPED, active, reason);
    }
    active?.abort.abort();
    this.dependencies.holdMessage(null);
    this.dependencies.showStatus({ state: VoiceoverState.IDLE });
    const id = active?.id ?? this.pendingStopId;
    if (id) {
      this.pendingStopId = id;
      this.stopping = this.dependencies
        .sendPlayback({ kind: 'stop', utteranceId: id, sequence: -1 })
        .catch(() => false)
        .then((accepted) => {
          if (accepted && this.pendingStopId === id) {
            this.pendingStopId = null;
          }
          return accepted;
        });
    }
    return this.stopping;
  }

  private hasActiveUtterance(): boolean {
    return this.active !== null;
  }

  private readIdentity(message: TeachingMessage): string {
    return `${message.lessonId}:${String(message.sequence)}:${message.stepId}`;
  }

  private reportEvent(
    kind: VoiceoverEvent['kind'],
    active: ActiveUtterance,
    reason?: VoiceoverStopReason,
  ): void {
    this.dependencies.reportEvent?.({
      kind,
      utteranceId: active.id,
      messageKind: active.message.kind,
      messageSequence: active.message.sequence,
      ...(reason ? { reason } : {}),
    });
  }

  private trySpeak(): void {
    const progress = this.candidate;
    const message = progress?.teachingMessage;
    if (
      !message ||
      !progress.locale ||
      !this.visible ||
      !this.enabled ||
      this.readIdentity(message) === this.lastIdentity ||
      message.lessonId !== this.visible.lessonId ||
      message.stepId !== this.visible.stepId ||
      message.sequence !== this.visible.sequence ||
      message.kind !== this.visible.kind ||
      message.text !== this.visible.text
    ) {
      return;
    }
    this.lastIdentity = this.readIdentity(message);
    if (!this.dependencies.canSpeak()) {
      return;
    }
    const active = { id: randomUUID(), abort: new AbortController(), message };
    const stopping = this.stopSpeaking();
    this.active = active;
    this.dependencies.holdMessage(message);
    this.dependencies.showStatus({ state: VoiceoverState.PREPARING });
    void this.readMessageAloud(
      { utteranceId: active.id, message, locale: progress.locale },
      active,
      stopping,
    );
  }

  private async sendPlayback(command: VoiceoverPlayback, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    let rejectOnAbort = (): void => {};
    try {
      return await new Promise<boolean>((resolve, reject) => {
        rejectOnAbort = () => {
          reject(new Error('Speech canceled.'));
        };
        signal.addEventListener('abort', rejectOnAbort, { once: true });
        void this.dependencies.sendPlayback(command).then(resolve, reject);
      });
    } finally {
      signal.removeEventListener('abort', rejectOnAbort);
    }
  }

  private async readMessageAloud(
    request: VoiceoverRequest,
    active: ActiveUtterance,
    stopping: Promise<boolean>,
  ): Promise<void> {
    const startup = setTimeout(() => {
      active.abort.abort();
    }, VoiceoverLimits.START_TIMEOUT_MS);
    const deadline = setTimeout(() => {
      active.abort.abort();
    }, VoiceoverLimits.MAX_DURATION_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = (): void => {
      void reader?.cancel().catch(() => {});
    };
    try {
      if (!(await stopping)) {
        throw new Error('Playback did not stop.');
      }
      active.abort.signal.throwIfAborted();
      if (
        !(await this.sendPlayback(
          {
            kind: 'start',
            utteranceId: active.id,
            sequence: 0,
          },
          active.abort.signal,
        ))
      ) {
        throw new Error('Playback unavailable.');
      }
      active.abort.signal.throwIfAborted();
      const stream = await this.dependencies.fetchSpeech(request, active.abort.signal);
      reader = stream.getReader();
      active.abort.signal.addEventListener('abort', cancelReader, { once: true });
      active.abort.signal.throwIfAborted();
      let sequence = 0;
      let bytes = 0;
      let tail = new Uint8Array();
      for (;;) {
        active.abort.signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) {
          break;
        }
        bytes += next.value.length;
        if (bytes > VoiceoverLimits.MAX_BYTES) {
          throw new Error('Speech audio too large.');
        }
        const joined = new Uint8Array(tail.length + next.value.length);
        joined.set(tail);
        joined.set(next.value, tail.length);
        const evenLength = joined.length - (joined.length % 2);
        tail = joined.slice(evenLength);
        for (let offset = 0; offset < evenLength; offset += VoiceoverLimits.CHUNK_BYTES) {
          active.abort.signal.throwIfAborted();
          const pcm = joined.slice(
            offset,
            Math.min(evenLength, offset + VoiceoverLimits.CHUNK_BYTES),
          );
          if (
            !(await this.sendPlayback(
              {
                kind: 'chunk',
                utteranceId: active.id,
                sequence: ++sequence,
                pcm,
              },
              active.abort.signal,
            ))
          ) {
            throw new Error('Playback failed.');
          }
          if (sequence === 1) {
            clearTimeout(startup);
            if (this.active === active) {
              this.dependencies.showStatus({ state: VoiceoverState.SPEAKING });
            }
          }
        }
      }
      active.abort.signal.throwIfAborted();
      if (!bytes || tail.length) {
        throw new Error('Invalid speech audio.');
      }
      if (
        !(await this.sendPlayback(
          {
            kind: 'end',
            utteranceId: active.id,
            sequence: ++sequence,
          },
          active.abort.signal,
        ))
      ) {
        throw new Error('Playback did not finish.');
      }
      if (this.active === active) {
        this.reportEvent(VoiceoverEventKind.PLAYBACK_FINISHED, active);
        await this.stopSpeaking(VoiceoverStopReason.COMPLETED);
      }
    } catch {
      if (this.active === active) {
        await this.stopSpeaking(VoiceoverStopReason.FAILED);
        this.dependencies.reportFailure('playback');
        if (!this.hasActiveUtterance()) {
          this.dependencies.showStatus({ state: VoiceoverState.UNAVAILABLE });
        }
      }
    } finally {
      clearTimeout(startup);
      clearTimeout(deadline);
      active.abort.signal.removeEventListener('abort', cancelReader);
      active.abort.abort();
      await reader?.cancel().catch(() => {});
    }
  }
}
