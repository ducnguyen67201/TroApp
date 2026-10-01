import { z } from 'zod';
import { AgentResultSchema } from './AgentSession.js';
import { DesktopLocaleSchema } from './DesktopLocale.js';
import { AgentTaskMode, AgentTaskModeSchema } from './CursorCompanion.js';

export const VoiceState = {
  DISABLED: 'disabled',
  IDLE: 'idle',
  PREPARING: 'preparing',
  RECORDING: 'recording',
  FINALIZING: 'finalizing',
  RUNNING: 'running',
} as const;

export const VoiceShortcut = {
  COMMAND_CONTROL: 'command-control',
  CONTROL_ALT: 'control-alt',
  CONTROL_SHIFT: 'control-shift',
} as const;

export type VoiceShortcut = (typeof VoiceShortcut)[keyof typeof VoiceShortcut];

export const VoiceStatusSchema = z.strictObject({
  state: z.enum(VoiceState),
  shortcut: z.enum(VoiceShortcut),
  globalShortcutAvailable: z.boolean(),
});

export type VoiceStatus = z.infer<typeof VoiceStatusSchema>;

export const VoiceCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({ kind: z.literal('enable'), shortcut: z.enum(VoiceShortcut) }),
  z.strictObject({ kind: z.literal('disable') }),
  z.strictObject({ kind: z.literal('press') }),
  z.strictObject({ kind: z.literal('release') }),
  z.strictObject({ kind: z.literal('cancel') }),
  z.strictObject({
    kind: z.literal('prepare'),
    captureId: z.uuid(),
    locale: DesktopLocaleSchema,
    mode: AgentTaskModeSchema.default(AgentTaskMode.EXECUTE),
  }),
  z.strictObject({
    kind: z.literal('finish'),
    captureId: z.uuid(),
    lastSequence: z.number().int().min(-1).max(4000),
  }),
]);

export type VoiceCommand = z.infer<typeof VoiceCommandSchema>;

export const VoiceReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ok'), status: VoiceStatusSchema }),
  z.strictObject({ kind: z.literal('failed') }),
]);

export type VoiceReply = z.infer<typeof VoiceReplySchema>;

/** PCM16 little endian, mono, 24 kHz. Tail frames may be shorter than 20 ms. */
export const VoiceAudioFrameSchema = z.strictObject({
  captureId: z.uuid(),
  sequence: z.number().int().min(0).max(4000),
  pcm: z
    .instanceof(Uint8Array)
    .refine(
      (bytes) => bytes.byteLength > 0 && bytes.byteLength <= 960 && bytes.byteLength % 2 === 0,
    ),
});

export type VoiceAudioFrame = z.infer<typeof VoiceAudioFrameSchema>;

export const VoiceEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status'), status: VoiceStatusSchema }),
  z.strictObject({ kind: z.literal('prepare'), captureId: z.uuid() }),
  z.strictObject({ kind: z.literal('record'), captureId: z.uuid() }),
  z.strictObject({ kind: z.literal('release'), captureId: z.uuid() }),
  z.strictObject({ kind: z.literal('cancel'), captureId: z.uuid() }),
  z.strictObject({ kind: z.literal('preview'), captureId: z.uuid(), text: z.string().max(8000) }),
  z.strictObject({
    kind: z.literal('submitted'),
    captureId: z.uuid(),
    sessionId: z.uuid(),
    text: z.string().trim().min(1).max(8000),
  }),
  z.strictObject({
    kind: z.literal('result'),
    captureId: z.uuid(),
    sessionId: z.uuid(),
    result: AgentResultSchema,
  }),
  z.strictObject({ kind: z.literal('failed') }),
]);

export type VoiceEvent = z.infer<typeof VoiceEventSchema>;
