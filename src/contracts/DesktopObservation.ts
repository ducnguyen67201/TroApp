import { z } from 'zod';

export const DesktopObservationTool = {
  BEGIN: 'begin_desktop_watch',
  READ: 'read_desktop_watch',
  END: 'end_desktop_watch',
} as const;

export type DesktopObservationTool =
  (typeof DesktopObservationTool)[keyof typeof DesktopObservationTool];

/** Host-only metadata. No screenshots, input contents or coordinates cross this port. */
export const DesktopObservationSchema = z.strictObject({
  watch_id: z.uuid(),
  input_only: z.boolean().optional(),
  screen_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  input_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  relevant_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  ready: z.boolean(),
  changed_fraction: z.number().min(0).max(1),
  quiet_ms: z.number().nonnegative(),
  buttons_down: z.boolean(),
  screen_width: z.number().int().positive(),
  screen_height: z.number().int().positive(),
});

export type DesktopObservation = z.infer<typeof DesktopObservationSchema>;

export const DesktopObservationRegionSchema = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((region) => region.x + region.width <= 1 && region.y + region.height <= 1);

export type DesktopObservationRegion = z.infer<typeof DesktopObservationRegionSchema>;

export const TeachingLessonPhase = {
  OBSERVING: 'observing',
  WAITING: 'waiting',
  NEEDS_INPUT: 'needs_input',
  PAUSED: 'paused',
} as const;

export type TeachingLessonPhase = (typeof TeachingLessonPhase)[keyof typeof TeachingLessonPhase];
