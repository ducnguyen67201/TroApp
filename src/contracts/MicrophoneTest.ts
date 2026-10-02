import { z } from 'zod';

/** Tests grant audio-only access for one bounded local capture, never transcription. */
export const microphoneTestLeaseMs = 20_000;

export const MicrophoneTestCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start'), testId: z.uuid() }),
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
