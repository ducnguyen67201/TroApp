import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { TranscriptionEvent } from '#contracts/Transcription.js';

export interface LiveTranscription {
  appendAudio(pcm: Uint8Array): void;
  finishCapture(): void;
  cancelCapture(): void;
}

export interface LiveTranscriber {
  openTranscription(
    locale: DesktopLocale,
    userId: string,
    emit: (event: TranscriptionEvent) => void,
  ): LiveTranscription;
}
