import {
  MaterialSourceScope,
  MaterialSearchResultSchema,
  MaterialSourceReadSchema,
} from './MaterialContext.js';
import { MaterialLessonContextSchema, MaterialPageSchema } from './ClassroomMaterials.js';
import { z } from 'zod';
import { PracticeCheckpointSchema } from './PracticeCheck.js';
import { AccountRoleSchema } from './AccountRole.js';

export const ClassroomPhase = {
  EXPLANATION: 'explanation',
  PRACTICE: 'practice',
  SUBMISSION: 'submission',
  REVIEW: 'review',
} as const;

export const ClassroomPacing = { TEACHER: 'teacher', STUDENT: 'student' } as const;

export const ClassroomStatus = { LIVE: 'live', ENDED: 'ended' } as const;

export const MaterialRole = {
  DEMONSTRATION: 'demonstration',
  STARTER: 'starter',
  REFERENCE: 'reference',
  EXPECTED_RESULT: 'expected_result',
} as const;

export const SubmissionRequirement = { NONE: 'none', SCRATCH_LINK: 'scratch_link' } as const;

export const ClassroomFailure = {
  INVALID: 'invalid',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
} as const;

export type ClassroomFailure = (typeof ClassroomFailure)[keyof typeof ClassroomFailure];

const shortText = z.string().trim().min(1).max(200);
export const ResourceUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  });

export const ActivitySchema = z.strictObject({
  id: z.uuid(),
  title: shortText,
  objective: z.string().trim().min(1).max(2000),
  instructions: z.string().trim().max(4000),
  prerequisites: z.array(z.string().trim().min(1).max(500)).max(12),
  criteria: z
    .array(z.strictObject({ id: z.uuid(), description: z.string().trim().min(1).max(500) }))
    .min(1)
    .max(12),
  materials: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: shortText,
        role: z.enum(MaterialRole),
        url: ResourceUrlSchema,
        summary: z.string().trim().max(2000),
      }),
    )
    .max(12),
  submission: z.enum(SubmissionRequirement),
  practiceCheckpoints: z.array(PracticeCheckpointSchema).max(4).optional(),
});

export type ClassroomActivity = z.infer<typeof ActivitySchema>;

export const CourseContentSchema = z
  .strictObject({
    modules: z
      .array(
        z.strictObject({
          title: shortText,
          lessons: z
            .array(
              z.strictObject({
                title: shortText,
                activities: z.array(ActivitySchema).min(1).max(20),
              }),
            )
            .min(1)
            .max(10),
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((content, context) => {
    const activities = content.modules.flatMap((module) =>
      module.lessons.flatMap((lesson) => lesson.activities),
    );
    const ids = activities.flatMap((activity) => [
      activity.id,
      ...activity.criteria.map((criterion) => criterion.id),
      ...activity.materials.map((material) => material.id),
      ...(activity.practiceCheckpoints ?? []).flatMap((checkpoint) => [
        checkpoint.id,
        ...checkpoint.criteria.map((criterion) => criterion.id),
      ]),
    ]);
    if (
      activities.length > 40 ||
      new Set(ids).size !== ids.length ||
      JSON.stringify(content).length > 100_000
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Course content exceeds limits or repeats an ID.',
      });
    }
  });

export type CourseContent = z.infer<typeof CourseContentSchema>;

export const CourseRevisionSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.string().min(1),
  title: shortText,
  content: CourseContentSchema,
});

export type CourseRevision = z.infer<typeof CourseRevisionSchema>;

export const ClassSchema = z.strictObject({
  id: z.uuid(),
  teacherId: z.string().min(1),
  name: shortText,
  courseRevisionId: z.uuid(),
});

export type SchoolClass = z.infer<typeof ClassSchema>;

export const ClassMeetingSchema = z.strictObject({
  id: z.uuid(),
  classId: z.uuid(),
  status: z.enum(ClassroomStatus),
  phase: z.enum(ClassroomPhase),
  pacing: z.enum(ClassroomPacing),
  currentActivityId: z.uuid(),
  contextVersion: z.number().int().positive(),
});

export type ClassMeeting = z.infer<typeof ClassMeetingSchema>;

export const CriterionEvidenceSource = { STUDENT: 'student', MODEL: 'model' } as const;

export const CriterionEvidenceSchema = z.strictObject({
  criterionId: z.uuid(),
  source: z.enum(CriterionEvidenceSource),
  observation: z.string().trim().min(1).max(500),
});

export const StudentAttemptSchema = z.strictObject({
  id: z.uuid(),
  participationId: z.uuid(),
  activityId: z.uuid(),
  progressVersion: z.number().int().nonnegative(),
  workspaceUrl: ResourceUrlSchema.nullable(),
  evidence: z.array(CriterionEvidenceSchema).max(12),
  declaredComplete: z.boolean(),
  helpSummary: z.string().max(1000),
});

export type StudentAttempt = z.infer<typeof StudentAttemptSchema>;

export const ParticipationSchema = z.strictObject({
  id: z.uuid(),
  classSessionId: z.uuid(),
  studentId: z.string().min(1),
  deviceId: z.uuid(),
  leaseUntil: z.iso.datetime(),
  left: z.boolean(),
});

export type Participation = z.infer<typeof ParticipationSchema>;

export const SubmissionReceiptSchema = z.strictObject({
  id: z.uuid(),
  attemptId: z.uuid(),
  url: ResourceUrlSchema,
  submittedAt: z.iso.datetime(),
});

export type SubmissionReceipt = z.infer<typeof SubmissionReceiptSchema>;

export const TeachingContextSchema = z.strictObject({
  materialContext: MaterialLessonContextSchema.optional(),
  className: shortText,
  meeting: ClassMeetingSchema,
  participation: ParticipationSchema,
  courseRevisionId: z.uuid(),
  activity: ActivitySchema,
  attempt: StudentAttemptSchema,
  latestSubmission: SubmissionReceiptSchema.nullable(),
  availableActivities: z.array(z.strictObject({ id: z.uuid(), title: shortText })).max(40),
});

export type TeachingContext = z.infer<typeof TeachingContextSchema>;

export const SubmissionPreparationSchema = z.strictObject({
  id: z.uuid(),
  attemptId: z.uuid(),
  url: ResourceUrlSchema,
  progressVersion: z.number().int().nonnegative(),
  contextVersion: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
});

export type SubmissionPreparation = z.infer<typeof SubmissionPreparationSchema>;

/** A code is disclosed only when issued; persistence stores its digest. */
export const ClassroomInvitationSchema = z.strictObject({
  id: z.uuid(),
  classId: z.uuid(),
  code: z.string().regex(/^[A-F0-9]{12}$/),
  email: z.email().nullable(),
  expiresAt: z.iso.datetime(),
});

export type ClassroomInvitation = z.infer<typeof ClassroomInvitationSchema>;

export const ClassroomInviteCodeSchema = z
  .string()
  .trim()
  .max(32)
  .transform((value) => value.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-F0-9]{12}$/));

