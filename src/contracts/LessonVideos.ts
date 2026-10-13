import { z } from 'zod';
import { LessonVisualBriefSchema, LessonVisualStateSchema } from './LessonVisuals.js';

export const LessonVideoStatus = {
  QUEUED: 'queued',
  RUNNING: 'running',
  READY: 'ready',
  STOPPED: 'stopped',
  CANCELLED: 'cancelled',
} as const;

export const LessonVideoStage = {
  CONTENT: 'content',
  SPEECH: 'speech',
  VISUAL: 'visual',
  CLIP: 'clip',
  COMBINE: 'combine',
} as const;

export const LessonVideoFailure = {
  INVALID: 'invalid',
  FORBIDDEN: 'forbidden',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
  BUDGET: 'budget',
  CONTENT: 'content',
  SPEECH: 'speech',
  RENDER: 'render',
  DEADLINE: 'deadline',
} as const;

export const LessonLayout = {
  EXPLANATION: 'explanation',
  EXAMPLE: 'example',
  COMPARISON: 'comparison',
} as const;

export const LessonArtifactKind = {
  AUDIO: 'audio',
  CLIP: 'clip',
  VIDEO: 'video',
  SOURCE: 'source',
} as const;

export const LessonCommand = {
  OPTIONS: 'options',
  LIST: 'list',
  CREATE: 'create',
  READ: 'read',
  EDIT: 'edit',
  CONTINUE: 'continue',
  NARRATE: 'narrate',
  REGENERATE: 'regenerate',
  CANCEL: 'cancel',
  DELETE: 'delete',
} as const;

export const LessonLimits = {
  SCREEN_BYTES: 10 * 1024 * 1024,
  VIDEO_BYTES: 64 * 1024 * 1024,
  SCREENS: 6,
  SOURCE_CHARACTERS: 24000,
  WIDTH: 1280,
  HEIGHT: 720,
  FPS: 30,
} as const;

/** Editable baseline content has bounded slots and never contains generated source. */
export const LessonScreenSchema = z.strictObject({
  layout: z.enum(LessonLayout),
  title: z.string().min(1).max(80),
  points: z.array(z.string().min(1).max(160)).min(1).max(3),
  narration: z.string().min(1).max(1000),
});

export const LessonContentSchema = z.strictObject({
  title: z.string().min(1).max(120),
  screens: z.array(LessonScreenSchema).min(3).max(6),
});

export type LessonScreen = z.infer<typeof LessonScreenSchema>;

export type LessonContent = z.infer<typeof LessonContentSchema>;

/** The writer proposes visuals alongside content without another classifier request. */
export const LessonWriterOutputSchema = z.strictObject({
  content: LessonContentSchema,
  briefs: z.array(LessonVisualBriefSchema).max(6),
});

export type LessonWriterOutput = z.infer<typeof LessonWriterOutputSchema>;

const screen = LessonScreenSchema.extend({
  id: z.uuid(),
  audioId: z.uuid().nullable(),
  clipId: z.uuid().nullable(),
  silent: z.boolean(),
  durationSeconds: z.number().nonnegative(),
  speechAttempts: z.number().int().nonnegative(),
  renderAttempts: z.number().int().nonnegative(),
  visual: LessonVisualStateSchema.optional(),
});
export const LessonVideoSchema = z.strictObject({
  id: z.uuid(),
  classId: z.uuid(),
  title: z.string(),
  prompt: z.string(),
  locale: z.enum(['en', 'vi']),
  revision: z.number().int().positive(),
  status: z.enum(LessonVideoStatus),
  stage: z.enum(LessonVideoStage),
  error: z.enum(LessonVideoFailure).nullable(),
  screens: z.array(screen).max(6),
  videoId: z.uuid().nullable(),
  videoRevision: z.number().int().nullable(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reservedMicroUsd: z.number().nonnegative(),
  usageUncertain: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canContinue: z.boolean(),
});

export type LessonVideo = z.infer<typeof LessonVideoSchema>;
const selection = {
  classId: z.uuid(),
  materialIds: z.array(z.uuid()).min(1).max(20),
  prompt: z.string().trim().min(1).max(2000),
  locale: z.enum(['en', 'vi']),
};
const identity = { id: z.uuid(), revision: z.number().int().positive() };
export const LessonVideoCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(LessonCommand.OPTIONS) }),
  z.strictObject({ kind: z.literal(LessonCommand.LIST) }),
  z.strictObject({ kind: z.literal(LessonCommand.CREATE), requestId: z.uuid(), ...selection }),
  z.strictObject({ kind: z.literal(LessonCommand.READ), id: z.uuid() }),
  z.strictObject({
    kind: z.literal(LessonCommand.EDIT),
    ...identity,
    content: LessonContentSchema,
  }),
  z.strictObject({
    kind: z.literal(LessonCommand.REGENERATE),
    ...identity,
    requestId: z.uuid(),
    ...selection,
  }),
  ...[
    LessonCommand.CONTINUE,
    LessonCommand.NARRATE,
    LessonCommand.CANCEL,
    LessonCommand.DELETE,
  ].map((kind) => z.strictObject({ kind: z.literal(kind), ...identity })),
]);

export type LessonVideoCommand = z.infer<typeof LessonVideoCommandSchema>;

export const LessonVideoReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('lesson'), lesson: LessonVideoSchema }),
  z.strictObject({ kind: z.literal('list'), lessons: z.array(LessonVideoSchema).max(100) }),
  z.strictObject({
    kind: z.literal('options'),
    available: z.boolean(),
    estimatedMicroUsd: z.number().nonnegative(),
    maximumMicroUsd: z.number().nonnegative(),
    classes: z.array(
      z.strictObject({
        id: z.uuid(),
        name: z.string(),
        materials: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
      }),
    ),
  }),
  z.strictObject({ kind: z.literal('ok') }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(LessonVideoFailure) }),
]);

export type LessonVideoReply = z.infer<typeof LessonVideoReplySchema>;

export const LessonMediaRequestSchema = z.strictObject({
  id: z.uuid(),
  artifactId: z.uuid(),
  download: z.boolean(),
});

export type LessonMediaRequest = z.infer<typeof LessonMediaRequestSchema>;

export const LessonMediaReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('media'), bytes: z.instanceof(Uint8Array) }),
  z.strictObject({ kind: z.literal('saved') }),
  z.strictObject({ kind: z.literal('failed') }),
]);

export type LessonMediaReply = z.infer<typeof LessonMediaReplySchema>;
