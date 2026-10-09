import { z } from 'zod';
import { DesktopLocaleSchema } from './DesktopLocale.js';
import { TeachingMessageSchema } from './TeachingStep.js';

export const CompanionHudPhase = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  LISTENING: 'listening',
  TRANSCRIBING: 'transcribing',
  SENDING: 'sending',
  THINKING: 'thinking',
  CHECKING: 'checking',
  SUBMITTING: 'submitting',
  CHECKED: 'checked',
  SUBMITTED: 'submitted',
  SHOWING: 'showing',
  WAITING: 'waiting',
  WORKING: 'working',
  DONE: 'done',
  CANCELED: 'canceled',
  ERROR: 'error',
  DAILY_LIMIT: 'daily_limit',
  NEEDS_INPUT: 'needs_input',
} as const;

export type CompanionHudPhase = (typeof CompanionHudPhase)[keyof typeof CompanionHudPhase];

export const CompanionHudTool = {
  SET_STATE: 'set_companion_hud',
  BIND_CURSOR: 'bind_companion_hud_cursor',
  READ_MESSAGE: 'read_companion_hud_message',
  SEND_COMMAND: 'send_companion_hud_command',
} as const;

/** Presentation carries bounded teaching text, but no audio, tool arguments, or model credential. */
export const CompanionHudSnapshotSchema = z.strictObject({
  phase: z.enum(CompanionHudPhase),
  locale: DesktopLocaleSchema,
  level: z.number().min(0).max(1),
  message: TeachingMessageSchema.nullable().optional(),
  speakingSequence: z.number().int().nonnegative().nullable().optional(),
});

export type CompanionHudSnapshot = z.infer<typeof CompanionHudSnapshotSchema>;

export const VoiceMeterSchema = z.strictObject({
  captureId: z.uuid(),
  sequence: z.number().int().min(0).max(4000),
  level: z.number().min(0).max(1),
});

export type VoiceMeter = z.infer<typeof VoiceMeterSchema>;

export const AgentProgressPhase = {
  WAITING: 'waiting',
  NEEDS_INPUT: 'needs_input',
  PAUSED: 'paused',
  THINKING: 'thinking',
  SHOWING: 'showing',
  WORKING: 'working',
} as const;

export type AgentProgressPhase = (typeof AgentProgressPhase)[keyof typeof AgentProgressPhase];

export const AgentProgressSchema = z.strictObject({
  kind: z.literal('progress'),
  requestId: z.uuid(),
  sessionId: z.uuid(),
  phase: z.enum(AgentProgressPhase),
  teachingStep: z.string().trim().min(1).max(4000).optional(),
  lessonId: z.uuid().optional(),
  teachingMessage: TeachingMessageSchema.optional(),
  presentationPending: z.boolean().optional(),
  presentationRevoked: z.boolean().optional(),
  canAcceptAnswer: z.boolean().optional(),
  locale: DesktopLocaleSchema.optional(),
});

export type AgentProgress = z.infer<typeof AgentProgressSchema>;

/** Native ownership identity, checked again while installing the actual frame. */
export const CompanionRenderTokenSchema = z.strictObject({
  ownerEpoch: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  renderId: z.uuid(),
});

export type CompanionRenderToken = z.infer<typeof CompanionRenderTokenSchema>;

export const CompanionHudCommandKind = {
  RENEW_LEASE: 'renew_lease',
  UPDATE_APPEARANCE: 'update_appearance',
  PRESENT_MESSAGE: 'present_message',
  CLEAR_MESSAGE: 'clear_message',
} as const;

const ownerCommandFields = {
  group: z.uuid(),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};

/** Renewals and appearance updates cannot carry or clear a teaching message. */
export const CompanionHudCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(CompanionHudCommandKind.RENEW_LEASE),
    ...ownerCommandFields,
  }),
  z.strictObject({
    kind: z.literal(CompanionHudCommandKind.UPDATE_APPEARANCE),
    ...ownerCommandFields,
    phase: z.enum(CompanionHudPhase),
    locale: DesktopLocaleSchema,
    level: z.number().min(0).max(1),
    speakingSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
  z.strictObject({
    kind: z.literal(CompanionHudCommandKind.PRESENT_MESSAGE),
    ...ownerCommandFields,
    locale: DesktopLocaleSchema,
    message: TeachingMessageSchema,
  }),
  z.strictObject({
    kind: z.literal(CompanionHudCommandKind.CLEAR_MESSAGE),
    ...ownerCommandFields,
    expectedToken: CompanionRenderTokenSchema,
  }),
]);

export type CompanionHudCommand = z.infer<typeof CompanionHudCommandSchema>;

export const CompanionHudBindingSchema = z.strictObject({
  group: z.uuid(),
  lessonId: z.uuid().optional(),
});

export const CompanionHudAckSchema = z.strictObject({
  applied: z.boolean(),
  renderToken: CompanionRenderTokenSchema.optional(),
});

export type CompanionHudAck = z.infer<typeof CompanionHudAckSchema>;
