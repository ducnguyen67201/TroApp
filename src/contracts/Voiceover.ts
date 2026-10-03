import { z } from 'zod';
import { DesktopLocaleSchema } from './DesktopLocale.js';
import { TeachingMessageSchema } from './TeachingStep.js';

export const VoiceoverLimits = {
  SAMPLE_RATE: 24000,
  CHUNK_BYTES: 12000,
  MAX_BYTES: 3 * 1024 * 1024,
  START_TIMEOUT_MS: 5000,
  STOP_TIMEOUT_MS: 1500,
  MAX_DURATION_MS: 60000,
  QUEUE_SECONDS: 2,
} as const;

export const VoiceoverState = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  SPEAKING: 'speaking',
  UNAVAILABLE: 'unavailable',
} as const;

export const VoiceoverStatusSchema = z.strictObject({
  state: z.enum(VoiceoverState),
});

export type VoiceoverStatus = z.infer<typeof VoiceoverStatusSchema>;

export const VoiceoverRequestSchema = z.strictObject({
  utteranceId: z.uuid(),
  message: TeachingMessageSchema,
  locale: DesktopLocaleSchema,
});

export type VoiceoverRequest = z.infer<typeof VoiceoverRequestSchema>;

export const VoiceoverPlaybackSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start'), utteranceId: z.uuid(), sequence: z.literal(0) }),
  z.strictObject({
    kind: z.literal('chunk'),
    utteranceId: z.uuid(),
    sequence: z.number().int().positive(),
    pcm: z
      .instanceof(Uint8Array)
      .refine(
        (pcm) =>
          pcm.length > 0 && pcm.length <= VoiceoverLimits.CHUNK_BYTES && pcm.length % 2 === 0,
      ),
  }),
  z.strictObject({
    kind: z.literal('end'),
    utteranceId: z.uuid(),
    sequence: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal('stop'), utteranceId: z.uuid(), sequence: z.literal(-1) }),
]);

export type VoiceoverPlayback = z.infer<typeof VoiceoverPlaybackSchema>;

export const VoiceoverAckSchema = z.strictObject({
  utteranceId: z.uuid(),
  sequence: z.number().int().min(-1),
  accepted: z.boolean(),
});

export type VoiceoverAck = z.infer<typeof VoiceoverAckSchema>;

export const VoiceoverPreferenceSchema = z.strictObject({
  enabled: z.boolean(),
  locale: DesktopLocaleSchema,
});
