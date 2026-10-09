import { z } from 'zod';
import { CriterionEvidenceSchema } from './Classroom.js';
import {
  PracticeCheckStatus,
  PracticeCriterionResultSchema,
  PracticeEvidenceSchema,
} from './PracticeCheck.js';

export const InsightFailure = {
  INVALID: 'invalid',
  FORBIDDEN: 'forbidden',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
  LIMIT: 'limit',
  REMOVED: 'removed',
} as const;

export const InsightRecordKind = {
  ASSESSMENT: 'assessment',
  PLAN: 'plan',
  MAPPING: 'mapping',
  SUBMISSION: 'submission',
  SUPPORT: 'support',
  NEXT_TASK: 'next_task',
  REPORT: 'report',
  COVERAGE: 'coverage',
  PROGRESS: 'progress',
  REMOVAL: 'removal',
} as const;

export type InsightRecordKind = (typeof InsightRecordKind)[keyof typeof InsightRecordKind];

export type InsightFailure = (typeof InsightFailure)[keyof typeof InsightFailure];

export const AssistanceContext = {
  UNKNOWN: 'unknown',
  UNAIDED: 'unaided',
  HINT: 'hint',
  DEMONSTRATION: 'demonstration',
  GROUP: 'group',
} as const;

export type AssistanceContext = (typeof AssistanceContext)[keyof typeof AssistanceContext];

export const AssessmentPurpose = {
  PRACTICE: 'practice',
  BASELINE: 'baseline',
  FRESH: 'fresh',
  DELAYED: 'delayed',
  TRANSFER: 'transfer',
} as const;

export type AssessmentPurpose = (typeof AssessmentPurpose)[keyof typeof AssessmentPurpose];

export const AssessmentMethod = {
  MODEL: 'model',
  TEACHER: 'teacher',
  RULE: 'rule',
  MIXED: 'mixed',
} as const;

export const ReportStatus = {
  DRAFT: 'draft',
  APPROVED: 'approved',
  INVALIDATED: 'invalidated',
} as const;

export const InsightCoverage = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  REMOVED: 'removed',
} as const;

export const InsightLimits = {
  MAX_DAYS: 186,
  SOURCE_RECORDS: 30000,
  PAGE_SIZE: 50,
  STUDENTS: 200,
  MAX_COMMENTARY: 3000,
  DERIVATION_VERSION: 'classroom-insights-v1',
} as const;

export const InsightRevisionSchema = z
  .string()
  .max(19)
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 19 &&
      BigInt(value) <= 9223372036854775807n,
    'Revision exceeds the supported ledger range.',
  );
const identifier = z.string().min(1).max(200);
const timestamp = z.iso.datetime();
const revision = z.number().int().positive();
const base = { id: z.uuid(), version: revision, sourceRevision: InsightRevisionSchema };
const sourceIds = z.array(identifier).max(1000);
export const InsightWindowSchema = z
  .strictObject({
    from: timestamp,
    to: timestamp,
    timezone: z.string().min(1).max(100),
  })
  .refine((value) => {
    const days = (Date.parse(value.to) - Date.parse(value.from)) / 86400000;
    try {
      new Intl.DateTimeFormat('en', { timeZone: value.timezone });
    } catch {
      return false;
    }
    return days >= 0 && days <= InsightLimits.MAX_DAYS;
  }, 'Use an ordered window of at most 186 days and a valid timezone.');

export type InsightWindow = z.infer<typeof InsightWindowSchema>;

export const InsightCriterionSchema = z.strictObject({
  id: z.uuid(),
  description: z.string().min(1).max(500),
  required: z.boolean(),
});

