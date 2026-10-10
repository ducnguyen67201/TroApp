import { z } from 'zod';
import {
  LessonInputSchema,
  LessonPlanSchema,
  ReviewResultSchema,
  RenderManifestSchema,
  RenderAdjustmentsSchema,
  SpeechArtifactSchema,
  PrivateNoteSchema,
  GuidedLessonReplySchema,
  StudentLessonRequestSchema,
  LessonStatusSchema,
  LessonLanguage,
  LessonPhase,
} from '#contracts/GuidedLessons.js';

const IdSchema = z.string().min(1).max(100);
export const LessonProviderUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const LessonRunSchema = z.strictObject({
  id: IdSchema,
  day: z.string(),
  stage: LessonStatusSchema,
  claimId: IdSchema.nullable(),
  leaseUntil: z.string().nullable(),
  dispatched: z.boolean(),
  contentRepairs: z.number().int().min(0).max(1),
  visualRepairs: z.number().int().min(0).max(1),
  physicalAttempts: z.number().int().min(0).max(7),
  graphicsAttempts: z.number().int().min(0).max(256).optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  speechAttempts: z.number().int().min(0).max(24),
  speechCharacters: z.number().int().nonnegative(),
  renderRetries: z.number().int().min(0).max(1),
});

/** Validated aggregate owns the mutable draft; immutable snapshots have separate records. */
export const LessonRecordSchema = z.strictObject({
  id: IdSchema,
  classId: IdSchema,
  teacherId: IdSchema,
  version: z.number().int().positive(),
  revisionId: IdSchema,
  title: z.string().max(120),
  language: z.enum(LessonLanguage),
  status: LessonStatusSchema,
  updatedAt: z.string(),
  input: LessonInputSchema,
  plan: LessonPlanSchema.nullable(),
  contentHash: z.string().nullable(),
  review: ReviewResultSchema.nullable(),
  visualReview: ReviewResultSchema.nullable(),
  manifest: RenderManifestSchema.nullable(),
  adjustments: RenderAdjustmentsSchema.nullable(),
  speech: z.array(SpeechArtifactSchema).max(24),
  scriptApproved: z.boolean(),
  previewApproved: z.boolean(),
  scriptApproval: z
    .strictObject({ commandId: IdSchema, contentHash: z.string(), at: z.string() })
    .nullable(),
  previewApproval: z
    .strictObject({
      commandId: IdSchema,
      manifestHash: z.string(),
      evidenceIds: z.array(IdSchema),
      at: z.string(),
    })
    .nullable(),
  releaseId: IdSchema.nullable(),
  error: z.string().max(1000).nullable(),
  run: LessonRunSchema.nullable(),
});

export const LessonReleaseSchema = z.strictObject({
  id: IdSchema,
  lessonId: IdSchema,
  classId: IdSchema,
  available: z.boolean(),
  releasedAt: z.string(),
  record: LessonRecordSchema,
});

export const LessonProgressSchema = z.strictObject({
  studentId: IdSchema,
  releaseId: IdSchema,
  version: z.number().int().nonnegative(),
  sceneId: IdSchema,
  revealed: z.array(IdSchema).max(3),
  attempted: z.array(IdSchema).max(3),
  independent: z.array(IdSchema).max(3),
  hinted: z.array(IdSchema).max(3),
  hintIds: z.array(IdSchema).max(9),
  frame: z.number().int().min(0).max(9000),
  reflection: z.string().max(4000),
  reflecting: z.boolean(),
  viewPhase: z.enum(LessonPhase).nullable(),
});

export const LessonReservationState = {
  RESERVED: 'reserved',
  DISPATCHED: 'dispatched',
  SETTLED: 'settled',
  UNCERTAIN: 'uncertain',
} as const;

export const LessonReservationSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  lessonId: IdSchema,
  stage: z.string(),
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  speechCharacters: z.number().int().nonnegative(),
  state: z.enum(LessonReservationState),
  actualInput: z.number().int().nonnegative().nullable(),
  actualOutput: z.number().int().nonnegative().nullable(),
});

export const LessonBudgetSchema = z.strictObject({
  id: IdSchema,
  version: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  helpRequests: z.number().int().nonnegative(),
  helpTimes: z.array(z.number()).max(30),
  reservations: z.array(LessonReservationSchema).max(4096),
});

export const LessonReceiptSchema = z.strictObject({
  digest: z.string(),
  reply: GuidedLessonReplySchema,
  /** Help may advance a checkpoint hint without returning a learner projection. */
  progressVersion: z.number().int().nonnegative().optional(),
});

export const LessonRequestSchema = StudentLessonRequestSchema;

export type LessonRecord = z.infer<typeof LessonRecordSchema>;

export type LessonRun = z.infer<typeof LessonRunSchema>;

export type LessonRelease = z.infer<typeof LessonReleaseSchema>;

export type LessonProgress = z.infer<typeof LessonProgressSchema>;

export type LessonBudget = z.infer<typeof LessonBudgetSchema>;

export type LessonReservation = z.infer<typeof LessonReservationSchema>;

export type LessonReceipt = z.infer<typeof LessonReceiptSchema>;

export type LessonRequest = z.infer<typeof LessonRequestSchema>;

export type LessonNote = z.infer<typeof PrivateNoteSchema>;
