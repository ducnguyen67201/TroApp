import type { VoiceoverRequest } from '#contracts/Voiceover.js';

export interface SpeechProvider {
  isAvailable(): boolean;
  streamSpeech(request: VoiceoverRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** Reservations are charged before dispatch and retained conservatively on failure. */
export interface VoiceoverAllowance {
  reserveVoiceover(userId: string, utteranceId: string, characters: number): Promise<boolean>;
  finishVoiceover(userId: string, utteranceId: string): Promise<void>;
}
