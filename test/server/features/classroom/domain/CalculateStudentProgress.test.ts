import { describe, expect, it } from 'vitest';
import {
  AssistanceContext,
  AssessmentPurpose,
  InsightStudentProgressSchema,
} from '#contracts/ClassroomInsights.js';
import { PracticeCheckStatus, PracticeFinding } from '#contracts/PracticeCheck.js';
import { calculateStudentProgress } from '../../../../../src/server/features/classroom/domain/CalculateStudentProgress.js';
import { createAssessment, createInsightPacket, insightId } from './ClassroomInsightFixtures.js';

describe('calculateStudentProgress', () => {
  it('separates support and task groups across six sessions without a numeric skill claim', () => {
    const assessments = [
      createAssessment({
        id: insightId(100),
        classSessionId: insightId(200),
        episodeId: insightId(300),
        episodeOrder: 1,
        purpose: AssessmentPurpose.BASELINE,
        observedAt: '2026-10-02T10:00:00Z',
        results: [
          {
            criterionId: insightId(9),
            finding: PracticeFinding.NEEDS_CHANGES,
            feedback: 'Baseline',
            evidenceIds: [insightId(60)],
          },
        ],
      }),
      createAssessment({
        id: insightId(101),
        classSessionId: insightId(201),
        episodeId: insightId(301),
        episodeOrder: 2,
        purpose: AssessmentPurpose.PRACTICE,
        assistance: AssistanceContext.HINT,
        unaidedConfirmed: false,
        observedAt: '2026-10-04T10:00:00Z',
      }),
      createAssessment({
        id: insightId(102),
        classSessionId: insightId(202),
        episodeId: insightId(302),
        episodeOrder: 3,
        observedAt: '2026-10-06T10:00:00Z',
      }),
      createAssessment({
        id: insightId(103),
        classSessionId: insightId(203),
        episodeId: insightId(303),
        episodeOrder: 4,
        purpose: AssessmentPurpose.DELAYED,
        priorEpisodeId: insightId(302),
        observedAt: '2026-10-13T10:00:00Z',
        results: [
          {
            criterionId: insightId(9),
            finding: PracticeFinding.NEEDS_CHANGES,
            feedback: 'Delayed',
            evidenceIds: [insightId(60)],
          },
        ],
      }),
      createAssessment({
        id: insightId(104),
        classSessionId: insightId(204),
        episodeId: insightId(304),
        episodeOrder: 5,
        purpose: AssessmentPurpose.TRANSFER,
        assistance: AssistanceContext.DEMONSTRATION,
        unaidedConfirmed: false,
        taskVariantId: insightId(26),
        observedAt: '2026-10-15T10:00:00Z',
      }),
      createAssessment({
        id: insightId(105),
        classSessionId: insightId(205),
        episodeId: insightId(305),
        episodeOrder: 6,
        taskVariantId: insightId(26),
        observedAt: '2026-10-17T10:00:00Z',
      }),
    ];
    const packet = createInsightPacket({ assessments });
    const mapping = packet.mappings[0];
    if (!mapping) {
      throw new Error('Fixture mapping missing');
    }
    mapping.variants.push({
      id: insightId(26),
      title: 'Sensor stop',
      task: 'Stop from sensor',
      criterionIds: [insightId(9)],
      comparisonGroupId: insightId(27),
      scoringRevisionId: insightId(25),
    });
    const progress = calculateStudentProgress(packet, 'child');
    expect(InsightStudentProgressSchema.safeParse(progress).success).toBe(true);
    expect(progress.sessions).toHaveLength(6);
    expect(progress.independentTasks).toBe(2);
    expect(progress.comparisons).toHaveLength(4);
    expect(progress.delayedChecks).toEqual([
      { assessmentId: insightId(103), priorEpisodeId: insightId(302), delayDays: 7 },
    ]);
    expect(
      calculateStudentProgress({ ...packet, assessments: [...assessments].reverse() }, 'child'),
    ).toEqual(progress);
  });

  it('pins comparisons to the recorded mapping version and leaves legacy mappings unknown', () => {
    const packet = createInsightPacket();
    const original = packet.mappings[0];
    if (!original) {
      throw new Error('Fixture mapping missing');
    }
    packet.mappings.push({
      ...original,
      version: 2,
      sourceRevision: '20',
      standardRevisionId: insightId(900),
      variants: original.variants.map((variant) => ({
        ...variant,
        comparisonGroupId: insightId(901),
      })),
    });
    const progress = calculateStudentProgress(packet, 'child');
    expect(progress.comparisons[0]?.standardRevisionId).toBe(original.standardRevisionId);
    expect(progress.comparisons[0]?.comparisonGroupId).toBe(insightId(24));
    expect(progress.identity.mappingVersions).toEqual([{ id: original.id, version: 1 }]);
    packet.assessments = [
      createAssessment({ mappingId: null, mappingVersion: null, taskVariantId: null }),
    ];
    expect(calculateStudentProgress(packet, 'child').comparisons).toEqual([]);
  });

  it('keeps individual and shared observations in separate comparison groups', () => {
    const packet = createInsightPacket({
      assessments: [
        createAssessment({
          assistance: AssistanceContext.UNKNOWN,
          individual: true,
          unaidedConfirmed: false,
        }),
        createAssessment({
          id: insightId(101),
          episodeId: insightId(301),
          episodeOrder: 2,
          assistance: AssistanceContext.UNKNOWN,
          individual: false,
          unaidedConfirmed: false,
        }),
      ],
    });
    const progress = calculateStudentProgress(packet, 'child');
    expect(progress.comparisons).toHaveLength(2);
    expect(progress.comparisons.map((comparison) => comparison.individual)).toEqual([false, true]);
    expect(progress.independentTasks).toBe(0);
  });

  it('counts repeated session assignments separately and course assignments once', () => {
    const packet = createInsightPacket();
    const coursePlan = packet.plans[0];
    if (!coursePlan) {
      throw new Error('Fixture plan missing');
    }
    packet.plans = [
      { ...coursePlan, classSessionId: insightId(2) },
      { ...coursePlan, id: insightId(11), classSessionId: insightId(12) },
    ];
    packet.submissions = [2, 12, 2, 13].map((session, index) => ({
      id: insightId(40 + index),
      version: 1,
      sourceRevision: '10',
      studentId: 'child',
      classSessionId: insightId(session),
      activityId: insightId(3),
      courseRevisionId: insightId(7),
      sourceKind: 'snapshot',
      snapshotId: insightId(50 + index),
      checkId: null,
      submittedAt: '2026-10-03T10:00:00Z',
      sourceIds: [],
    }));
    expect(calculateStudentProgress(packet, 'child')).toMatchObject({ assigned: 2, handedIn: 2 });
    packet.plans = [coursePlan];
    expect(calculateStudentProgress(packet, 'child')).toMatchObject({ assigned: 1, handedIn: 1 });
  });

  it('uses retained prior context outside the selected presentation window for delayed intervals', () => {
    const prior = createAssessment({
      id: insightId(100),
      episodeId: insightId(300),
      observedAt: '2026-10-06T10:00:00Z',
    });
    const delayed = createAssessment({
      id: insightId(101),
      episodeId: insightId(301),
      episodeOrder: 2,
      purpose: AssessmentPurpose.DELAYED,
      priorEpisodeId: prior.episodeId,
      observedAt: '2026-10-13T10:00:00Z',
    });
    const packet = createInsightPacket({
      assessments: [prior, delayed],
      window: {
        from: '2026-10-10T00:00:00Z',
        to: '2026-10-31T23:59:59Z',
        timezone: 'UTC',
      },
    });
    const progress = calculateStudentProgress(packet, 'child');
    expect(progress.assessments.map((value) => value.id)).toEqual([delayed.id]);
    expect(progress.delayedChecks).toEqual([
      { assessmentId: delayed.id, priorEpisodeId: prior.episodeId, delayDays: 7 },
    ]);
  });

  it('selects a newer unchecked episode before findings despite a late old result', () => {
    const old = createAssessment({ recordedAt: '2026-10-20T10:00:00Z' });
    const newer = createAssessment({
      id: insightId(101),
      episodeId: insightId(301),
      episodeOrder: 2,
      observedAt: '2026-10-03T10:00:00Z',
      status: PracticeCheckStatus.RUNNING,
      results: [],
      unaidedConfirmed: false,
    });
    const progress = calculateStudentProgress(
      createInsightPacket({ assessments: [old, newer] }),
      'child',
    );
    expect(progress.sessions[0]?.counts).toMatchObject({ met: 0, notChecked: 1, total: 1 });
  });

  it('preserves conflicts for incomparable episode order and unknown assigned totals', () => {
    const progress = calculateStudentProgress(
      createInsightPacket({
        plans: [],
        assessments: [
          createAssessment(),
          createAssessment({ id: insightId(101), episodeId: insightId(301), episodeOrder: null }),
        ],
      }),
      'child',
    );
    expect(progress.assigned).toBeNull();
    expect(progress.sessions[0]?.counts).toMatchObject({ met: 0, conflict: 1, total: 1 });
  });

  it('does not count missing required results or model findings as independence', () => {
    const progress = calculateStudentProgress(
      createInsightPacket({ assessments: [createAssessment({ results: [] })] }),
      'child',
    );
    expect(progress.independentTasks).toBe(0);
  });
});
