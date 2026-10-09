import { describe, expect, it } from 'vitest';
import { PracticeFinding } from '#contracts/PracticeCheck.js';
import { selectLearningEvidence } from '../../../../../src/server/features/classroom/domain/SelectLearningEvidence.js';
import { createAssessment, createInsightPacket, insightId } from './ClassroomInsightFixtures.js';

describe('selectLearningEvidence', () => {
  it('replays revisions beyond safe integer precision and excludes future corrections', () => {
    const original = createAssessment({ sourceRevision: '9007199254740993' });
    const correction = createAssessment({
      id: insightId(101),
      sourceRevision: '9007199254740994',
      supersedesId: original.id,
      results: [],
    });
    const selected = selectLearningEvidence(
      createInsightPacket({
        sourceRevision: original.sourceRevision,
        assessments: [correction, original],
      }),
      'child',
    );
    expect(selected.map((value) => value.assessment.id)).toEqual([original.id]);
  });

  it('resolves explicit correction chains but retains sibling finding conflicts', () => {
    const original = createAssessment();
    const correction = createAssessment({
      id: insightId(101),
      sourceRevision: '3',
      supersedesId: original.id,
      results: [
        {
          criterionId: insightId(9),
          finding: PracticeFinding.NEEDS_CHANGES,
          feedback: 'Corrected',
          evidenceIds: [insightId(60)],
        },
      ],
    });
    expect(
      selectLearningEvidence(
        createInsightPacket({ assessments: [original, correction] }),
        'child',
      ).map((value) => value.assessment.id),
    ).toEqual([correction.id]);
    const conflict = selectLearningEvidence(
      createInsightPacket({ assessments: [original, { ...correction, supersedesId: null }] }),
      'child',
    );
    expect(conflict[0]?.conflictingCriterionIds).toEqual([insightId(9)]);
  });

  it('refuses correction cycles and never uses another student to supersede evidence', () => {
    const original = createAssessment({ supersedesId: insightId(101) });
    const correction = createAssessment({ id: insightId(101), supersedesId: original.id });
    expect(() =>
      selectLearningEvidence(createInsightPacket({ assessments: [original, correction] }), 'child'),
    ).toThrow('invalid');
    expect(
      selectLearningEvidence(
        createInsightPacket({
          assessments: [
            createAssessment(),
            createAssessment({
              id: insightId(101),
              studentId: 'other',
              supersedesId: insightId(100),
            }),
          ],
        }),
        'child',
      ),
    ).toHaveLength(1);
  });

  it('purges all learner evidence when privacy removal applies', () => {
    expect(
      selectLearningEvidence(createInsightPacket({ removedStudentIds: ['child'] }), 'child'),
    ).toEqual([]);
  });
});
