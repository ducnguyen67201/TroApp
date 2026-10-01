import {
  AudioFormat,
  type TranscriptionCommand,
  TranscriptionEventKind,
  type TranscriptionEvent,
} from '#contracts/Transcription.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { LiveTranscriber, LiveTranscription } from '../ports/LiveTranscriber.js';
import type { TranscriptionAllowance } from '../ports/TranscriptionAllowance.js';

/** Bounds upstream spend, preserves audio order, and settles a lease once.
 * The route attaches listeners before starting this asynchronous admission. */
export class TranscriptionSession {
  private upstream: LiveTranscription | null = null;
  private ready = false;
  private closed = false;
  private claimed = false;
  private finishing = false;
  private nextSequence = 0;
  private samples = 0;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly captureId: string,
    private readonly userId: string,
    private readonly locale: DesktopLocale,
    private readonly allowance: TranscriptionAllowance,
    private readonly provider: LiveTranscriber,
    private readonly emit: (event: TranscriptionEvent) => void,
    private readonly closeSocket: () => void,
  ) {
    this.timer = setTimeout(() => {
      this.failCapture();
    }, 10_000);
    this.timer.unref();
  }

  async openTranscription(): Promise<void> {
    try {
      this.claimed = await this.allowance.claimTranscription(this.captureId, this.userId);
      if (this.isCaptureClosed()) {
        if (this.claimed) {
          await this.allowance.settleTranscription(this.captureId, 0);
        }
        return;
      }
      if (!this.claimed) {
        this.failCapture();
        return;
      }
      this.upstream = this.provider.openTranscription(this.locale, this.userId, (event) => {
        if (this.isCaptureClosed()) {
          return;
        }
        if (event.kind === TranscriptionEventKind.READY) {
          this.ready = true;
          this.setDeadline(65_000);
        }
        if (event.kind === TranscriptionEventKind.FINAL) {
          if (!this.finishing) {
            this.failCapture();
            return;
          }
          this.emit(event);
          this.cancelCapture();
        } else if (event.kind === TranscriptionEventKind.FAILED) {
          this.failCapture();
        } else {
          this.emit(event);
        }
      });
      if (this.isCaptureClosed()) {
        this.upstream.cancelCapture();
      }
    } catch {
      this.failCapture();
    }
  }

  receiveCommand(command: TranscriptionCommand): void {
    if (this.isCaptureClosed()) {
      return;
    }
    try {
      if (!this.ready || !this.upstream || this.finishing) {
        this.failCapture();
        return;
      }
      if (command.kind === 'audio') {
        const pcm = Buffer.from(command.audio, 'base64');
        if (
          command.sequence !== this.nextSequence ||
          pcm.byteLength === 0 ||
          pcm.byteLength > AudioFormat.FRAME_BYTES ||
          pcm.byteLength % 2 !== 0 ||
          this.samples + pcm.byteLength / 2 > AudioFormat.SAMPLE_RATE * AudioFormat.MAX_SECONDS
        ) {
          this.failCapture();
          return;
        }
        this.samples += pcm.byteLength / 2;
        this.nextSequence += 1;
        this.upstream.appendAudio(pcm);
      } else {
        if (command.lastSequence !== this.nextSequence - 1) {
          this.failCapture();
          return;
        }
        this.finishing = true;
        if (this.samples < AudioFormat.SAMPLE_RATE / 10) {
          this.emit({ kind: TranscriptionEventKind.FINAL, text: '' });
          this.cancelCapture();
          return;
        }
        this.setDeadline(15_000);
        this.upstream.finishCapture();
      }
    } catch {
      this.failCapture();
    }
  }

  failCapture(): void {
    if (!this.closed) {
      this.emit({ kind: TranscriptionEventKind.FAILED });
      this.cancelCapture();
    }
  }

  cancelCapture(): void {
    if (this.isCaptureClosed()) {
      return;
    }
    this.closed = true;
    clearTimeout(this.timer);
    this.upstream?.cancelCapture();
    if (this.claimed) {
      // A failed refund retains the conservative reservation; never opens more quota.
      void this.allowance.settleTranscription(this.captureId, this.samples).catch(() => {});
    }
    this.closeSocket();
  }

  private isCaptureClosed(): boolean {
    return this.closed;
  }

  private setDeadline(milliseconds: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.failCapture();
    }, milliseconds);
    this.timer.unref();
  }
}
