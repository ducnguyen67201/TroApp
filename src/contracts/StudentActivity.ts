import { z } from 'zod';
import { DesktopObservationRegionSchema } from './DesktopObservation.js';

export const StudentActivityKind = {
  PRESS: 'press',
  RELEASE: 'release',
  DRAG: 'drag',
  KEY: 'key',
  SCROLL: 'scroll',
} as const;

export const StudentPointSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/** Physical event metadata only. Key contents never cross this boundary. */
export const StudentActivitySchema = z.strictObject({
  kind: z.enum(StudentActivityKind),
  point: StudentPointSchema.nullable(),
  button: z.number().int().min(1).max(5).nullable(),
});

export type StudentActivity = z.infer<typeof StudentActivitySchema>;

export const TeachingInteractionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('click'), target: DesktopObservationRegionSchema }),
  z.strictObject({
    kind: z.literal('drag'),
    source: DesktopObservationRegionSchema,
    destination: DesktopObservationRegionSchema,
  }),
  z.strictObject({ kind: z.literal('type') }),
  z.strictObject({ kind: z.literal('scroll') }),
  z.strictObject({ kind: z.literal('keyboard') }),
]);

export type TeachingInteraction = z.infer<typeof TeachingInteractionSchema>;