export const InsightAssessmentSchema = z
  .strictObject({
    ...base,
    studentId: identifier,
    classSessionId: z.uuid(),
    activityId: z.uuid(),
    episodeId: z.uuid(),
    episodeOrder: z.number().int().nonnegative().nullable(),
    snapshotId: z.uuid().nullable(),
    checkId: z.uuid().nullable(),
    title: z.string().min(1).max(200),
    task: z.string().min(1).max(2000),
    courseRevisionId: z.uuid(),
    rubricRevisionId: z.uuid().nullable(),
    criteria: z.array(InsightCriterionSchema).min(1).max(8),
    results: z.array(PracticeCriterionResultSchema).max(8),
    status: z.enum(PracticeCheckStatus),
    method: z.enum(AssessmentMethod),
    evaluatorRevision: z.string().max(300).nullable(),
    purpose: z.enum(AssessmentPurpose),
    assistance: z.enum(AssistanceContext),
    individual: z.boolean().nullable(),
    unaidedConfirmed: z.boolean(),
    authorId: identifier,
    mappingId: z.uuid().nullable(),
    mappingVersion: z.number().int().positive().nullable(),
    taskVariantId: z.uuid().nullable(),
    priorEpisodeId: z.uuid().nullable(),
    supersedesId: z.uuid().nullable(),
    observedAt: timestamp,
    recordedAt: timestamp,
    sourceIds,
  })
  .superRefine((value, context) => {
    const criterionIds = new Set(value.criteria.map((criterion) => criterion.id));
    if (
      criterionIds.size !== value.criteria.length ||
      !value.criteria.some((criterion) => criterion.required)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unique criteria and a required criterion are needed.',
      });
    }
    if (
      new Set(value.results.map((result) => result.criterionId)).size !== value.results.length ||
      value.results.some((result) => !criterionIds.has(result.criterionId))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Results must refer to unique approved criteria.',
      });
    }
    if (
      value.unaidedConfirmed &&
      (value.method !== AssessmentMethod.TEACHER ||
        value.assistance !== AssistanceContext.UNAIDED ||
        value.individual !== true)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Independence requires individual unaided teacher confirmation.',
      });
    }
    if (
      (value.mappingId === null) !== (value.mappingVersion === null) ||
      (value.mappingId === null) !== (value.taskVariantId === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A task comparison must pin its mapping and version together.',
      });
    }
  });

export type InsightAssessment = z.infer<typeof InsightAssessmentSchema>;

export const InsightPlanSchema = z
  .strictObject({
    ...base,
    courseRevisionId: z.uuid(),
    classSessionId: z.uuid().nullable(),
    title: z.string().min(1).max(200),
    activityIds: z.array(z.uuid()).min(1).max(1000),
    studentIds: z.array(identifier).max(InsightLimits.STUDENTS),
    completionRule: z.literal('hand_in'),
    approvedBy: identifier,
    approvedAt: timestamp,
  })
  .refine(
    (value) =>
      new Set(value.activityIds).size === value.activityIds.length &&
      new Set(value.studentIds).size === value.studentIds.length,
    'Assignments must be unique.',
  );

export type InsightPlan = z.infer<typeof InsightPlanSchema>;

export const InsightTaskVariantSchema = z
  .strictObject({
    id: z.uuid(),
    title: z.string().min(1).max(200),
    task: z.string().min(1).max(2000),
    criterionIds: z.array(z.uuid()).min(1).max(8),
    comparisonGroupId: z.uuid(),
    scoringRevisionId: z.uuid(),
  })
  .refine(
    (value) => new Set(value.criterionIds).size === value.criterionIds.length,
    'Task criteria must be unique.',
  );

export const InsightMappingSchema = z
  .strictObject({
    ...base,
    skillId: z.uuid(),
    standardRevisionId: z.uuid(),
    title: z.string().min(1).max(200),
    criterionIds: z.array(z.uuid()).min(1).max(100),
    variants: z.array(InsightTaskVariantSchema).min(1).max(20),
    approvedBy: identifier,
    approvedAt: timestamp,
  })
  .refine(
    (value) =>
      new Set(value.criterionIds).size === value.criterionIds.length &&
      new Set(value.variants.map((variant) => variant.id)).size === value.variants.length &&
      value.variants.every((variant) =>
        variant.criterionIds.every((id) => value.criterionIds.includes(id)),
      ),
    'Task criteria must belong to the approved mapping.',
  );

export type InsightMapping = z.infer<typeof InsightMappingSchema>;

export const InsightSubmissionSchema = z.strictObject({
  ...base,
  studentId: identifier,
  classSessionId: z.uuid(),
  activityId: z.uuid(),
  courseRevisionId: z.uuid().nullable(),
  sourceKind: z.enum(['snapshot', 'link']),
  snapshotId: z.uuid().nullable(),
  checkId: z.uuid().nullable(),
  submittedAt: timestamp,
  sourceIds,
});

export type InsightSubmission = z.infer<typeof InsightSubmissionSchema>;

export const InsightSupportSchema = z.strictObject({
  ...base,
  studentId: identifier,
  classSessionId: z.uuid(),
  activityId: z.uuid(),
  criterionId: z.uuid().nullable(),
  requestedAt: timestamp,
  checkId: z.uuid().optional(),
  category: z.string().min(1).max(200),
  interventions: z
    .array(
      z.strictObject({
        id: z.uuid(),
        authorId: identifier,
        at: timestamp,
        type: z.enum(AssistanceContext),
        note: z.string().max(1000),
      }),
    )
    .max(20),
  closedAt: timestamp.nullable(),
  reportedOutcome: z.string().max(1000).nullable(),
  sourceIds,
});

