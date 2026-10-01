import { z } from 'zod';
import { DesktopLocaleSchema } from './DesktopLocale.js';

export const TranscriptionDelay = {
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  XHIGH: 'xhigh',
} as const;

export type TranscriptionDelay = (typeof TranscriptionDelay)[keyof typeof TranscriptionDelay];

export const TranscriptionDelaySchema = z.enum(TranscriptionDelay);

export const AudioFormat = {
  SAMPLE_RATE: 24000,
  FRAME_BYTES: 960,
  MAX_SECONDS: 60,
  QUEUE_BYTES: 48000,
} as const;

export const TranscriptionRequestSchema = z.strictObject({
  captureId: z.uuid(),
  locale: DesktopLocaleSchema,
});

export const TranscriptionCancelSchema = z.strictObject({ captureId: z.uuid() });

export const TranscriptionCredentialSchema = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

export type TranscriptionCredential = z.infer<typeof TranscriptionCredentialSchema>;

export const TranscriptionCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('audio'),
    sequence: z.number().int().min(0).max(4000),
    audio: z
      .string()
      .min(4)
      .max(1280)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.strictObject({ kind: z.literal('finish'), lastSequence: z.number().int().min(-1).max(4000) }),
]);

export type TranscriptionCommand = z.infer<typeof TranscriptionCommandSchema>;

export const TranscriptionEventKind = {
  READY: 'ready',
  PREVIEW: 'preview',
  FINAL: 'final',
  FAILED: 'failed',
} as const;

export type TranscriptionEventKind =
  (typeof TranscriptionEventKind)[keyof typeof TranscriptionEventKind];

export const TranscriptionEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(TranscriptionEventKind.READY) }),
  z.strictObject({ kind: z.literal(TranscriptionEventKind.PREVIEW), text: z.string().max(8000) }),
  z.strictObject({ kind: z.literal(TranscriptionEventKind.FINAL), text: z.string().max(8000) }),
  z.strictObject({ kind: z.literal(TranscriptionEventKind.FAILED) }),
]);

export type TranscriptionEvent = z.infer<typeof TranscriptionEventSchema>;
