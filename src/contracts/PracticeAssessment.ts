import { z } from 'zod';

export const PracticeCaptureProvenanceSchema = z.strictObject({
  id: z.uuid(),
  capturedAt: z.iso.datetime(),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const PracticeVerification = {
  LLM: 'llm',
  EXACT_OUTPUT: 'exact-output',
  SCRATCH_STRUCTURE: 'scratch-structure',
  TEACHER: 'teacher',
} as const;

export const PracticeCapability = {
  TEXT: 'text',
  IMAGE: 'image',
  PROJECT_STRUCTURE: 'project-structure',
  VERIFIED_EXECUTION: 'verified-execution',
} as const;

export const PracticeVerificationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(PracticeVerification.LLM) }),
  z.strictObject({ kind: z.literal(PracticeVerification.TEACHER) }),
  z.strictObject({
    kind: z.literal(PracticeVerification.EXACT_OUTPUT),
    expectedText: z.string().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.literal(PracticeVerification.SCRATCH_STRUCTURE),
    eventOpcode: z.enum([
      'event_whenflagclicked',
      'event_whenthisspriteclicked',
      'event_whenkeypressed',
    ]),
    blockOpcode: z.string().regex(/^[a-z][a-z0-9_]{1,100}$/),
  }),
]);

export const PracticeSourceSchema = z.strictObject({
  id: z.uuid(),
  sourceUnitId: z.uuid(),
  location: z.string().max(200),
  text: z.string().max(12000),
  teacherNote: z.string().max(10000).nullable(),
});

export const PracticeGroundingSchema = z.strictObject({
  courseRevisionId: z.uuid(),
  teacherInstructions: z.string().max(4000),
  sources: z.array(PracticeSourceSchema).max(64),
  missingSourceIds: z.array(z.uuid()).max(64),
});

export const PracticeEvidenceUnitSchema = z.strictObject({
  evidenceId: z.uuid(),
  location: z.string().max(200),
  text: z.string().max(12000),
});

export const PracticeAssessmentTraceSchema = z.strictObject({
  version: z.literal('practice-assessment-v1'),
  courseRevisionId: z.uuid(),
  sourceIds: z.array(z.uuid()).max(64),
  missingSourceIds: z.array(z.uuid()).max(64),
  extractorVersion: z.string().max(200),
  units: z.array(PracticeEvidenceUnitSchema).max(120),
  warnings: z.array(z.string().max(500)).max(30),
  evaluators: z
    .array(
      z.strictObject({
        criterionId: z.uuid(),
        id: z.enum(PracticeVerification),
        version: z.string().max(200),
      }),
    )
    .max(8),
});

export type PracticeGrounding = z.infer<typeof PracticeGroundingSchema>;

export type PracticeEvidenceUnit = z.infer<typeof PracticeEvidenceUnitSchema>;

export type PracticeAssessmentTrace = z.infer<typeof PracticeAssessmentTraceSchema>;

export type PracticeCapability = (typeof PracticeCapability)[keyof typeof PracticeCapability];
