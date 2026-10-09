import type {
  PracticeCheckpoint,
  PracticeEvidence,
  PracticeFinding,
} from '#contracts/PracticeCheck.js';
import type { PracticeGrounding } from '#contracts/PracticeAssessment.js';
import type { PracticeCheckEvaluator } from '../../../../../src/server/features/classroom/application/PracticeCheckEvaluator.js';

/** Offline quality runner. Reference labels must be independently reviewed before release gating. */
export interface PracticeJudgmentCase {
  id: string;
  rubric: PracticeCheckpoint;
  evidence: PracticeEvidence[];
  grounding: PracticeGrounding;
  expected: { criterionId: string; finding: PracticeFinding }[];
}

export async function evaluatePracticeJudge(
  evaluator: PracticeCheckEvaluator,
  cases: readonly PracticeJudgmentCase[],
  signal: AbortSignal,
): Promise<{
  criteria: number;
  disagreements: number;
  falsePasses: number;
  invalidCitations: number;
  missingResults: number;
}> {
  const summary = {
    criteria: 0,
    disagreements: 0,
    falsePasses: 0,
    invalidCitations: 0,
    missingResults: 0,
  };
  for (const item of cases) {
    signal.throwIfAborted();
    const reply = await evaluator.evaluate(item.rubric, item.evidence, 'en', signal, {
      grounding: item.grounding,
      units: [],
    });
    const evidenceIds = new Set(item.evidence.map((evidence) => evidence.id));
    for (const expected of item.expected) {
      summary.criteria += 1;
      const results = reply.results.filter((result) => result.criterionId === expected.criterionId);
      const actual = results[0];
      if (results.length !== 1 || !actual) {
        summary.missingResults += 1;
      }
      if (actual?.finding !== expected.finding) {
        summary.disagreements += 1;
      }
      if (actual?.finding === 'met' && expected.finding !== 'met') {
        summary.falsePasses += 1;
      }
    }
    summary.invalidCitations += reply.results.filter(
      (result) =>
        result.evidenceIds.some((id) => !evidenceIds.has(id)) ||
        (result.finding === 'met' && result.evidenceIds.length === 0),
    ).length;
  }
  return summary;
}