export type InsightSupport = z.infer<typeof InsightSupportSchema>;

export const InsightNextTaskSchema = z.strictObject({
  ...base,
  studentId: identifier,
  activityId: z.uuid(),
  courseRevisionId: z.uuid(),
  title: z.string().min(1).max(200).optional(),
  selectedBy: identifier,
  selectedAt: timestamp,
  sourceIds,
});

export type InsightNextTask = z.infer<typeof InsightNextTaskSchema>;

export const InsightCoverageRecordSchema = z.strictObject({
  ...base,
  status: z.enum(InsightCoverage),
  captureStartedAt: timestamp.nullable(),
  importedThrough: timestamp.nullable(),
  reason: z.string().max(500),
});

export type InsightCoverageRecord = z.infer<typeof InsightCoverageRecordSchema>;

export const InsightProgressRecordSchema = z.strictObject({
  ...base,
  studentId: identifier,
  classSessionId: z.uuid(),
  activityId: z.uuid(),
  progressVersion: z.number().int().nonnegative(),
  declaredComplete: z.boolean(),
  evidence: z.array(CriterionEvidenceSchema).max(12),
  recordedAt: timestamp,
});

export const InsightRemovalSchema = z.strictObject({
  ...base,
  studentId: identifier,
  removedAt: timestamp,
  reason: z.string().max(200),
});

export const InsightIdentitySchema = z.strictObject({
  classId: z.uuid(),
  studentId: identifier.nullable(),
  window: InsightWindowSchema,
  sourceRevision: InsightRevisionSchema,
  privacyRevision: InsightRevisionSchema,
  coverageRevision: InsightRevisionSchema,
  derivationVersion: z.string().min(1).max(100),
  planIds: z.array(z.uuid()).max(1000),
  mappingIds: z.array(z.uuid()).max(1000),
  planVersions: z.array(z.strictObject({ id: z.uuid(), version: revision })).max(1000),
  mappingVersions: z.array(z.strictObject({ id: z.uuid(), version: revision })).max(1000),
});

export type InsightIdentity = z.infer<typeof InsightIdentitySchema>;

export const CriterionCountsSchema = z
  .strictObject({
    met: z.number().int().nonnegative(),
    needsChanges: z.number().int().nonnegative(),
    insufficient: z.number().int().nonnegative(),
    notChecked: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    sourceIds,
  })
  .refine(
    (value) =>
      value.total ===
      value.met +
        value.needsChanges +
        value.insufficient +
        value.notChecked +
        value.conflict +
        value.removed,
    'All criterion states must be accounted for.',
  );

export type CriterionCounts = z.infer<typeof CriterionCountsSchema>;

export const InsightStudentProgressSchema = z.strictObject({
  identity: InsightIdentitySchema,
  studentId: identifier,
  name: z.string().max(200),
  coverage: z.enum(InsightCoverage),
  coverageReason: z.string().max(500),
  handedIn: z.number().int().nonnegative(),
  assigned: z.number().int().nonnegative().nullable(),
  independentTasks: z.number().int().nonnegative(),
  sessions: z
    .array(
      z.strictObject({
        classSessionId: z.uuid(),
        observedAt: timestamp,
        counts: CriterionCountsSchema,
      }),
    )
    .max(1000),
  assessments: z.array(InsightAssessmentSchema).max(30000),
  submissions: z.array(InsightSubmissionSchema).max(30000),
  support: z.array(InsightSupportSchema).max(1000),
  nextTask: InsightNextTaskSchema.nullable(),
  comparisons: z
    .array(
      z.strictObject({
        skillId: z.uuid(),
        title: z.string().max(200),
        standardRevisionId: z.uuid(),
        comparisonGroupId: z.uuid(),
        scoringRevisionId: z.uuid(),
        assistance: z.enum(AssistanceContext),
        individual: z.boolean().nullable(),
        assessmentIds: z.array(z.uuid()).max(1000),
      }),
    )
    .max(1000),
  delayedChecks: z
    .array(
      z.strictObject({
        assessmentId: z.uuid(),
        priorEpisodeId: z.uuid(),
        delayDays: z.number().nonnegative().nullable(),
      }),
    )
    .max(1000),
});

