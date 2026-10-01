import { z } from 'zod';

export const AgentTaskMode = { EXECUTE: 'execute', TEACH: 'teach' } as const;

export const AgentTaskModeSchema = z.enum(AgentTaskMode);

export type AgentTaskMode = z.infer<typeof AgentTaskModeSchema>;

export const CursorCompanionTool = {
  SHOW_SEQUENCE: 'show_cursor_sequence',
  SET_MODE: 'set_cursor_companion_mode',
  CANCEL_SEQUENCE: 'cancel_cursor_sequence',
  READ_STATE: 'get_cursor_companion_state',
  READ_CAPABILITIES: 'get_cursor_companion_capabilities',
  BEGIN_TASK: 'begin_cursor_guidance_task',
  END_TASK: 'end_cursor_guidance_task',
} as const;

export const TeachingOutcome = {
  DEMONSTRATED: 'demonstrated',
  EXPLAINED: 'explained',
  NEEDS_INPUT: 'needs_input',
  CANCELED: 'canceled',
  FAILED: 'failed',
} as const;

export const TeachingOutcomeSchema = z.enum(TeachingOutcome);

export type TeachingOutcome = z.infer<typeof TeachingOutcomeSchema>;

export const GuidanceReason = {
  USER_TAKEOVER: 'user_takeover',
  EXPLICIT_STOP: 'explicit_stop',
  SESSION_LOST: 'session_lost',
  LEASE_EXPIRED: 'lease_expired',
  TARGET_INVALIDATED: 'target_invalidated',
  INVALID_REQUEST: 'invalid_request',
  UNSUPPORTED_VERSION: 'unsupported_version',
  BUSY: 'busy',
  RENDER_TIMEOUT: 'render_timeout',
  TRANSPORT_FAILED: 'transport_failed',
  NO_DEMONSTRATION: 'no_demonstration',
} as const;

export const GuidanceReasonSchema = z.enum(GuidanceReason);

export type GuidanceReason = z.infer<typeof GuidanceReasonSchema>;

/** These validators cover native boundary results, never animation geometry. */
export const CursorGuidanceReceiptSchema = z.strictObject({
  presentation_version: z.literal(2),
  task_epoch: z.uuid(),
  sequence_id: z.uuid(),
  completed_steps: z.number().int().min(1).max(8),
});

export const CursorGuidanceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    following: z.boolean(),
    active: z.literal(false),
    receipt: CursorGuidanceReceiptSchema,
  }),
  z.strictObject({
    status: z.literal('canceled'),
    following: z.boolean(),
    active: z.literal(false),
    task_epoch: z.uuid(),
    sequence_id: z.uuid().nullable(),
    reason: GuidanceReasonSchema,
  }),
  z.strictObject({
    status: z.literal('failed'),
    following: z.boolean(),
    active: z.boolean(),
    task_epoch: z.uuid(),
    sequence_id: z.uuid().nullable(),
    code: GuidanceReasonSchema,
  }),
]);

export type CursorGuidanceResult = z.infer<typeof CursorGuidanceResultSchema>;

export const CursorGuidanceTaskSchema = z.strictObject({
  status: z.enum(['task_ready', 'task_ended']),
  task_epoch: z.uuid(),
  following: z.boolean(),
  active: z.literal(false),
});

export const CursorCompanionCapabilitiesSchema = z.strictObject({
  presentation_versions: z.array(z.number().int()).min(1).max(2),
  task_lifecycle: z.boolean(),
  display_scope: z.literal('primary'),
  gestures: z.array(z.enum(['circle', 'arrow', 'move', 'drag', 'selection', 'click'])).max(6),
  max_steps: z.literal(8),
  max_duration_ms: z.literal(15000),
});

/** Validate only the dispatch envelope; Cua's canonical schema owns each step. */
export const CursorGuidanceRequestHeaderSchema = z.object({
  presentation_version: z.literal(2),
  steps: z.array(z.unknown()).min(1).max(8),
});

export const TeachingResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal(TeachingOutcome.DEMONSTRATED), answer: z.string() }),
  z.strictObject({ outcome: z.literal(TeachingOutcome.EXPLAINED), answer: z.string() }),
  z.strictObject({
    outcome: z.literal(TeachingOutcome.NEEDS_INPUT),
    reason: z.literal(GuidanceReason.NO_DEMONSTRATION),
  }),
  z.strictObject({ outcome: z.literal(TeachingOutcome.CANCELED), reason: GuidanceReasonSchema }),
  z.strictObject({ outcome: z.literal(TeachingOutcome.FAILED), reason: GuidanceReasonSchema }),
]);

export type TeachingResult = z.infer<typeof TeachingResultSchema>;

/** Cua owns this protocol; Tro validates host responses without rendering it. */
export const CursorCompanionStateSchema = z.strictObject({
  status: z.enum(['state', 'following', 'hidden', 'canceled', 'completed']),
  following: z.boolean(),
  active: z.boolean(),
});
