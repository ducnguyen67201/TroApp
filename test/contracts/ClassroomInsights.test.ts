import { describe, expect, it } from 'vitest';
import {
  AssistanceContext,
  AssessmentMethod,
  AssessmentPurpose,
  ClassroomInsightCommandSchema,
  CriterionCountsSchema,
  InsightAssessmentSchema,
  InsightRevisionSchema,
  InsightWindowSchema,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus, PracticeFinding } from '#contracts/PracticeCheck.js';

function insightId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function createAssessment() {
  return InsightAssessmentSchema.parse({
    id: insightId(1),
    version: 1,
    sourceRevision: '1',
    studentId: 'student',
    classSessionId: insightId(2),
    activityId: insightId(3),
    episodeId: insightId(4),
    episodeOrder: null,
    snapshotId: null,
    checkId: null,
    title: 'Loop task',
    task: 'Explain when the loop stops.',
    courseRevisionId: insightId(5),
    rubricRevisionId: null,
    criteria: [
      { id: insightId(6), description: 'Explain the stopping condition.', required: true },
    ],
    results: [
      {
        criterionId: insightId(6),
        finding: PracticeFinding.MET,
        feedback: 'Explained.',
        evidenceIds: [],
      },
    ],
    status: PracticeCheckStatus.COMPLETED,
    method: AssessmentMethod.TEACHER,
    evaluatorRevision: null,
    purpose: AssessmentPurpose.FRESH,
    assistance: AssistanceContext.UNKNOWN,
    individual: null,
    unaidedConfirmed: false,
    authorId: 'teacher',
    mappingId: null,
    mappingVersion: null,
    taskVariantId: null,
    priorEpisodeId: null,
    supersedesId: null,
    observedAt: '2026-10-08T10:00:00Z',
    recordedAt: '2026-10-08T10:05:00Z',
    sourceIds: [],
  });
}

describe('classroom insight boundary invariants', () => {
  it('keeps missing help and episode order explicit and refuses unsupported independence', () => {
    const assessment = createAssessment();
    expect(assessment.episodeOrder).toBeNull();
    expect(assessment.assistance).toBe(AssistanceContext.UNKNOWN);
    expect(
      InsightAssessmentSchema.safeParse({ ...assessment, unaidedConfirmed: true }).success,
    ).toBe(false);
    expect(
      InsightAssessmentSchema.safeParse({
        ...assessment,
        unaidedConfirmed: true,
        assistance: AssistanceContext.UNAIDED,
        individual: true,
      }).success,
    ).toBe(true);
    expect(
      InsightAssessmentSchema.safeParse({
        ...assessment,
        unaidedConfirmed: true,
        assistance: AssistanceContext.UNAIDED,
        individual: true,
        method: AssessmentMethod.MODEL,
      }).success,
    ).toBe(false);
  });

  it('refuses duplicated or foreign criteria and unpinned comparison versions', () => {
    const assessment = createAssessment();
    expect(
      InsightAssessmentSchema.safeParse({
        ...assessment,
        results: [...assessment.results, ...assessment.results],
      }).success,
    ).toBe(false);
    expect(
      InsightAssessmentSchema.safeParse({
        ...assessment,
        results: [
          {
            criterionId: insightId(7),
            finding: PracticeFinding.MET,
            feedback: 'Observed.',
            evidenceIds: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      InsightAssessmentSchema.safeParse({ ...assessment, mappingId: insightId(8) }).success,
    ).toBe(false);
  });

  it('bounds revisions and reporting windows before any database call', () => {
    for (const value of ['-1', '01', '1.5', '9223372036854775808', '9'.repeat(100)]) {
      expect(InsightRevisionSchema.safeParse(value).success).toBe(false);
    }
    expect(InsightRevisionSchema.parse('9223372036854775807')).toBe('9223372036854775807');
    const window = {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-08T00:00:00Z',
      timezone: 'America/Toronto',
    };
    expect(InsightWindowSchema.safeParse(window).success).toBe(true);
    expect(InsightWindowSchema.safeParse({ ...window, timezone: 'Unknown/Zone' }).success).toBe(
      false,
    );
    expect(InsightWindowSchema.safeParse({ ...window, to: '2026-09-01T00:00:00Z' }).success).toBe(
      false,
    );
    expect(InsightWindowSchema.safeParse({ ...window, to: '2027-10-01T00:00:00Z' }).success).toBe(
      false,
    );
  });

  it('requires all chart states to reconcile to the visible denominator', () => {
    const counts = {
      met: 1,
      needsChanges: 1,
      insufficient: 1,
      notChecked: 1,
      conflict: 1,
      removed: 1,
      total: 6,
      sourceIds: [],
    };
    expect(CriterionCountsSchema.safeParse(counts).success).toBe(true);
    expect(CriterionCountsSchema.safeParse({ ...counts, total: 5 }).success).toBe(false);
  });

  it('rejects unknown fields and duplicate assignment denominators', () => {
    const command = {
      kind: 'approve-plan',
      classId: insightId(1),
      requestId: insightId(2),
      id: insightId(3),
      expectedVersion: 0,
      courseRevisionId: insightId(4),
      title: 'Lesson plan',
      activityIds: [insightId(5)],
      studentIds: ['child'],
    };
    expect(ClassroomInsightCommandSchema.safeParse(command).success).toBe(true);
    expect(
      ClassroomInsightCommandSchema.safeParse({
        ...command,
        activityIds: [insightId(5), insightId(5)],
      }).success,
    ).toBe(false);
    expect(
      ClassroomInsightCommandSchema.safeParse({ ...command, attentionScore: 90 }).success,
    ).toBe(false);
  });
});
