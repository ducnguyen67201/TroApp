export const MicrophoneTestPhase = {
  OPENING: 'opening',
  QUIET: 'quiet',
  SPEAKING: 'speaking',
} as const;

export type MicrophoneTestPhase = (typeof MicrophoneTestPhase)[keyof typeof MicrophoneTestPhase];

export const quietTestSeconds = 2;

export const speechTestSeconds = 4;