export const ClassroomHomeSchema = z.strictObject({
  role: AccountRoleSchema,
  courses: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: shortText,
        activities: z.array(z.strictObject({ id: z.uuid(), title: shortText })).max(40),
      }),
    )
    .max(100),
  classes: z
    .array(
      z.strictObject({ schoolClass: ClassSchema, meetings: z.array(ClassMeetingSchema).max(100) }),
    )
    .max(100),
});

export type ClassroomHome = z.infer<typeof ClassroomHomeSchema>;
const binding = { participationId: z.uuid(), deviceId: z.uuid(), activityId: z.uuid() };
const mutation = {
  ...binding,
  contextVersion: z.number().int().positive(),
  progressVersion: z.number().int().nonnegative(),
};
export const ClassroomCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home') }),
  z.strictObject({
    kind: z.literal('create-invitation'),
    classId: z.uuid(),
    email: z.email().optional(),
  }),
  z.strictObject({ kind: z.literal('revoke-invitations'), classId: z.uuid() }),
  z.strictObject({ kind: z.literal('delete-class'), classId: z.uuid() }),
  z.strictObject({ kind: z.literal('accept-invitation'), code: ClassroomInviteCodeSchema }),
  z.strictObject({
    kind: z.literal('publish-course'),
    title: shortText,
    content: CourseContentSchema,
  }),
  z.strictObject({
    kind: z.literal('create-class'),
    name: shortText,
    courseRevisionId: z.uuid().optional(),
  }),
  z.strictObject({ kind: z.literal('enroll'), classId: z.uuid(), email: z.email() }),
  z.strictObject({
    kind: z.literal('revoke'),
    classId: z.uuid(),
    studentId: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal('start-session'),
    classId: z.uuid(),
    activityId: z.uuid(),
    pacing: z.enum(ClassroomPacing),
  }),
  z.strictObject({
    kind: z.literal('update-session'),
    classSessionId: z.uuid(),
    contextVersion: z.number().int().positive(),
    activityId: z.uuid(),
    phase: z.enum(ClassroomPhase),
    pacing: z.enum(ClassroomPacing),
  }),
  z.strictObject({
    kind: z.literal('end-session'),
    classSessionId: z.uuid(),
    contextVersion: z.number().int().positive(),
  }),
  z.strictObject({
    materialSchemaVersion: z.literal(2).optional(),
    kind: z.literal('join'),
    classSessionId: z.uuid(),
    deviceId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('context'),
    ...binding,
    materialSchemaVersion: z.literal(2).optional(),
    question: z.string().max(1000).optional(),
  }),
  z.strictObject({ kind: z.literal('read-material-notes'), ...binding, pageId: z.uuid() }),
  z.strictObject({
    kind: z.literal('search-material'),
    ...binding,
    contextVersion: z.number().int().positive(),
    question: z.string().min(1).max(1000),
    documentId: z.uuid().nullable(),
  }),
  z.strictObject({
    kind: z.literal('read-material-source'),
    ...binding,
    contextVersion: z.number().int().positive(),
    sourceId: z.uuid(),
    scope: z.enum(MaterialSourceScope),
    offset: z.number().int().nonnegative().max(100000).optional(),
  }),
  z.strictObject({ kind: z.literal('leave'), participationId: z.uuid(), deviceId: z.uuid() }),
  z.strictObject({ kind: z.literal('save-workspace'), ...mutation, url: ResourceUrlSchema }),
  z.strictObject({
    kind: z.literal('report-progress'),
    ...mutation,
    eventId: z.uuid(),
    evidence: z.array(CriterionEvidenceSchema).max(12),
    declaredComplete: z.boolean(),
    helpSummary: z.string().trim().max(1000),
  }),
  z.strictObject({ kind: z.literal('prepare-submission'), ...mutation }),
  z.strictObject({
    kind: z.literal('submit-work'),
    ...mutation,
    preparedSubmissionId: z.uuid(),
    idempotencyKey: z.uuid(),
  }),
  z.strictObject({ kind: z.literal('session-roster'), classSessionId: z.uuid() }),
]);

