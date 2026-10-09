import { z } from 'zod';
import { DesktopLocaleSchema } from './DesktopLocale.js';
import {
  PracticeAssessmentTraceSchema,
  PracticeCaptureProvenanceSchema,
  PracticeCapability,
  PracticeVerificationSchema,
} from './PracticeAssessment.js';

export const PracticeEvidenceKind = {
  TEXT: 'text',
  IMAGE: 'image',
  DOCUMENT: 'document',
} as const;

export type PracticeEvidenceKind = (typeof PracticeEvidenceKind)[keyof typeof PracticeEvidenceKind];

export const PracticeFinding = {
  MET: 'met',
  NEEDS_CHANGES: 'needs_changes',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
} as const;

export type PracticeFinding = (typeof PracticeFinding)[keyof typeof PracticeFinding];

export const PracticeCheckStatus = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export const PracticeFailure = {
  INVALID: 'invalid',
  FORBIDDEN: 'forbidden',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
  LIMIT: 'limit',
} as const;

export const PracticeLimits = {
  PRIVATE_BYTES: 64000000,
  INPUT_TOKENS: 6000,
  TEXT_CHARACTERS: 12000,
  IMAGE_BYTES: 1000000,
  EVIDENCE_COUNT: 3,
  TOTAL_BYTES: 2000000,
  LEASE_MS: 90000,
} as const;

export const PracticeCriterionSchema = z.strictObject({
  id: z.uuid(),
  description: z.string().trim().min(1).max(500),
  required: z.boolean(),
  evidenceNeeded: z.string().trim().min(1).max(500),
  sourceIds: z.array(z.uuid()).max(8),
  verification: PracticeVerificationSchema.optional(),
  capabilities: z.array(z.enum(PracticeCapability)).max(4).optional(),
});

export const PracticeCheckpointSchema = z
  .strictObject({
    id: z.uuid(),
    rubricRevisionId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    task: z.string().trim().min(1).max(2000),
    approved: z.boolean(),
    origin: z.enum(['source', 'suggestion']),
    criteria: z.array(PracticeCriterionSchema).min(1).max(8),
  })
  .refine(
    (checkpoint) =>
      new Set(checkpoint.criteria.map((item) => item.id)).size === checkpoint.criteria.length &&
      checkpoint.criteria.some((item) => item.required),
    'A checkpoint needs unique criteria and at least one required criterion.',
  );

export type PracticeCheckpoint = z.infer<typeof PracticeCheckpointSchema>;

export const PracticeSuggestionSchema = z.strictObject({
  title: z.string().min(1).max(200),
  task: z.string().min(1).max(2000),
  origin: z.enum(['source', 'suggestion']),
  criteria: z
    .array(PracticeCriterionSchema.omit({ id: true, verification: true, capabilities: true }))
    .min(1)
    .max(8),
});

export const PracticeEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.uuid(),
    kind: z.literal(PracticeEvidenceKind.DOCUMENT),
    name: z.string().trim().min(1).max(200),
    mediaType: z.enum(['application/pdf', 'application/x.scratch.sb3']),
    base64: z
      .string()
      .min(4)
      .max(1333336)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
  z.strictObject({
    id: z.uuid(),
    kind: z.literal(PracticeEvidenceKind.TEXT),
    name: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(PracticeLimits.TEXT_CHARACTERS),
  }),
  z.strictObject({
    id: z.uuid(),
    kind: z.literal(PracticeEvidenceKind.IMAGE),
    name: z.string().trim().min(1).max(200),
    mediaType: z.enum(['image/png', 'image/jpeg']),
    capture: PracticeCaptureProvenanceSchema.optional(),
    base64: z
      .string()
      .min(4)
      .max(1333336)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
]);

export type PracticeEvidence = z.infer<typeof PracticeEvidenceSchema>;

export const PracticeCriterionResultSchema = z.strictObject({
  criterionId: z.uuid(),
  finding: z.enum(PracticeFinding),
  feedback: z.string().min(1).max(1000),
  evidenceIds: z.array(z.uuid()).max(3),
});

