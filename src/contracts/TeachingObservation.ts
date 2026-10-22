import { z } from 'zod';
import { StudentPointSchema } from './StudentActivity.js';
import {
  PresentTeachingStepSchema,
  TeachingAssessment,
  TeachingGoalEvidenceSchema,
  TeachingMessageSchema,
  TeachingPresentationReceiptSchema,
} from './TeachingStep.js';

export const TeachingObservationKind = {
  CUE_REQUESTED: 'cue_requested',
  CUE_ACKNOWLEDGED: 'cue_acknowledged',
  CUE_PUBLISHED: 'cue_published',
  CUE_REFUSED: 'cue_refused',
  CUE_SUPERSEDED: 'cue_superseded',
  CUE_REVOKED: 'cue_revoked',
  ASSESSMENT: 'assessment',
  STUDENT_ATTEMPT: 'student_attempt',
  DECISION: 'decision',
  TRACE_ENDED: 'trace_ended',
} as const;

export const StudentAttemptKind = {
  CLICK: 'click',
  DRAG: 'drag',
  KEY: 'key',
  SCROLL: 'scroll',
  UNPAIRED_RELEASE: 'unpaired_release',
} as const;

/** Approximate input metadata describes an attempt, never application acceptance. */
export const StudentAttemptSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  stepId: z.uuid().nullable(),
  kind: z.enum(StudentAttemptKind),
  pressPoint: StudentPointSchema.nullable(),
  releasePoint: StudentPointSchema.nullable(),
  sourceNear: z.boolean().nullable(),
  destinationNear: z.boolean().nullable(),
});

export type StudentAttempt = z.infer<typeof StudentAttemptSchema>;

const ObservationEnvelopeSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  elapsedMs: z.number().nonnegative(),
  lessonId: z.uuid(),
});
const PresentationIdentity = { stepId: z.uuid(), presentationId: z.uuid() };

/** Public teaching outputs only: excludes SDK history, screen pixels and key contents.
 * Sequence and elapsedMs belong to one worker task, independent of bounded lesson history. */
export const TeachingObservationSchema = z.discriminatedUnion('kind', [
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.CUE_REQUESTED),
    ...PresentationIdentity,
    proposal: PresentTeachingStepSchema,
    message: TeachingMessageSchema,
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.CUE_ACKNOWLEDGED),
    ...PresentationIdentity,
    receipt: TeachingPresentationReceiptSchema,
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.CUE_PUBLISHED),
    ...PresentationIdentity,
    message: TeachingMessageSchema,
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.CUE_REFUSED),
    stepId: z.uuid().nullable(),
    presentationId: z.uuid().nullable(),
    captureId: z.string().min(1).max(256).nullable(),
    reason: z.string().min(1).max(600),
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.CUE_SUPERSEDED),
    ...PresentationIdentity,
    reason: z.string().min(1).max(600),
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.CUE_REVOKED),
    ...PresentationIdentity,
    reason: z.string().min(1).max(600),
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.ASSESSMENT),
    stepId: z.uuid().nullable(),
    proposedStepId: z.uuid(),
    captureId: z.string().min(1).max(256),
    goalRevisionId: z.uuid(),
    assessment: z.enum(TeachingAssessment),
    evidence: z.string().min(1).max(600),
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.STUDENT_ATTEMPT),
    attempt: StudentAttemptSchema,
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.DECISION),
    stepId: z.uuid().nullable(),
    presentationId: z.uuid().nullable(),
    captureId: z.string().min(1).max(256),
    goalRevisionId: z.uuid().nullable(),
    disposition: z.string().min(1).max(40),
    admitted: z.boolean(),
    reason: z.string().min(1).max(600).nullable(),
    message: z.string().min(1).max(600).nullable(),
    observationSummary: z.string().min(1).max(1200),
    goalEvidence: TeachingGoalEvidenceSchema,
  }),
  ObservationEnvelopeSchema.extend({
    kind: z.literal(TeachingObservationKind.TRACE_ENDED),
    attemptedEvents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    failedEvents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
]);

export type TeachingObservation = z.infer<typeof TeachingObservationSchema>;

type WithoutEnvelope<Event> = Event extends TeachingObservation
  ? Omit<Event, 'sequence' | 'elapsedMs' | 'lessonId'>
  : never;

export type TeachingObservationInput = WithoutEnvelope<TeachingObservation>;
