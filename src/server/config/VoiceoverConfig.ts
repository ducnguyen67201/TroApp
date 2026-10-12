import { z } from 'zod';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

const VoiceoverAllowanceSchema = z.strictObject({
  dailyCharacters: z.number().int().positive().max(1_000_000),
  globalDailyCharacters: z.number().int().positive().max(100_000_000),
  globalStreams: z.number().int().positive().max(1000),
});

/** Backend-owned speech settings. OpenAI PCM matches the desktop's 24 kHz mono player.
 * Credentials stay on the backend; live pronunciation still needs acceptance. */
export const VoiceoverConfig = {
  MODEL_ID: 'gpt-4o-mini-tts',
  ALLOWANCE: {
    dailyCharacters: 30_000,
    globalDailyCharacters: 1_000_000,
    globalStreams: 20,
  } satisfies z.input<typeof VoiceoverAllowanceSchema>,
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

export type VoiceoverAllowanceSettings = z.output<typeof VoiceoverAllowanceSchema>;

/** Validate allowance settings before opening persistence or provider resources. */
export function readVoiceoverAllowanceConfig(
  configuration: VoiceoverAllowanceSettings = VoiceoverConfig.ALLOWANCE,
): VoiceoverAllowanceSettings {
  const parsed = VoiceoverAllowanceSchema.safeParse(configuration);
  if (!parsed.success) {
    throw new Error('Voiceover allowance configuration is invalid.');
  }
  return parsed.data;
}
