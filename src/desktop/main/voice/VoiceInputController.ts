import { randomUUID } from 'node:crypto';
import {
  AudioFormat,
  type TranscriptionCredential,
  TranscriptionEventKind,
  type TranscriptionEvent,
} from '#contracts/Transcription.js';
import {
  VoiceState,
  type VoiceAudioFrame,
  type VoiceEvent,
  type VoiceReply,
  type VoiceShortcut,
  type VoiceStatus,
} from '#contracts/VoiceInput.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { AuthResult } from '#contracts/AuthSession.js';
import type { TranscriptionConnection } from './TranscriptionClient.js';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';

export interface VoiceDependencies {
  readSession(): Promise<AuthResult>;
  releaseUnusedCredential(captureId: string): Promise<void>;
  fetchCredential(captureId: string, locale: DesktopLocale): Promise<TranscriptionCredential>;
  connect(token: string, emit: (event: TranscriptionEvent) => void): TranscriptionConnection;
  isAgentBusy(): boolean;
  areTriggerKeysReleased(): boolean;
  startAgentSession(): Promise<AgentResult>;
  sendAgentMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode: AgentTaskMode,
  ): Promise<AgentResult>;
  emit(event: VoiceEvent): void;
}

interface ActiveCapture {
  id: string;
  userId: string | null;
  locale: DesktopLocale | null;
  mode: AgentTaskMode;
  prepared: boolean;
  connection: TranscriptionConnection | null;
  nextSequence: number;
  samples: number;
  finishing: boolean;
  finalText: string | null;
}

/** Sole authority for voice admission. Invalidated captures cannot submit
 * after cancellation, account changes, duplicate finals, or network races. */
export class VoiceInputController {
  private status: VoiceStatus;
  private capture: ActiveCapture | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private running = 0;
  private lessonAnswerAllowed = false;

  setLessonAnswerAllowed(allowed: boolean): void {
    this.lessonAnswerAllowed = allowed;
    if (this.running > 0 && !this.capture && this.status.state === VoiceState.RUNNING && allowed) {
      this.setState(VoiceState.IDLE);
    }
  }

  constructor(
    private readonly dependencies: VoiceDependencies,
    shortcut: VoiceShortcut,
  ) {
    this.status = { state: VoiceState.DISABLED, shortcut, globalShortcutAvailable: false };
  }

  readStatus(): VoiceStatus {
    return { ...this.status };
  }

  isCapturing(): boolean {
    return this.capture !== null;
  }

  enableVoiceInput(shortcut: VoiceShortcut, globalShortcutAvailable: boolean): VoiceReply {
    this.cancelVoiceCapture();
    this.status = { state: VoiceState.IDLE, shortcut, globalShortcutAvailable };
    this.emitStatus();
    return this.reply();
  }

  invalidateVoiceInput(): void {
    this.generation += 1;
    this.disableVoiceInput();
  }

  disableVoiceInput(): VoiceReply {
    this.cancelVoiceCapture();
    this.status = { ...this.status, state: VoiceState.DISABLED, globalShortcutAvailable: false };
    this.emitStatus();
    return this.reply();
  }

  startVoiceCapture(): VoiceReply {
    if (
      this.status.state !== VoiceState.IDLE ||
      this.capture ||
      (this.running > 0 && !this.lessonAnswerAllowed) ||
      this.dependencies.isAgentBusy()
    ) {
      return { kind: 'failed' };
    }
    const id = randomUUID();
    this.capture = {
      id,
      userId: null,
      locale: null,
      mode: AgentTaskMode.EXECUTE,
      prepared: false,
      connection: null,
      nextSequence: 0,
      samples: 0,
      finishing: false,
      finalText: null,
    };
    this.setState(VoiceState.PREPARING);
    this.dependencies.emit({ kind: 'prepare', captureId: id });
    this.setDeadline(10_000);
    return this.reply();
  }

