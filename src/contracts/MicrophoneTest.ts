import { z } from 'zod';

export const MicrophoneCaptureMode = {
  TEST: 'test',
  PREVIEW: 'preview',
} as const;

export type MicrophoneCaptureMode =
  (typeof MicrophoneCaptureMode)[keyof typeof MicrophoneCaptureMode];

/** Local captures grant expiring audio-only access, never transcription. */
export const microphoneTestLeaseMs = 20_000;

export const microphonePreviewRenewalMs = 5_000;

export const MicrophoneTestCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('start'),
    testId: z.uuid(),
    mode: z.enum(MicrophoneCaptureMode).optional(),
  }),
  z.strictObject({ kind: z.literal('renew'), testId: z.uuid() }),
  z.strictObject({ kind: z.literal('stop'), testId: z.uuid() }),
]);

export type MicrophoneTestCommand = z.infer<typeof MicrophoneTestCommandSchema>;

export const MicrophoneTestReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok') }),
  z.strictObject({ kind: z.literal('failed') }),
]);

export type MicrophoneTestReply = z.infer<typeof MicrophoneTestReplySchema>;

export const MicrophoneTestEventSchema = z.strictObject({
  kind: z.literal('canceled'),
  testId: z.uuid(),
});

export type MicrophoneTestEvent = z.infer<typeof MicrophoneTestEventSchema>;
