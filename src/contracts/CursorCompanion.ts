import { z } from 'zod';
import { TeachingDrawingLimits, TeachingDrawingSchema } from './TeachingDrawing.js';
import { DesktopObservationRegionSchema } from './DesktopObservation.js';

export const AgentTaskMode = { EXECUTE: 'execute', TEACH: 'teach' } as const;

export const AgentTaskModeSchema = z.enum(AgentTaskMode);

export type AgentTaskMode = z.infer<typeof AgentTaskModeSchema>;

export const CursorCompanionTool = {
  PRESENT_GUIDANCE: 'present_teaching_guidance',
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

/** Native evidence identifies visible strokes rather than legacy gestures. */
export const CursorGuidancePresentationReceiptSchema = z
  .strictObject({
    presentation_version: z.literal(3),
    task_epoch: z.uuid(),
    sequence_id: z.uuid(),
    presentation_id: z.uuid(),
    lesson_id: z.uuid(),
    step_id: z.uuid(),
    message_presented: z.literal(true),
    drawing_presented: z.boolean(),
    text_only: z.boolean(),
    interrupted: z.boolean(),
    strokes_presented: z
      .array(
        z.strictObject({
          stroke_index: z
            .number()
            .int()
            .min(0)
            .max(TeachingDrawingLimits.MAX_STROKES - 1),
          trace_progress: z.number().positive().max(1),
          hold_ms_observed: z
            .number()
            .int()
            .nonnegative()
            .max(TeachingDrawingLimits.MAX_DURATION_MS),
        }),
      )
      .max(TeachingDrawingLimits.MAX_STROKES),
  })
  .superRefine((receipt, context) => {
    const indices = receipt.strokes_presented.map((stroke) => stroke.stroke_index);
    if (new Set(indices).size !== indices.length) {
      context.addIssue({
        code: 'custom',
        path: ['strokes_presented'],
        message: 'Stroke indices must be unique.',
      });
    }
    if (receipt.text_only) {
      if (
        receipt.interrupted ||
        receipt.drawing_presented ||
        receipt.strokes_presented.length !== 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['strokes_presented'],
          message: 'Text-only receipts cannot claim a drawing or interrupted success.',
        });
      }
    } else if (!receipt.drawing_presented || receipt.strokes_presented.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['strokes_presented'],
        message: 'A spatial receipt needs a visible stroke.',
      });
    }
    if (
      !receipt.interrupted &&
      receipt.strokes_presented.some(
        (stroke) =>
          stroke.trace_progress !== 1 ||
          stroke.hold_ms_observed < TeachingDrawingLimits.MIN_VISIBLE_HOLD_MS,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['strokes_presented'],
        message: 'Completed strokes need full reveal and the minimum visible hold.',
      });
    }
  });

export type CursorGuidancePresentationReceipt = z.infer<
  typeof CursorGuidancePresentationReceiptSchema
>;

/** The native receipt cannot supply the request's expected stroke count. */
export function hasValidPresentedStrokes(
  receipt: CursorGuidancePresentationReceipt,
  expectedStrokeCount: number,
): boolean {
  if (
    !Number.isInteger(expectedStrokeCount) ||
    expectedStrokeCount < 0 ||
    expectedStrokeCount > TeachingDrawingLimits.MAX_STROKES
  ) {
    return false;
  }
  if (expectedStrokeCount === 0) {
    return (
      receipt.text_only &&
      !receipt.interrupted &&
      !receipt.drawing_presented &&
      receipt.strokes_presented.length === 0
    );
  }
  if (receipt.text_only || !receipt.drawing_presented || receipt.strokes_presented.length === 0) {
    return false;
  }
  const indices = receipt.strokes_presented.map((stroke) => stroke.stroke_index);
  if (
    new Set(indices).size !== indices.length ||
    indices.some((index) => index >= expectedStrokeCount)
  ) {
    return false;
  }
  if (receipt.interrupted) {
    return receipt.strokes_presented.every(
      (stroke) => stroke.trace_progress > 0 && stroke.trace_progress <= 1,
    );
  }
  return (
    receipt.strokes_presented.length === expectedStrokeCount &&
    receipt.strokes_presented.every(
      (stroke) =>
        stroke.trace_progress === 1 &&
        stroke.hold_ms_observed >= TeachingDrawingLimits.MIN_VISIBLE_HOLD_MS,
    )
  );
}

const CoordinateBoundsSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** Bounded native geometry only. Bounds include the visible stroke width. */
export const GuidanceCoordinateTraceSchema = z.strictObject({
  requested_capture_id: z.string().min(1).max(200),
  capture_id: z.string().min(1).max(200),
  screen_size_points: z.tuple([z.number().positive(), z.number().positive()]),
  capture_size_px: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  display_scale: z.number().positive(),
  targets_normalized: z.array(DesktopObservationRegionSchema).max(2),
  planned_strokes: z
    .array(
      z.strictObject({
        stroke_index: z
          .number()
          .int()
          .min(0)
          .max(TeachingDrawingLimits.MAX_STROKES - 1),
        cue_bounds_points: CoordinateBoundsSchema,
      }),
    )
    .max(TeachingDrawingLimits.MAX_STROKES),
  painted_strokes: z
    .array(
      z.strictObject({
        stroke_index: z
          .number()
          .int()
          .min(0)
          .max(TeachingDrawingLimits.MAX_STROKES - 1),
        trace_progress: z.number().min(0).max(1),
        geometry: z.strictObject({
          origin_points: z.tuple([z.number(), z.number()]),
          backing_scale: z.number().positive(),
          raster_size_px: z.tuple([z.number().int().positive(), z.number().int().positive()]),
          cue_bounds_px: CoordinateBoundsSchema,
          stroke_width_px: z.number().positive(),
        }),
      }),
    )
    .max(TeachingDrawingLimits.MAX_STROKES),
});

/** Native compares target boxes and stroke-covered areas locally; never returns pixels. */
export const GuidanceComparisonRegionKind = { TARGET: 'target', STROKE: 'stroke' } as const;

export const GuidanceComparisonDiagnosticsSchema = z.strictObject({
  matched: z.boolean(),
  capture_width_px: z.number().int().positive(),
  capture_height_px: z.number().int().positive(),
  regions: z
    .array(
      z.strictObject({
        region_index: z.number().int().min(0).max(4),
        region_kind: z.enum(GuidanceComparisonRegionKind),
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
    .max(5),
});

/** Monotonic native stage durations only; no timestamps or content-bearing fields. */
export const GuidanceTimingSchema = z.strictObject({
  compile_ms: z.number().int().nonnegative().max(120000),
  refresh_ms: z.number().int().nonnegative().max(120000),
  comparison_ms: z.number().int().nonnegative().max(120000),
  first_frame_ms: z.number().int().nonnegative().max(120000).optional(),
  presentation_ms: z.number().int().nonnegative().max(120000).optional(),
});

export const GuidanceFreshnessReason = {
  TARGET_CHANGED: 'target_changed',
  GEOMETRY_CHANGED: 'geometry_changed',
  CAPTURE_UNAVAILABLE: 'capture_unavailable',
} as const;

export const GuidancePresentationRefusalSchema = z.strictObject({
  status: z.literal('refused'),
  code: z.literal('fresh_observation_required'),
  reason: z.enum(GuidanceFreshnessReason),
  comparison_diagnostics: GuidanceComparisonDiagnosticsSchema.optional(),
  timings_ms: GuidanceTimingSchema.optional(),
});

export const CursorGuidanceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('presented'),
    coordinate_trace: z.unknown().optional(),
    comparison_diagnostics: z.unknown().optional(),
    timings_ms: z.unknown().optional(),
    following: z.boolean(),
    active: z.literal(false),
    receipt: CursorGuidancePresentationReceiptSchema,
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
  presentation_versions: z.tuple([z.literal(3)]),
  task_lifecycle: z.literal(true),
  paired_presentation: z.literal(true),
  display_scope: z.literal('primary'),
  gestures: z.tuple([z.literal('scribble')]),
  max_strokes: z.literal(TeachingDrawingLimits.MAX_STROKES),
  max_points_per_stroke: z.literal(TeachingDrawingLimits.MAX_POINTS_PER_STROKE),
  max_duration_ms: z.literal(TeachingDrawingLimits.MAX_DURATION_MS),
});

/** The trusted worker owns identity; native canonical validation owns the full request. */
export const CursorGuidanceRequestHeaderSchema = z
  .object({
    presentation_version: z.literal(3),
    drawing: TeachingDrawingSchema.nullable(),
    text_only: z.boolean(),
  })
  .refine((request) => request.text_only === (request.drawing === null), {
    message: 'Text-only requests require null drawing; spatial requests require strokes.',
  });

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
  status: z.enum(['state', 'following', 'hidden', 'canceled']),
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
