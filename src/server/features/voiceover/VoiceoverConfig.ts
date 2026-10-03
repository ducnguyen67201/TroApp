import { DesktopLocale } from '#contracts/DesktopLocale.js';

/** Backend-owned voices selected by the app's canonical locale constants.
 * Both entries initially use George from https://elevenlabs.io/docs/eleven-api/quickstart.
 * Each language can select its own public voice ID here; credentials stay in Doppler.
 * Account access and English/Vietnamese pronunciation still need live acceptance. */
export const VoiceoverConfig = {
  VOICE_IDS: {
    [DesktopLocale.VIETNAMESE]: 'JBFqnCBsd6RMkjVDRZzb',
    [DesktopLocale.ENGLISH]: 'JBFqnCBsd6RMkjVDRZzb',
  } satisfies Record<DesktopLocale, string>,
} as const;
