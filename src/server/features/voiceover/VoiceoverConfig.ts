import { DesktopLocale } from '#contracts/DesktopLocale.js';

/** Backend-owned speech settings. OpenAI PCM matches the desktop's 24 kHz mono player.
 * Credentials stay on the backend; live pronunciation still needs acceptance. */
export const VoiceoverConfig = {
  MODEL_ID: 'gpt-4o-mini-tts',
  VOICES: {
    [DesktopLocale.VIETNAMESE]: 'marin',
    [DesktopLocale.ENGLISH]: 'marin',
  } satisfies Record<DesktopLocale, string>,
  INSTRUCTIONS: {
    [DesktopLocale.VIETNAMESE]:
      'Read the provided text clearly in Vietnamese. Preserve the wording without translating or adding commentary.',
    [DesktopLocale.ENGLISH]:
      'Read the provided text clearly in English. Preserve the wording without translating or adding commentary.',
  } satisfies Record<DesktopLocale, string>,
} as const;
