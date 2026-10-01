import { TranscriptionDelay } from '#contracts/Transcription.js';

/** Backend-owned voice defaults. Keep product choices in code; credentials
 * and deployment-specific settings remain in the validated environment. */
export const TranscriptionConfig = {
  DAILY_AUDIO_SECONDS: 3600,
  RECOGNITION_DELAY: TranscriptionDelay.LOW,
} as const;
