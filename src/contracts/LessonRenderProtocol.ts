import { z } from 'zod';
import { LessonLimits, LessonScreenSchema } from './LessonVideos.js';

export const lessonRenderVersion = 1;

export const LessonRenderPropsSchema = z.strictObject({
  screen: LessonScreenSchema,
  durationSeconds: z.number().min(1).max(180),
  audioUrl: z.string().nullable(),
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
});
