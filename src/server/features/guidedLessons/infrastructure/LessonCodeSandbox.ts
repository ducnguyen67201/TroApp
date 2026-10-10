import { z } from 'zod';
import { LearnerProjectionSchema } from '#contracts/GuidedLessons.js';
import { LessonGeometrySchema } from './LessonRenderProtocol.js';

export const LessonCodeLimits = {
  SOURCE_BYTES: 120_000,
  FRAME_BYTES: 16_777_216,
  VIDEO_BYTES: 16_777_216,
  GEOMETRY_BYTES: 262_144,
  FRAME_COUNT: 32,
  DURATION_FRAMES: 9000,
  DEADLINE_MS: 600_000,
} as const;

export const LessonCodeRequestSchema = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(LessonCodeLimits.SOURCE_BYTES)
    .refine(
      (source) => new TextEncoder().encode(source).byteLength <= LessonCodeLimits.SOURCE_BYTES,
    ),
  projection: LearnerProjectionSchema,
  durationInFrames: z.number().int().min(1).max(LessonCodeLimits.DURATION_FRAMES),
});

export type LessonCodeRequest = z.infer<typeof LessonCodeRequestSchema>;

/** Preview quality failures, including blank frames, must remain visible to the repair agent. */
export const LessonCodePreviewGeometrySchema = z.array(LessonGeometrySchema.element).max(100);

export interface LessonCodePreview {
  frames: {
    frame: number;
    bytes: Uint8Array;
    geometry: z.infer<typeof LessonCodePreviewGeometrySchema>;
  }[];
}

/** Generated React source is compiled and executed only inside the isolated render container. */
export interface LessonCodeSandbox {
  checkReady?(signal: AbortSignal): Promise<void>;
  preview(
    request: LessonCodeRequest,
    frames: number[],
    signal: AbortSignal,
  ): Promise<LessonCodePreview>;
  renderVideo(request: LessonCodeRequest, signal: AbortSignal): Promise<Uint8Array>;
}

export const LessonCodeMode = {
  PREVIEW: 'preview',
  VIDEO: 'video',
} as const;

export const LessonCodeWorkerInputSchema = LessonCodeRequestSchema.omit({ source: true })
  .extend({
    mode: z.enum(LessonCodeMode),
    frames: z.array(z.number().int().min(0)).max(LessonCodeLimits.FRAME_COUNT),
  })
  .refine((input) => input.frames.every((frame) => frame < input.durationInFrames))
  .refine((input) => new Set(input.frames).size === input.frames.length)
  .refine((input) => input.mode !== LessonCodeMode.PREVIEW || input.frames.length > 0);

export const LessonCodeStage = {
  INPUT: 'input',
  COMPILE: 'compile',
  METADATA: 'metadata',
  FRAME: 'frame',
  GEOMETRY: 'geometry',
  VIDEO: 'video',
} as const;

export type LessonCodeStage = (typeof LessonCodeStage)[keyof typeof LessonCodeStage];

export const LessonCodeFailureSchema = z.strictObject({
  stage: z.enum(LessonCodeStage),
  message: z.string().min(1).max(4000),
});

/** Bounded diagnostics from the credential-free container are tool data, never instructions. */
export class LessonCodeSandboxError extends Error {
  constructor(
    readonly stage: LessonCodeStage,
    message: string,
  ) {
    super(message.slice(0, 4000));
    this.name = 'LessonCodeSandboxError';
  }
}