export type InsightStudentProgress = z.infer<typeof InsightStudentProgressSchema>;

export const InsightClassSummarySchema = z.strictObject({
  identity: InsightIdentitySchema,
  coverage: z.enum(InsightCoverage),
  eligible: z.number().int().nonnegative().nullable(),
  checked: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative().nullable(),
  criteria: z
    .array(
      z.strictObject({
        criterionId: z.uuid(),
        description: z.string().max(500),
        counts: CriterionCountsSchema,
      }),
    )
    .max(1000),
  students: z
    .array(
      z.strictObject({
        id: identifier,
        name: z.string().max(200),
        checked: z.boolean(),
        needsChanges: z.boolean(),
      }),
    )
    .max(200),
  openSupport: z.array(InsightSupportSchema).max(1000),
});

export type InsightClassSummary = z.infer<typeof InsightClassSummarySchema>;

export const ParentReportFactSchema = z.strictObject({
  id: identifier,
  text: z.string().min(1).max(2000),
  sourceIds,
});

export const ParentReportSchema = z
  .strictObject({
    ...base,
    classId: z.uuid(),
    studentId: identifier,
    studentName: z.string().max(200),
    identity: InsightIdentitySchema,
    facts: z.array(ParentReportFactSchema).max(100),
    sessions: z
      .array(
        z.strictObject({
          classSessionId: z.uuid(),
          observedAt: timestamp,
          counts: CriterionCountsSchema,
        }),
      )
      .max(1000),
    commentary: z.string().max(InsightLimits.MAX_COMMENTARY),
    status: z.enum(ReportStatus),
    createdBy: identifier,
    createdAt: timestamp,
    approvedBy: identifier.nullable(),
    approvedAt: timestamp.nullable(),
    sourceIds,
    invalidationReason: z.string().max(500).nullable(),
  })
  .refine(
    (value) =>
      value.identity.classId === value.classId &&
      value.identity.studentId === value.studentId &&
      (value.status !== ReportStatus.APPROVED ||
        (value.approvedBy !== null &&
          value.approvedAt !== null &&
          value.invalidationReason === null)) &&
      (value.status !== ReportStatus.DRAFT ||
        (value.approvedBy === null && value.approvedAt === null)) &&
      value.facts.every((fact) => fact.sourceIds.every((id) => value.sourceIds.includes(id))),
    'Reports must bind the child, sourced facts and exact approval state.',
  );

export type ParentReport = z.infer<typeof ParentReportSchema>;

export const InsightRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(InsightRecordKind.ASSESSMENT), value: InsightAssessmentSchema }),
  z.strictObject({ kind: z.literal(InsightRecordKind.PLAN), value: InsightPlanSchema }),
  z.strictObject({ kind: z.literal(InsightRecordKind.MAPPING), value: InsightMappingSchema }),
  z.strictObject({ kind: z.literal(InsightRecordKind.SUBMISSION), value: InsightSubmissionSchema }),
  z.strictObject({ kind: z.literal(InsightRecordKind.SUPPORT), value: InsightSupportSchema }),
  z.strictObject({ kind: z.literal(InsightRecordKind.NEXT_TASK), value: InsightNextTaskSchema }),
  z.strictObject({ kind: z.literal(InsightRecordKind.REPORT), value: ParentReportSchema }),
  z.strictObject({
    kind: z.literal(InsightRecordKind.COVERAGE),
    value: InsightCoverageRecordSchema,
  }),
  z.strictObject({
    kind: z.literal(InsightRecordKind.PROGRESS),
    value: InsightProgressRecordSchema,
  }),
  z.strictObject({ kind: z.literal(InsightRecordKind.REMOVAL), value: InsightRemovalSchema }),
]);

export type InsightRecord = z.infer<typeof InsightRecordSchema>;

export const LearningEventSchema = z.strictObject({
  id: z.uuid(),
  classId: z.uuid(),
  revision: InsightRevisionSchema,
  schemaVersion: z.literal(1),
  sourceId: identifier,
  actorId: identifier,
  imported: z.boolean(),
  recordedAt: timestamp,
  record: InsightRecordSchema,
});

export type LearningEvent = z.infer<typeof LearningEventSchema>;