export type ClassroomCommand = z.infer<typeof ClassroomCommandSchema>;

export const ClassroomRosterSchema = z
  .array(
    z.strictObject({
      studentId: z.string(),
      name: z.string(),
      participation: ParticipationSchema.nullable(),
      attempts: z.array(StudentAttemptSchema).max(40),
      submissions: z.array(SubmissionReceiptSchema).max(100),
    }),
  )
  .max(200);

export const ClassroomReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('home'), home: ClassroomHomeSchema }),
  z.strictObject({ kind: z.literal('invitation'), invitation: ClassroomInvitationSchema }),
  z.strictObject({ kind: z.literal('context'), context: TeachingContextSchema }),
  z.strictObject({ kind: z.literal('prepared'), preparation: SubmissionPreparationSchema }),
  z.strictObject({ kind: z.literal('submitted'), receipt: SubmissionReceiptSchema }),
  z.strictObject({ kind: z.literal('roster'), roster: ClassroomRosterSchema }),
  z.strictObject({ kind: z.literal('material-note'), page: MaterialPageSchema }),
  z.strictObject({ kind: z.literal('material-search'), result: MaterialSearchResultSchema }),
  z.strictObject({ kind: z.literal('material-source'), result: MaterialSourceReadSchema }),
  z.strictObject({ kind: z.literal('ok') }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(ClassroomFailure) }),
]);

export type ClassroomReply = z.infer<typeof ClassroomReplySchema>;

/** Worker tools cannot publish content, change membership or commit a hand-in. */
export const ClassroomToolCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('resume-workspace') }),
  z.strictObject({ kind: z.literal('read-material-notes'), pageId: z.uuid() }),
  z.strictObject({
    kind: z.literal('search-material'),
    question: z.string().min(1).max(1000),
    documentId: z.uuid().nullable(),
  }),
  z.strictObject({
    kind: z.literal('read-material-source'),
    sourceId: z.uuid(),
    scope: z.enum(MaterialSourceScope),
    offset: z.number().int().nonnegative().max(100000).optional(),
  }),
  z.strictObject({ kind: z.literal('save-workspace'), url: ResourceUrlSchema }),
  z.strictObject({
    kind: z.literal('report-progress'),
    evidence: z.array(CriterionEvidenceSchema).max(12),
    helpSummary: z.string().max(1000),
  }),
  z.strictObject({ kind: z.literal('prepare-submission') }),
]);

export type ClassroomToolCommand = z.infer<typeof ClassroomToolCommandSchema>;

export const ClassroomToolRequestSchema = z.strictObject({
  kind: z.literal('classroom-tool'),
  requestId: z.uuid(),
  taskRequestId: z.uuid(),
  participationId: z.uuid(),
  command: ClassroomToolCommandSchema,
});

export const ClassroomToolResponseSchema = z.strictObject({
  kind: z.literal('classroom-tool-result'),
  requestId: z.uuid(),
  reply: ClassroomReplySchema,
});
