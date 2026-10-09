import { z } from 'zod';

/** Model point counts and native visibility evidence are bounded by one policy. */
export const TeachingDrawingLimits = {
  MAX_STROKES: 3,
  MAX_POINTS_PER_STROKE: 32,
  MIN_VISIBLE_HOLD_MS: 1100,
  MAX_DURATION_MS: 15000,
} as const;

export const TeachingDrawingPointSchema = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export type TeachingDrawingPoint = z.infer<typeof TeachingDrawingPointSchema>;

function hasSamePosition(first: TeachingDrawingPoint, second: TeachingDrawingPoint): boolean {
  return first.x === second.x && first.y === second.y;
}

function hasNoncollinearPoints(points: TeachingDrawingPoint[]): boolean {
  const first = points[0];
  if (!first) {
    return false;
  }
  const second = points.find((point) => !hasSamePosition(first, point));
  if (!second) {
    return false;
  }
  return points.some(
    (point) =>
      (second.x - first.x) * (point.y - first.y) !== (second.y - first.y) * (point.x - first.x),
  );
}

/** Coordinates refer to the bound screenshot, with its origin at the top left.
 * Repeated points are allowed only when the remaining path has real geometry;
 * native compilation removes redundant neighbors without moving the target. */
export const TeachingDrawingStrokeSchema = z
  .strictObject({
    points: z
      .array(TeachingDrawingPointSchema)
      .min(2)
      .max(TeachingDrawingLimits.MAX_POINTS_PER_STROKE),
    closed: z.boolean(),
  })
  .superRefine((stroke, context) => {
    const distinctPoints = stroke.points.filter(
      (point, index, points) =>
        !points.slice(0, index).some((previous) => hasSamePosition(previous, point)),
    );
    if (distinctPoints.length < (stroke.closed ? 3 : 2)) {
      context.addIssue({
        code: 'custom',
        path: ['points'],
        message: stroke.closed
          ? 'A closed stroke needs at least three distinct points.'
          : 'An open stroke needs at least two distinct points.',
      });
    } else if (stroke.closed && !hasNoncollinearPoints(distinctPoints)) {
      context.addIssue({
        code: 'custom',
        path: ['points'],
        message: 'A closed stroke needs noncollinear points.',
      });
    }
  });

export type TeachingDrawingStroke = z.infer<typeof TeachingDrawingStrokeSchema>;

export const TeachingDrawingSchema = z.strictObject({
  strokes: z.array(TeachingDrawingStrokeSchema).min(1).max(TeachingDrawingLimits.MAX_STROKES),
});

export type TeachingDrawing = z.infer<typeof TeachingDrawingSchema>;
