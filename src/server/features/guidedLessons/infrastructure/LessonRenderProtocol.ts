import { z } from 'zod';
import {
  LessonInputSchema,
  LessonPlanSchema,
  RenderAdjustmentsSchema,
  RenderManifestSchema,
  SpeechArtifactSchema,
  LessonPhase,
} from '#contracts/GuidedLessons.js';

export const LessonPresentationIdentitySchema = z.strictObject({
  compositionBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  fontBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  rendererVersion: z.string().min(1).max(100),
  browserPath: z.string().min(1).max(1000),
  browserMode: z.literal('chrome-for-testing'),
});

export type LessonPresentationIdentity = z.infer<typeof LessonPresentationIdentitySchema>;

export const LessonRenderInputSchema = z.strictObject({
  revisionId: z.string().min(1).max(100),
  input: LessonInputSchema,
  plan: LessonPlanSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  speechArtifacts: z
    .array(
      z.strictObject({
        descriptor: SpeechArtifactSchema,
        bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= 16777216),
      }),
    )
    .min(1)
    .max(24),
  adjustments: RenderAdjustmentsSchema.nullable(),
});

export const LessonRenderMessageSchema = z.strictObject({
  bundlePath: z.string().min(1),
  identity: LessonPresentationIdentitySchema,
  request: LessonRenderInputSchema,
});

export const LessonRenderResultSchema = z.strictObject({
  manifest: RenderManifestSchema,
  artifacts: z
    .array(
      z.strictObject({
        artifactId: z.string().min(1).max(100),
        kind: z.enum(['frame', 'clip', 'audio', 'source']),
        mimeType: z.string().min(1).max(100),
        bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength <= 16777216),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        sceneId: z.string().nullable(),
        phase: z.enum(LessonPhase).nullable(),
      }),
    )
    .max(32),
});

export const LessonGeometrySchema = z
  .array(
    z.strictObject({
      fontPx: z.number(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      scrollWidth: z.number(),
      clientWidth: z.number(),
      scrollHeight: z.number(),
      clientHeight: z.number(),
    }),
  )
  .min(1)
  .max(100);

export function validateLessonGeometry(raw: unknown): z.infer<typeof LessonGeometrySchema> {
  const geometry = LessonGeometrySchema.parse(raw);
  if (
    geometry.some(
      (box) =>
        box.fontPx < 48 ||
        box.x < -1 ||
        box.y < -1 ||
        box.x + box.width > 1921 ||
        box.y + box.height > 1081 ||
        box.scrollWidth > box.clientWidth + 2 ||
        box.scrollHeight > box.clientHeight + 2,
    )
  ) {
    throw new Error('Essential lesson content is clipped or below the minimum readable size.');
  }
  for (let index = 0; index < geometry.length; index += 1) {
    const first = geometry[index];
    if (!first) {
      continue;
    }
    for (const second of geometry.slice(index + 1)) {
      const overlapWidth =
        Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
      const overlapHeight =
        Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
      if (overlapWidth > 2 && overlapHeight > 2) {
        throw new Error('Essential lesson regions overlap.');
      }
    }
  }
  return geometry;
}

export const LessonRenderFailureSchema = z.strictObject({
  kind: z.literal('failed'),
  stage: z.enum(['startup', 'browser', 'projection', 'frame', 'geometry']),
  sceneId: z.string().max(100).nullable(),
  frame: z.number().int().min(0).max(9000).nullable(),
  geometry: LessonGeometrySchema.nullable(),
});
