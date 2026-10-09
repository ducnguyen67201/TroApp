import {
  AssistanceContext,
  AssessmentMethod,
  AssessmentPurpose,
  InsightCoverage,
  type InsightAssessment,
  type InsightSourcePacket,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus, PracticeFinding } from '#contracts/PracticeCheck.js';

export function insightId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

export function createAssessment(overrides: Partial<InsightAssessment> = {}): InsightAssessment {
  return {
    id: insightId(100),
    version: 1,
    sourceRevision: '2',
    studentId: 'child',
    classSessionId: insightId(2),
    activityId: insightId(3),
    episodeId: insightId(4),
    episodeOrder: 1,
    snapshotId: insightId(5),
    checkId: insightId(6),
    title: 'Stop the robot',
    task: 'Explain why it stops.',
    courseRevisionId: insightId(7),
    rubricRevisionId: insightId(8),
    criteria: [{ id: insightId(9), description: 'Explain the stop condition', required: true }],
    results: [
      {
        criterionId: insightId(9),
        finding: PracticeFinding.MET,
        feedback: 'Observed',
        evidenceIds: [insightId(60)],
      },
    ],
    status: PracticeCheckStatus.COMPLETED,
    method: AssessmentMethod.TEACHER,
    evaluatorRevision: null,
    purpose: AssessmentPurpose.FRESH,
    assistance: AssistanceContext.UNAIDED,
    individual: true,
    unaidedConfirmed: true,
    authorId: 'teacher',
    mappingId: insightId(20),
    mappingVersion: 1,
    taskVariantId: insightId(23),
    priorEpisodeId: null,
    supersedesId: null,
    observedAt: '2026-10-02T10:00:00Z',
    recordedAt: '2026-10-02T10:01:00Z',
    sourceIds: ['evidence'],
    ...overrides,
  };
}

export function createInsightPacket(
  overrides: Partial<InsightSourcePacket> = {},
): InsightSourcePacket {
  return {
    classId: insightId(1),
    className: 'Robotics',
    teacherId: 'teacher',
    sourceRevision: '100',
    privacyRevision: '0',
    window: { from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z', timezone: 'UTC' },
    coverage: {
      id: insightId(30),
      version: 1,
      sourceRevision: '1',
      status: InsightCoverage.COMPLETE,
      captureStartedAt: '2026-10-01T00:00:00Z',
      importedThrough: null,
      reason: 'Capture enabled.',
    },
    students: [
      { id: 'child', name: 'Mai', enrolled: true },
      { id: 'other', name: 'An', enrolled: true },
    ],
    activities: [
      {
        id: insightId(3),
        title: 'Stop the robot',
        courseRevisionId: insightId(7),
        criteria: [{ id: insightId(9), description: 'Explain the stop condition', required: true }],
      },
    ],
    plans: [
      {
        id: insightId(10),
        version: 1,
        sourceRevision: '1',
        courseRevisionId: insightId(7),
        classSessionId: null,
        title: 'Robot course',
        activityIds: [insightId(3)],
        studentIds: ['child', 'other'],
        completionRule: 'hand_in',
        approvedBy: 'teacher',
        approvedAt: '2026-10-01T00:00:00Z',
      },
    ],
    mappings: [
      {
        id: insightId(20),
        version: 1,
        sourceRevision: '1',
        skillId: insightId(21),
        standardRevisionId: insightId(22),
        title: 'Stop conditions',
        criterionIds: [insightId(9)],
        variants: [
          {
            id: insightId(23),
            title: 'Stop variant',
            task: 'Explain stop condition',
            criterionIds: [insightId(9)],
            comparisonGroupId: insightId(24),
            scoringRevisionId: insightId(25),
          },
        ],
        approvedBy: 'teacher',
        approvedAt: '2026-10-01T00:00:00Z',
      },
    ],
    assessments: [createAssessment()],
    submissions: [],
    support: [],
    nextTasks: [],
    removedStudentIds: [],
    ...overrides,
  };
}
