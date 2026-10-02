import { z } from 'zod';
import { DesktopLocaleSchema } from './DesktopLocale.js';

export const CompanionHudPhase = {
  IDLE: 'idle',
  PREPARING: 'preparing',
  LISTENING: 'listening',
  TRANSCRIBING: 'transcribing',
  SENDING: 'sending',
  THINKING: 'thinking',
  SHOWING: 'showing',
  WORKING: 'working',
  DONE: 'done',
  CANCELED: 'canceled',
  ERROR: 'error',
  DAILY_LIMIT: 'daily_limit',
} as const;

export type CompanionHudPhase = (typeof CompanionHudPhase)[keyof typeof CompanionHudPhase];

export const CompanionHudTool = {
  SET_STATE: 'set_companion_hud',
  BIND_CURSOR: 'bind_companion_hud_cursor',
} as const;

/** Presentation contains no audio, transcript, tool arguments, or model credential. */
export const CompanionHudSnapshotSchema = z.strictObject({
  phase: z.enum(CompanionHudPhase),
  locale: DesktopLocaleSchema,
  level: z.number().min(0).max(1),
});

export type CompanionHudSnapshot = z.infer<typeof CompanionHudSnapshotSchema>;

export const VoiceMeterSchema = z.strictObject({
  captureId: z.uuid(),
  sequence: z.number().int().min(0).max(4000),
  level: z.number().min(0).max(1),
});

export type VoiceMeter = z.infer<typeof VoiceMeterSchema>;

export const AgentProgressPhase = {
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
});

export type AgentProgress = z.infer<typeof AgentProgressSchema>;

export const CompanionHudAckSchema = z.strictObject({ applied: z.boolean() });
