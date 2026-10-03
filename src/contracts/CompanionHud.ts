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
  locale: DesktopLocaleSchema.optional(),
});

export type AgentProgress = z.infer<typeof AgentProgressSchema>;

export const CompanionHudAckSchema = z.strictObject({ applied: z.boolean() });