export const PracticeEvaluationSchema = z.strictObject({
  assessment: PracticeAssessmentTraceSchema.optional(),
  results: z.array(PracticeCriterionResultSchema).min(1).max(8),
});

export type PracticeEvaluation = z.infer<typeof PracticeEvaluationSchema>;

export const PracticeRecordSchema = z.strictObject({
  id: z.uuid(),
  requestId: z.uuid(),
  snapshotId: z.uuid(),
  attemptId: z.uuid(),
  checkpointId: z.uuid(),
  rubric: PracticeCheckpointSchema,
  status: z.enum(PracticeCheckStatus),
  finding: z.enum(PracticeFinding).nullable(),
  results: z.array(PracticeCriterionResultSchema).max(8),
  evaluator: z.string().max(200),
  assessment: PracticeAssessmentTraceSchema.optional(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  evidence: z
    .array(
      z.strictObject({
        id: z.uuid(),
        kind: z.enum(PracticeEvidenceKind),
        name: z.string().max(200),
        byteCount: z.number().int().nonnegative(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        capture: PracticeCaptureProvenanceSchema.optional(),
      }),
    )
    .min(1)
    .max(3),
});

export type PracticeRecord = z.infer<typeof PracticeRecordSchema>;

export const WorkSubmissionSchema = z.strictObject({
  id: z.uuid(),
  studentId: z.string().min(1),
  attemptId: z.uuid(),
  checkpointId: z.uuid(),
  snapshotId: z.uuid(),
  checkId: z.uuid(),
  sequence: z.number().int().positive(),
  submittedAt: z.iso.datetime(),
});

export type WorkSubmission = z.infer<typeof WorkSubmissionSchema>;
const binding = { participationId: z.uuid(), deviceId: z.uuid(), activityId: z.uuid() };
const versions = {
  contextVersion: z.number().int().positive(),
  progressVersion: z.number().int().nonnegative(),
};
export const PracticeCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('check'),
    ...binding,
    ...versions,
    checkpointId: z.uuid(),
    requestId: z.uuid(),
    locale: DesktopLocaleSchema,
    evidence: z.array(PracticeEvidenceSchema).min(1).max(3),
  }),
  z.strictObject({ kind: z.literal('history'), ...binding }),
  z.strictObject({
    kind: z.literal('help'),
    ...binding,
    checkId: z.uuid(),
    criterionId: z.uuid(),
    locale: DesktopLocaleSchema,
  }),
  z.strictObject({
    kind: z.literal('submit-snapshot'),
    locale: DesktopLocaleSchema.optional(),
    ...binding,
    ...versions,
    checkId: z.uuid(),
    requestId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal('read-evidence'), checkId: z.uuid() }),
  z.strictObject({ kind: z.literal('teacher-history'), classSessionId: z.uuid() }),
]);

export type PracticeCommand = z.infer<typeof PracticeCommandSchema>;

export const PracticeReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('check'), check: PracticeRecordSchema }),
  z.strictObject({ kind: z.literal('help'), message: z.string().min(1).max(5000) }),
  z.strictObject({
    kind: z.literal('history'),
    checks: z.array(PracticeRecordSchema).max(20),
    submissions: z.array(WorkSubmissionSchema).max(20),
  }),
  z.strictObject({ kind: z.literal('submitted'), submission: WorkSubmissionSchema }),
  z.strictObject({
    kind: z.literal('evidence'),
    evidence: z.array(PracticeEvidenceSchema).min(1).max(3),
  }),
  z.strictObject({
    kind: z.literal('teacher-history'),
    students: z
      .array(
        z.strictObject({
          studentId: z.string().min(1),
          name: z.string(),
          checks: z.array(PracticeRecordSchema).max(20),
          submissions: z.array(WorkSubmissionSchema).max(20),
        }),
      )
      .max(100),
  }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(PracticeFailure) }),
]);

export type PracticeReply = z.infer<typeof PracticeReplySchema>;
