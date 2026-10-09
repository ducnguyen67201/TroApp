import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { evaluatePracticeJudge, type PracticeJudgmentCase } from './PracticeEvaluationSuite.js';
import { createPracticeCheckpoint } from '../PracticeFixtures.js';

it('reports dangerous false passes separately from agreement and missing evidence', async () => {
  const rubric = createPracticeCheckpoint();
  const reference: PracticeJudgmentCase = {
    id: 'synthetic-unverified-runtime',
    rubric,
    grounding: {
      courseRevisionId: randomUUID(),
      teacherInstructions: '',
      sources: [],
      missingSourceIds: [],
    },
    evidence: [
      { id: randomUUID(), kind: 'text', name: 'Claim.txt', text: 'I ran it successfully.' },
    ],
    expected: rubric.criteria.map((criterion) => ({
      criterionId: criterion.id,
      finding: 'insufficient_evidence',
    })),
  };
  const metrics = await evaluatePracticeJudge(
    {
      available: true,
      version: 'deliberately-wrong-fixture',
      evaluate: () =>
        Promise.resolve({
          results: rubric.criteria.map((criterion) => ({
            criterionId: criterion.id,
            finding: 'met',
            evidenceIds: [],
            feedback: 'Unjustified success',
          })),
        }),
    },
    [reference],
    new AbortController().signal,
  );
  expect(metrics).toEqual({
    criteria: 2,
    disagreements: 2,
    falsePasses: 2,
    invalidCitations: 2,
    missingResults: 0,
  });
});
