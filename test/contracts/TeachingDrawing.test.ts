import { expect, it } from 'vitest';
import { TeachingDrawingSchema, TeachingDrawingLimits } from '#contracts/TeachingDrawing.js';

const first = { x: 0, y: 0 };
const second = { x: 1, y: 1 };
const third = { x: 1, y: 0 };

it('accepts boundary points, open curves, closed loops and redundant neighbors', () => {
  expect(
    TeachingDrawingSchema.safeParse({
      strokes: [
        { points: [first, first, second], closed: false },
        { points: [first, second, third, first], closed: true },
        { points: [first, { x: 0.3, y: 0.4 }, second], closed: false },
      ],
    }).success,
  ).toBe(true);
});

it.each(
  [
    [],
    [{ points: [first], closed: false }],
    [{ points: [first, first], closed: false }],
    [{ points: [first, second, first], closed: true }],
    [{ points: [first, { x: 0.5, y: 0.5 }, second], closed: true }],
    [{ points: [first, { x: -0.1, y: 0.1 }], closed: false }],
    [{ points: [first, { x: 0.5, y: 1.1 }], closed: false }],
    [{ points: [first, { x: Number.NaN, y: 0.1 }], closed: false }],
    [{ points: [first, { x: Number.POSITIVE_INFINITY, y: 0.1 }], closed: false }],
    [{ points: [first, second], closed: false, color: 'red' }],
  ].map((strokes) => ({ strokes })),
)('rejects invalid or invisible stroke geometry %#', (drawing) => {
  expect(TeachingDrawingSchema.safeParse(drawing).success).toBe(false);
});

it('bounds both stroke count and point count without discarding excess model input', () => {
  const stroke = { points: [first, second], closed: false };
  expect(
    TeachingDrawingSchema.safeParse({
      strokes: Array.from({ length: TeachingDrawingLimits.MAX_STROKES + 1 }, () => stroke),
    }).success,
  ).toBe(false);
  expect(
    TeachingDrawingSchema.safeParse({
      strokes: [
        {
          points: Array.from(
            { length: TeachingDrawingLimits.MAX_POINTS_PER_STROKE + 1 },
            (_, index) => ({ x: index / 100, y: 0 }),
          ),
          closed: false,
        },
      ],
    }).success,
  ).toBe(false);
  expect(TeachingDrawingSchema.safeParse({ strokes: [stroke], duration_ms: 500 }).success).toBe(
    false,
  );
});
