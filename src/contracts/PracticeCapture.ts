import { z } from 'zod';
import { PracticeEvidenceSchema, PracticeFailure } from './PracticeCheck.js';

export const PracticeCaptureLimits = {
  DRAFT_MS: 120000,
  WINDOWS: 100,
  WIDTH: 1920,
  HEIGHT: 1080,
} as const;

export const PracticeCaptureCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('capture'), windowId: z.uuid().optional() }),
  z.strictObject({ kind: z.literal('read'), captureId: z.uuid() }),
  z.strictObject({ kind: z.literal('discard') }),
]);

export const PracticeCaptureReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('windows'),
    windows: z.array(z.strictObject({ id: z.uuid(), name: z.string().max(200) })).max(100),
  }),
  z.strictObject({ kind: z.literal('captured'), evidence: PracticeEvidenceSchema }),
  z.strictObject({ kind: z.literal('discarded') }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(PracticeFailure) }),
]);

export type PracticeCaptureCommand = z.infer<typeof PracticeCaptureCommandSchema>;

export type PracticeCaptureReply = z.infer<typeof PracticeCaptureReplySchema>;