  async prepareVoiceCapture(
    captureId: string,
    locale: DesktopLocale,
    mode: AgentTaskMode = AgentTaskMode.EXECUTE,
  ): Promise<VoiceReply> {
    const capture = this.capture;
    if (
      !capture ||
      capture.id !== captureId ||
      capture.prepared ||
      this.status.state !== VoiceState.PREPARING
    ) {
      return { kind: 'failed' };
    }
    capture.prepared = true;
    capture.locale = locale;
    capture.mode = mode;
    try {
      const session = await this.dependencies.readSession();
      if (this.capture !== capture) {
        return { kind: 'failed' };
      }
      if (session.kind !== 'signed-in') {
        this.failCapture();
        return { kind: 'failed' };
      }
      capture.userId = session.user.id;
      const credential = await this.dependencies.fetchCredential(captureId, locale);
      if (this.capture !== capture) {
        await this.dependencies.releaseUnusedCredential(captureId);
        return { kind: 'failed' };
      }
      capture.connection = this.dependencies.connect(credential.token, (event) => {
        if (this.capture !== capture) {
          return;
        }
        switch (event.kind) {
          case TranscriptionEventKind.READY:
            if (this.status.state === VoiceState.PREPARING) {
              this.setState(VoiceState.RECORDING);
              this.setDeadline(60_000);
            } else if (this.status.state !== VoiceState.FINALIZING) {
              this.failCapture();
              return;
            }
            this.dependencies.emit({ kind: 'record', captureId });
            break;
          case TranscriptionEventKind.PREVIEW:
            this.dependencies.emit({ kind: 'preview', captureId, text: event.text });
            break;
          case TranscriptionEventKind.FINAL:
            if (capture.finalText !== null) {
              return;
            }
            if (!capture.finishing) {
              this.failCapture();
              return;
            }
            void this.submitVoiceInstruction(capture, event.text);
            break;
          case TranscriptionEventKind.FAILED:
            this.failCapture();
            break;
        }
      });
      if (this.capture !== capture) {
        capture.connection.close();
      }
      return this.reply();
    } catch {
      if (this.capture === capture) {
        this.failCapture();
      }
      return { kind: 'failed' };
    }
  }

  releaseVoiceCapture(): VoiceReply {
    const capture = this.capture;
    if (!capture) {
      return this.reply();
    }
    if (this.status.state === VoiceState.PREPARING || this.status.state === VoiceState.RECORDING) {
      this.setState(VoiceState.FINALIZING);
      this.setDeadline(20_000);
      this.dependencies.emit({ kind: 'release', captureId: capture.id });
    }
    return this.reply();
  }

  appendVoiceAudio(frame: VoiceAudioFrame): VoiceReply {
    const capture = this.capture;
    if (
      !capture ||
      capture.id !== frame.captureId ||
      capture.finishing ||
      !capture.connection ||
      ![VoiceState.RECORDING, VoiceState.FINALIZING].some((state) => state === this.status.state)
    ) {
      return { kind: 'failed' };
    }
    if (
      frame.sequence !== capture.nextSequence ||
      capture.samples + frame.pcm.byteLength / 2 > AudioFormat.SAMPLE_RATE * AudioFormat.MAX_SECONDS
    ) {
      this.failCapture();
      return { kind: 'failed' };
    }
    try {
      capture.connection.sendCommand({
        kind: 'audio',
        sequence: frame.sequence,
        audio: Buffer.from(frame.pcm).toString('base64'),
      });
      capture.nextSequence += 1;
      capture.samples += frame.pcm.byteLength / 2;
      return this.reply();
    } catch {
      this.failCapture();
      return { kind: 'failed' };
    }
  }

