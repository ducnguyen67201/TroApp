import { z } from 'zod';

export const AgentTaskMode = { EXECUTE: 'execute', TEACH: 'teach' } as const;

export const AgentTaskModeSchema = z.enum(AgentTaskMode);

export type AgentTaskMode = z.infer<typeof AgentTaskModeSchema>;

export const CursorCompanionTool = {
  SHOW_SEQUENCE: 'show_cursor_sequence',
  REFRESH_CAPTURE: 'refresh_cursor_guidance_capture',
  SET_MODE: 'set_cursor_companion_mode',
  CANCEL_SEQUENCE: 'cancel_cursor_sequence',
  READ_STATE: 'get_cursor_companion_state',
  READ_CAPABILITIES: 'get_cursor_companion_capabilities',
  BEGIN_TASK: 'begin_cursor_guidance_task',
  END_TASK: 'end_cursor_guidance_task',
} as const;

export const TeachingOutcome = {
  GOAL_REACHED: 'goal_reached',
  DEMONSTRATED: 'demonstrated',
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
    status: z.literal('presented'),
    following: z.boolean(),
    active: z.literal(false),
    receipt: z
      .strictObject({
        presentation_version: z.literal(2),
        task_epoch: z.uuid(),
        sequence_id: z.uuid(),
        presentation_id: z.uuid(),
        lesson_id: z.uuid(),
        step_id: z.uuid(),
        message_presented: z.literal(true),
        drawing_presented: z.boolean(),
        text_only: z.boolean(),
        interrupted: z.boolean(),
      })
      .refine((receipt) => receipt.text_only || receipt.drawing_presented),
  }),
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
  paired_presentation: z.boolean().optional(),
  display_scope: z.literal('primary'),
  gestures: z.array(z.enum(['circle', 'arrow', 'move', 'drag', 'selection', 'click'])).max(6),
  max_steps: z.literal(8),
  max_duration_ms: z.literal(15000),
});

/** Validate only the dispatch envelope; Cua's canonical schema owns each step. */
export const CursorGuidanceRequestHeaderSchema = z
  .object({
    presentation_version: z.literal(2),
    steps: z.array(z.unknown()).max(8),
    text_only: z.boolean().optional(),
  })
  .refine((request) => request.steps.length > 0 || request.text_only === true);

export const TeachingResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal(TeachingOutcome.GOAL_REACHED),
    answer: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({ outcome: z.literal(TeachingOutcome.DEMONSTRATED), answer: z.string() }),
  z.strictObject({
    outcome: z.literal(TeachingOutcome.NEEDS_INPUT),
    reason: z.literal(GuidanceReason.NO_DEMONSTRATION),
    answer: z.string().trim().min(1).optional(),
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
  guidance: z
    .strictObject({
      task_epoch: z.uuid(),
      reason: GuidanceReasonSchema.nullable(),
      input_revision: z.number().int().nonnegative(),
    })
    .optional(),
});

/** Native compares the complete cue area locally; screenshots never enter this result. */
const GuidanceComparisonDiagnosticsSchema = z.strictObject({
  matched: z.boolean(),
  capture_width_px: z.number().int().positive(),
  capture_height_px: z.number().int().positive(),
  regions: z
    .array(
      z.strictObject({
        step_index: z.number().int().min(0).max(7),
        step_kind: z.enum(['circle', 'click', 'arrow', 'move', 'drag', 'selection']),
        bounds_px: z.tuple([
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
        ]),
        compared_pixels: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        changed_pixels: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        changed_fraction: z.number().min(0).max(1),
        max_channel_delta: z.number().int().min(0).max(255),
        first_changed_pixel: z
          .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
          .nullable(),
      }),
    )
    .max(8),
});

export const GuidanceCaptureRefreshSchema = z.discriminatedUnion('matched', [
  z.strictObject({
    matched: z.literal(true),
    capture_id: z.string().min(1),
    reason: z.literal('target_unchanged'),
    diagnostics: GuidanceComparisonDiagnosticsSchema.optional(),
  }),
  z.strictObject({
    matched: z.literal(false),
    capture_id: z.null(),
    reason: z.enum(['target_changed', 'geometry_changed', 'capture_unavailable']),
    diagnostics: GuidanceComparisonDiagnosticsSchema.optional(),
  }),
]);