export const InsightSourcePacketSchema = z.strictObject({
  classId: z.uuid(),
  className: z.string().max(200),
  teacherId: identifier,
  sourceRevision: InsightRevisionSchema,
  privacyRevision: InsightRevisionSchema,
  window: InsightWindowSchema,
  coverage: InsightCoverageRecordSchema,
  students: z
    .array(z.strictObject({ id: identifier, name: z.string().max(200), enrolled: z.boolean() }))
    .max(200),
  activities: z
    .array(
      z.strictObject({
        id: z.uuid(),
        title: z.string().max(200),
        courseRevisionId: z.uuid(),
        criteria: z.array(InsightCriterionSchema).max(100),
      }),
    )
    .max(1000),
  plans: z.array(InsightPlanSchema).max(1000),
  mappings: z.array(InsightMappingSchema).max(1000),
  assessments: z.array(InsightAssessmentSchema).max(30000),
  submissions: z.array(InsightSubmissionSchema).max(30000),
  support: z.array(InsightSupportSchema).max(1000),
  nextTasks: z.array(InsightNextTaskSchema).max(1000),
  removedStudentIds: z.array(identifier).max(200),
});

export type InsightSourcePacket = z.infer<typeof InsightSourcePacketSchema>;
const scope = { classId: z.uuid() };
const write = { ...scope, requestId: z.uuid() };
const binding = { participationId: z.uuid(), deviceId: z.uuid(), activityId: z.uuid() };
const assessmentInput = {
  id: z.uuid(),
  studentId: identifier,
  classSessionId: z.uuid(),
  activityId: z.uuid(),
  episodeId: z.uuid(),
  mappingId: z.uuid(),
  mappingVersion: z.number().int().positive(),
  taskVariantId: z.uuid(),
  purpose: z.enum(AssessmentPurpose),
  assistance: z.enum(AssistanceContext),
  individual: z.boolean(),
  unaidedConfirmed: z.boolean(),
  observedAt: timestamp,
  checkId: z.uuid().nullable(),
  priorEpisodeId: z.uuid().nullable(),
  supersedesId: z.uuid().nullable(),
  results: z.array(PracticeCriterionResultSchema).min(1).max(8),
};
export const ClassroomInsightCommandSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('status'), ...scope }),
    z.strictObject({
      kind: z.literal('read-class-insights'),
      ...scope,
      window: InsightWindowSchema,
      classSessionId: z.uuid().optional(),
    }),
    z.strictObject({
      kind: z.literal('read-student-progress'),
      ...scope,
      studentId: identifier,
      window: InsightWindowSchema,
    }),
    z.strictObject({
      kind: z.literal('read-evidence'),
      ...scope,
      studentId: identifier,
      assessmentId: z.uuid(),
    }),
    z.strictObject({
      kind: z.literal('read-source-page'),
      ...scope,
      studentId: identifier.optional(),
      window: InsightWindowSchema,
      cutoff: InsightRevisionSchema,
      cursor: z.string().min(1).max(2000).optional(),
      limit: z.number().int().min(1).max(InsightLimits.PAGE_SIZE),
    }),
    z.strictObject({
      kind: z.literal('approve-plan'),
      ...write,
      id: z.uuid(),
      expectedVersion: z.number().int().nonnegative(),
      courseRevisionId: z.uuid(),
      classSessionId: z.uuid().nullable().optional(),
      title: z.string().min(1).max(200),
      activityIds: z.array(z.uuid()).min(1).max(1000),
      studentIds: z.array(identifier).max(200),
    }),
    z.strictObject({
      kind: z.literal('approve-mapping'),
      ...write,
      id: z.uuid(),
      expectedVersion: z.number().int().nonnegative(),
      skillId: z.uuid(),
      standardRevisionId: z.uuid(),
      title: z.string().min(1).max(200),
      criterionIds: z.array(z.uuid()).min(1).max(100),
      variants: z.array(InsightTaskVariantSchema).min(1).max(20),
    }),
    z.strictObject({
      kind: z.literal('select-next-task'),
      ...write,
      id: z.uuid(),
      studentId: identifier,
      activityId: z.uuid(),
      courseRevisionId: z.uuid(),
      expectedVersion: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal('record-assessment'),
      ...write,
      ...assessmentInput,
      expectedVersion: z.number().int().nonnegative(),
    }),
    z.strictObject({
      kind: z.literal('request-help'),
      ...write,
      ...binding,
      id: z.uuid(),
      criterionId: z.uuid().nullable(),
      checkId: z.uuid().optional(),
      category: z.string().min(1).max(200),
    }),
    z.strictObject({
      kind: z.literal('record-support'),
      ...write,
      id: z.uuid(),
      expectedVersion: z.number().int().positive(),
      type: z.enum(AssistanceContext),
      note: z.string().max(1000),
    }),
    z.strictObject({
      kind: z.literal('close-help'),
      ...write,
      id: z.uuid(),
      expectedVersion: z.number().int().positive(),
      reportedOutcome: z.string().max(1000),
    }),
    z.strictObject({
      kind: z.literal('create-parent-report'),
      ...write,
      id: z.uuid(),
      studentId: identifier,
      window: InsightWindowSchema,
    }),
    z.strictObject({ kind: z.literal('read-parent-report'), ...scope, id: z.uuid() }),
    z.strictObject({
      kind: z.literal('edit-parent-report'),
      ...write,
      id: z.uuid(),
      expectedVersion: z.number().int().positive(),
      commentary: z.string().max(InsightLimits.MAX_COMMENTARY),
    }),
    z.strictObject({
      kind: z.literal('approve-parent-report'),
      ...write,
      id: z.uuid(),
      expectedVersion: z.number().int().positive(),
    }),
    z.strictObject({
      kind: z.literal('export-parent-report'),
      ...write,
      id: z.uuid(),
      expectedVersion: z.number().int().positive(),
    }),
    z.strictObject({
      kind: z.literal('remove-student-sources'),
      ...write,
      studentId: identifier,
      confirmation: z.literal('remove-learning-history'),
    }),
  ])
  .superRefine((value, context) => {
    if (
      value.kind === 'approve-plan' &&
      (new Set(value.activityIds).size !== value.activityIds.length ||
        new Set(value.studentIds).size !== value.studentIds.length)
    ) {
      context.addIssue({ code: 'custom', message: 'Assignments must be unique.' });
    }
    if (
      value.kind === 'approve-mapping' &&
      (new Set(value.criterionIds).size !== value.criterionIds.length ||
        new Set(value.variants.map((variant) => variant.id)).size !== value.variants.length ||
        value.variants.some((variant) =>
          variant.criterionIds.some((id) => !value.criterionIds.includes(id)),
        ))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Variants must use unique approved mapping criteria.',
      });
    }
    if (
      value.kind === 'record-assessment' &&
      (new Set(value.results.map((result) => result.criterionId)).size !== value.results.length ||
        (value.unaidedConfirmed &&
          (value.assistance !== AssistanceContext.UNAIDED || !value.individual)))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Results must be unique and unaided confirmation must be individual.',
      });
    }
  });

