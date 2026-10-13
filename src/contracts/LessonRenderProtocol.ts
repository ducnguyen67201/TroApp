import { z } from 'zod';
import { LessonLimits, LessonScreenSchema } from './LessonVideos.js';

export const lessonRenderVersion = 1;

/** Capability negotiation keeps baseline rendering compatible with older workers. */
export const lessonVisualRuntimeVersion = 'quickjs-svg-v1';

export const LessonVisualRenderLimits = {
  SOURCE_CHARACTERS: 24000,
  OUTPUT_BYTES: 8 * 1024 * 1024,
  FRAME_CHARACTERS: 24000,
  FRAME_NODES: 160,
  TREE_DEPTH: 12,
  DURATION_SECONDS: 90,
  MEMORY_BYTES: 16 * 1024 * 1024,
  WASM_MEMORY_BYTES: 32 * 1024 * 1024,
  STACK_BYTES: 512 * 1024,
  EXECUTION_MS: 15000,
  DIAGNOSTIC_CHARACTERS: 1200,
  WIDTH: 1176,
  HEIGHT: 390,
} as const;

export const LessonRenderVisualSchema = z.strictObject({
  source: z.string().min(1).max(LessonVisualRenderLimits.SOURCE_CHARACTERS),
  runtimeVersion: z.literal(lessonVisualRuntimeVersion),
});

export type LessonRenderVisual = z.infer<typeof LessonRenderVisualSchema>;

export const LessonVisualRenderFailure = {
  COMPILE: 'compile',
  EXECUTION: 'execution',
  LIMIT: 'limit',
  OUTPUT: 'output',
} as const;

export const LessonRenderFailureSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('code-error'),
    code: z.enum(LessonVisualRenderFailure),
    diagnostic: z.string().min(1).max(LessonVisualRenderLimits.DIAGNOSTIC_CHARACTERS),
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    code: z.enum(['render-failed', 'busy', 'incompatible']),
  }),
]);

export type LessonRenderFailure = z.infer<typeof LessonRenderFailureSchema>;

/** Only validated inert SVG data crosses from the interpreter into Chromium. */
export const LessonVisualTag = {
  SVG: 'svg',
  GROUP: 'g',
  PATH: 'path',
  RECTANGLE: 'rect',
  CIRCLE: 'circle',
  ELLIPSE: 'ellipse',
  LINE: 'line',
  POLYLINE: 'polyline',
  POLYGON: 'polygon',
  TEXT: 'text',
  TEXT_SPAN: 'tspan',
} as const;

const coordinate = z.number().min(-10000).max(10000);
const color = z
  .string()
  .max(100)
  .regex(
    /^(?:#[\da-fA-F]{3,8}|none|transparent|currentColor|white|black|red|green|blue|orange|yellow|gray|grey|purple|rgba?\([\d.,\s%]+\))$/,
  );
const geometry = z
  .string()
  .max(8000)
  .regex(/^[MmZzLlHhVvCcSsQqTtAa\d.,\s+\-eE]*$/);
const transform = z
  .string()
  .max(1000)
  .regex(/^(?:(?:translate|rotate|scale|matrix|skewX|skewY)\([\d.,\s+\-eE]+\)\s*)*$/);

export const LessonVisualAttributesSchema = z.strictObject({
  x: coordinate.optional(),
  y: coordinate.optional(),
  x1: coordinate.optional(),
  y1: coordinate.optional(),
  x2: coordinate.optional(),
  y2: coordinate.optional(),
  cx: coordinate.optional(),
  cy: coordinate.optional(),
  r: coordinate.optional(),
  rx: coordinate.optional(),
  ry: coordinate.optional(),
  width: coordinate.optional(),
  height: coordinate.optional(),
  opacity: z.number().min(0).max(1).optional(),
  fill: color.optional(),
  stroke: color.optional(),
  strokeWidth: coordinate.optional(),
  strokeLinecap: z.enum(['butt', 'round', 'square']).optional(),
  strokeLinejoin: z.enum(['miter', 'round', 'bevel']).optional(),
  strokeDasharray: z
    .string()
    .max(100)
    .regex(/^[\d.,\s]+$/)
    .optional(),
  strokeDashoffset: coordinate.optional(),
  d: geometry.optional(),
  points: geometry.optional(),
  transform: transform.optional(),
  viewBox: z
    .string()
    .max(100)
    .regex(/^[\d.,\s+-]+$/)
    .optional(),
  fontSize: z.number().min(1).max(160).optional(),
  fontWeight: z.union([z.number().int().min(100).max(900), z.enum(['normal', 'bold'])]).optional(),
  fontFamily: z.enum(['Noto Sans', 'sans-serif']).optional(),
  textAnchor: z.enum(['start', 'middle', 'end']).optional(),
  dominantBaseline: z.enum(['auto', 'middle', 'central', 'hanging', 'alphabetic']).optional(),
  letterSpacing: coordinate.optional(),
});

export type LessonVisualAttributes = z.infer<typeof LessonVisualAttributesSchema>;

export interface LessonVisualNode {
  tag: (typeof LessonVisualTag)[keyof typeof LessonVisualTag];
  attributes: LessonVisualAttributes;
  children: (LessonVisualNode | string)[];
}

export const LessonVisualNodeSchema: z.ZodType<LessonVisualNode> = z.lazy(() =>
  z.strictObject({
    tag: z.enum(LessonVisualTag),
    attributes: LessonVisualAttributesSchema,
    children: z.array(z.union([LessonVisualNodeSchema, z.string().max(2000)])).max(160),
  }),
);

export const LessonRenderPropsSchema = z.strictObject({
  screen: LessonScreenSchema,
  durationSeconds: z.number().min(1).max(180),
  audioUrl: z.string().nullable(),
  visualFrames: z.array(LessonVisualNodeSchema).max(2700).optional(),
});

export type LessonRenderProps = z.infer<typeof LessonRenderPropsSchema>;

export const LessonRenderRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('clip'),
    version: z.literal(lessonRenderVersion),
    screen: LessonScreenSchema,
    durationSeconds: z.number().min(1).max(180),
    audio: z
      .string()
      .max(Math.ceil((LessonLimits.SCREEN_BYTES * 4) / 3))
      .nullable(),
    visual: LessonRenderVisualSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('combine'),
    version: z.literal(lessonRenderVersion),
    clips: z
      .array(z.string().max(Math.ceil((LessonLimits.SCREEN_BYTES * 4) / 3)))
      .min(3)
      .max(6),
  }),
]);

export type LessonRenderRequest = z.infer<typeof LessonRenderRequestSchema>;

export const LessonRenderReplySchema = z.strictObject({
  video: z.string().max(Math.ceil((LessonLimits.VIDEO_BYTES * 4) / 3)),
});

export const LessonRendererHealthSchema = z.strictObject({
  version: z.literal(lessonRenderVersion),
  buildId: z.string().min(1).max(100),
  visualRuntimeVersion: z.literal(lessonVisualRuntimeVersion).optional(),
});
