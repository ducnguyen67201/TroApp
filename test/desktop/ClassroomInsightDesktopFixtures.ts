import { randomUUID } from 'node:crypto';
import {
  ReportStatus,
  type CriterionCounts,
  type InsightIdentity,
  type InsightStudentProgress,
  type ParentReport,
  type InsightAssessment,
  type InsightMapping,
  type ClassroomInsightReply,
} from '#contracts/ClassroomInsights.js';

export const insightClassId = '11111111-1111-4111-8111-111111111111';

export const insightSessionId = '22222222-2222-4222-8222-222222222222';

export const insightWindow = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-08T23:59:59.999Z',
  timezone: 'UTC',
};

export function createInsightIdentity(studentId: string | null = 'minh'): InsightIdentity {
  return {
    classId: insightClassId,
    studentId,
    window: insightWindow,
    sourceRevision: '4',
    privacyRevision: '0',
    coverageRevision: '1',
    derivationVersion: 'classroom-insights-v1',
    planIds: [],
    mappingIds: [],
    planVersions: [],
    mappingVersions: [],
  };
}

export function createCriterionCounts(): CriterionCounts {
  return {
    met: 2,
    needsChanges: 0,
    insufficient: 0,
    notChecked: 1,
    conflict: 0,
    removed: 0,
    total: 3,
    sourceIds: [],
  };
}

export function createParentReport(): ParentReport {
  return {
    id: randomUUID(),
    version: 2,
    sourceRevision: '4',
    classId: insightClassId,
    studentId: 'minh',
    studentName: 'Minh',
    identity: createInsightIdentity(),
    facts: [
      {
        id: 'one',
        text: 'Minh met two criteria on the countdown task with teacher-confirmed unaided work.',
        sourceIds: [],
      },
    ],
    sessions: [
      {
        classSessionId: insightSessionId,
        observedAt: '2026-10-08T16:00:00.000Z',
        counts: createCriterionCounts(),
      },
    ],
    commentary: 'Next lesson: explain why the loop stops.',
    status: ReportStatus.APPROVED,
    createdBy: 'teacher',
    createdAt: '2026-10-08T16:10:00.000Z',
    approvedBy: 'teacher',
    approvedAt: '2026-10-08T16:20:00.000Z',
    sourceIds: [],
    invalidationReason: null,
  };
}

export function createStudentProgress(studentId = 'minh', name = 'Minh'): InsightStudentProgress {
  return {
    identity: createInsightIdentity(studentId),
    studentId,
    name,
    coverage: 'partial',
    coverageReason: 'Earlier work is not captured.',
    handedIn: 1,
    assigned: null,
    independentTasks: 1,
    sessions: [
      {
        classSessionId: insightSessionId,
        observedAt: '2026-10-08T16:00:00.000Z',
        counts: createCriterionCounts(),
      },
    ],
    assessments: [],
    submissions: [],
    support: [],
    nextTask: null,
    comparisons: [],
    delayedChecks: [],
  };
}

export function createInsightAssessment(): InsightAssessment {
  const criteria = [
    { id: randomUUID(), description: 'Update the counter', required: true },
    { id: randomUUID(), description: 'Stop the loop at zero', required: true },
    { id: randomUUID(), description: 'Explain the result', required: false },
  ];
  return {
    id: randomUUID(),
    version: 1,
    sourceRevision: '4',
    studentId: 'minh',
    classSessionId: insightSessionId,
    activityId: randomUUID(),
    episodeId: randomUUID(),
    episodeOrder: 1,
    snapshotId: randomUUID(),
    checkId: randomUUID(),
    title: 'Countdown challenge',
    task: 'Count down from a new starting value.',
    courseRevisionId: randomUUID(),
    rubricRevisionId: randomUUID(),
    criteria,
    results: criteria.slice(0, 2).map((criterion) => ({
      criterionId: criterion.id,
      finding: 'met',
      feedback: 'The saved task shows this criterion.',
      evidenceIds: [],
    })),
    status: 'completed',
    method: 'teacher',
    evaluatorRevision: null,
    purpose: 'fresh',
    assistance: 'unaided',
    individual: true,
    unaidedConfirmed: true,
    authorId: 'teacher',
    mappingId: randomUUID(),
    mappingVersion: 1,
    taskVariantId: randomUUID(),
    priorEpisodeId: null,
    supersedesId: null,
    observedAt: '2026-10-08T16:00:00.000Z',
    recordedAt: '2026-10-08T16:10:00.000Z',
    sourceIds: [],
  };
}

export function createSkillMapping(assessment: InsightAssessment): InsightMapping {
  return {
    id: assessment.mappingId ?? randomUUID(),
    version: 1,
    sourceRevision: '2',
    skillId: randomUUID(),
    standardRevisionId: randomUUID(),
    title: 'Loop reasoning',
    criterionIds: assessment.criteria.map((criterion) => criterion.id),
    variants: [
      {
        id: assessment.taskVariantId ?? randomUUID(),
        title: assessment.title,
        task: assessment.task,
        criterionIds: assessment.criteria.map((criterion) => criterion.id),
        comparisonGroupId: randomUUID(),
        scoringRevisionId: randomUUID(),
      },
    ],
    approvedBy: 'teacher',
    approvedAt: '2026-10-01T16:00:00.000Z',
  };
}

export function createInsightStatus(
  assessment: InsightAssessment,
): Extract<ClassroomInsightReply, { kind: 'status' }> {
  return {
    kind: 'status',
    enabled: true,
    teacher: true,
    students: [{ id: 'minh', name: 'Minh' }],
    activities: [
      {
        id: assessment.activityId,
        title: assessment.title,
        courseRevisionId: assessment.courseRevisionId,
        criteria: assessment.criteria,
      },
    ],
    plans: [],
    mappings: [createSkillMapping(assessment)],
  };
}