export type ClassroomInsightCommand = z.infer<typeof ClassroomInsightCommandSchema>;

export const ClassroomInsightReplySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('status'),
    enabled: z.boolean(),
    teacher: z.boolean(),
    students: z.array(z.strictObject({ id: identifier, name: z.string().max(200) })).max(200),
    activities: InsightSourcePacketSchema.shape.activities,
    plans: z.array(InsightPlanSchema).max(1000),
    mappings: z.array(InsightMappingSchema).max(1000),
  }),
  z.strictObject({ kind: z.literal('class-insights'), summary: InsightClassSummarySchema }),
  z.strictObject({ kind: z.literal('student-progress'), progress: InsightStudentProgressSchema }),
  z.strictObject({
    kind: z.literal('evidence'),
    evidence: z.array(PracticeEvidenceSchema).min(1).max(3),
  }),
  z.strictObject({
    kind: z.literal('source-page'),
    events: z.array(LearningEventSchema).max(50),
    cutoff: InsightRevisionSchema,
    nextCursor: z.string().min(1).max(2000).nullable(),
  }),
  z.strictObject({ kind: z.literal('saved'), record: InsightRecordSchema }),
  z.strictObject({ kind: z.literal('parent-report'), report: ParentReportSchema }),
  z.strictObject({ kind: z.literal('export'), report: ParentReportSchema, acceptedAt: timestamp }),
  z.strictObject({ kind: z.literal('removed'), privacyRevision: InsightRevisionSchema }),
  z.strictObject({ kind: z.literal('failed'), code: z.enum(InsightFailure) }),
]);

export type ClassroomInsightReply = z.infer<typeof ClassroomInsightReplySchema>;

export const ParentReportExportCommandSchema = z.strictObject({
  classId: z.uuid(),
  reportId: z.uuid(),
  expectedVersion: z.number().int().positive(),
});

export type ParentReportExportCommand = z.infer<typeof ParentReportExportCommandSchema>;

export const ParentReportExportReplySchema = z.strictObject({
  saved: z.boolean(),
  code: z.enum(InsightFailure).nullable(),
});

export type ParentReportExportReply = z.infer<typeof ParentReportExportReplySchema>;
