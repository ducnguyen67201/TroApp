export const VoiceoverStopReason = {
  INTERRUPTED: 'interrupted',
  MESSAGE_REPLACED: 'message_replaced',
  MESSAGE_HIDDEN: 'message_hidden',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type VoiceoverStopReason = (typeof VoiceoverStopReason)[keyof typeof VoiceoverStopReason];

export const VoiceoverDiagnosticStage = {
  ADMISSION: 'admission',
  WAITING_FOR_STOP: 'waiting_for_stop',
  STARTING_PLAYBACK: 'starting_playback',
  REQUESTING_SPEECH: 'requesting_speech',
  WAITING_FOR_AUDIO: 'waiting_for_audio',
  PLAYING_AUDIO: 'playing_audio',
  DRAINING_AUDIO: 'draining_audio',
} as const;

export type VoiceoverDiagnosticStage =
  (typeof VoiceoverDiagnosticStage)[keyof typeof VoiceoverDiagnosticStage];

export const VoiceoverDiagnosticKind = {
  STAGE: 'stage',
  DEFERRED: 'deferred',
  TIMEOUT: 'timeout',
  FAILED: 'failed',
  STOPPED: 'stopped',
} as const;

export const VoiceoverDiagnosticReason = {
  MICROPHONE_BUSY: 'microphone_busy',
  PLAYBACK_START_TIMEOUT: 'playback_start_timeout',
  FIRST_AUDIO_TIMEOUT: 'first_audio_timeout',
  DURATION_TIMEOUT: 'duration_timeout',
  OPERATION_FAILED: 'operation_failed',
} as const;

/** Bounded metadata only: never include instruction text, audio or raw errors.
 * elapsedMs measures time since narration admission, including playback setup.
 * A playback acknowledgment does not prove audible hardware output. */
export interface VoiceoverDiagnostic {
  kind: (typeof VoiceoverDiagnosticKind)[keyof typeof VoiceoverDiagnosticKind];
  stage: VoiceoverDiagnosticStage;
  utteranceId: string | null;
  messageSequence: number;
  elapsedMs: number;
  reason?:
    | (typeof VoiceoverDiagnosticReason)[keyof typeof VoiceoverDiagnosticReason]
    | VoiceoverStopReason;
}