  finishVoiceAudio(captureId: string, lastSequence: number): VoiceReply {
    const capture = this.capture;
    if (
      !capture ||
      capture.id !== captureId ||
      capture.finishing ||
      this.status.state !== VoiceState.FINALIZING ||
      lastSequence !== capture.nextSequence - 1 ||
      !capture.connection
    ) {
      return { kind: 'failed' };
    }
    capture.finishing = true;
    try {
      capture.connection.sendCommand({ kind: 'finish', lastSequence });
      return this.reply();
    } catch {
      this.failCapture();
      return { kind: 'failed' };
    }
  }

  notifyKeysReleased(): void {
    const capture = this.capture;
    if (capture?.finalText !== null && capture?.finalText !== undefined) {
      void this.submitVoiceInstruction(capture, capture.finalText);
    }
  }

  cancelVoiceCapture(): VoiceReply {
    const capture = this.capture;
    if (capture) {
      this.generation += 1;
    }
    this.capture = null;
    this.clearDeadline();
    capture?.connection?.close();
    if (capture) {
      this.dependencies.emit({ kind: 'cancel', captureId: capture.id });
      void this.dependencies.releaseUnusedCredential(capture.id).catch(() => {});
    }
    if (this.status.state !== VoiceState.DISABLED && !this.running) {
      this.setState(VoiceState.IDLE);
    }
    return this.reply();
  }

  private async submitVoiceInstruction(capture: ActiveCapture, rawText: string): Promise<void> {
    if (!this.dependencies.areTriggerKeysReleased()) {
      capture.finalText = rawText;
      capture.connection?.close();
      return;
    }
    // Consume identity synchronously before any await; duplicate final events are stale.
    this.capture = null;
    this.clearDeadline();
    capture.connection?.close();
    const text = rawText.trim();
    const locale = capture.locale;
    const generation = this.generation;
    if (!text || !locale || text.length > 8000 || this.dependencies.isAgentBusy()) {
      this.setState(VoiceState.IDLE);
      if (text) {
        this.dependencies.emit({ kind: 'failed' });
      }
      return;
    }
    this.running += 1;
    this.setState(VoiceState.RUNNING);
    this.dependencies.emit({ kind: 'admitting', captureId: capture.id });
    try {
      const auth = await this.dependencies.readSession();
      if (
        generation !== this.generation ||
        auth.kind !== 'signed-in' ||
        auth.user.id !== capture.userId
      ) {
        return;
      }
      const started = await this.dependencies.startAgentSession();
      if (generation !== this.generation) {
        return;
      }
      if (started.kind !== 'started') {
        this.dependencies.emit({ kind: 'failed' });
        return;
      }
      this.dependencies.emit({
        kind: 'submitted',
        captureId: capture.id,
        sessionId: started.sessionId,
        text,
      });
      const result = await this.dependencies.sendAgentMessage(
        started.sessionId,
        text,
        locale,
        capture.mode,
      );
      if (generation === this.generation) {
        this.dependencies.emit({
          kind: 'result',
          captureId: capture.id,
          sessionId: started.sessionId,
          result,
        });
      }
    } catch {
      if (generation === this.generation) {
        this.dependencies.emit({ kind: 'failed' });
      }
    } finally {
      this.running -= 1;
      if (this.status.state !== VoiceState.DISABLED) {
        this.setState(
          this.running > 0 && !this.lessonAnswerAllowed ? VoiceState.RUNNING : VoiceState.IDLE,
        );
      }
    }
  }

  private failCapture(): void {
    this.cancelVoiceCapture();
    this.dependencies.emit({ kind: 'failed' });
  }

  private setState(state: VoiceStatus['state']): void {
    this.status = { ...this.status, state };
    this.emitStatus();
  }

  private emitStatus(): void {
    this.dependencies.emit({ kind: 'status', status: this.readStatus() });
  }

  private reply(): VoiceReply {
    return { kind: 'ok', status: this.readStatus() };
  }

  private clearDeadline(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
  }

  private setDeadline(milliseconds: number): void {
    this.clearDeadline();
    this.timer = setTimeout(() => {
      this.failCapture();
    }, milliseconds);
    this.timer.unref();
  }
}
