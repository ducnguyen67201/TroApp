import {
  PracticeFinding,
  PracticeFailure,
  type PracticeCheckpoint,
  type PracticeEvaluation,
} from '#contracts/PracticeCheck.js';
export class PracticeError extends Error {
  constructor(readonly code: (typeof PracticeFailure)[keyof typeof PracticeFailure]) {
    super(code);
  }
}

/** Only the server aggregates findings. Missing/foreign evidence can never produce a pass. */
export function validatePracticeFindings(
  rubric: PracticeCheckpoint,
  evaluation: PracticeEvaluation,
  evidenceIds: readonly string[],
): PracticeFinding {
  const ids = new Set(evaluation.results.map((result) => result.criterionId));
  if (
    ids.size !== rubric.criteria.length ||
    evaluation.results.length !== rubric.criteria.length ||
    evaluation.results.some(
      (result) =>
        !rubric.criteria.some((criterion) => criterion.id === result.criterionId) ||
        result.evidenceIds.some((id) => !evidenceIds.includes(id)) ||
        (result.finding !== PracticeFinding.INSUFFICIENT_EVIDENCE &&
          result.evidenceIds.length === 0),
    )
  ) {
    throw new PracticeError(PracticeFailure.INVALID);
  }
  const required = evaluation.results.filter((result) =>
    rubric.criteria.some((criterion) => criterion.id === result.criterionId && criterion.required),
  );
  if (required.some((result) => result.finding === PracticeFinding.NEEDS_CHANGES)) {
    return PracticeFinding.NEEDS_CHANGES;
  }
  if (required.some((result) => result.finding === PracticeFinding.INSUFFICIENT_EVIDENCE)) {
    return PracticeFinding.INSUFFICIENT_EVIDENCE;
  }
  return PracticeFinding.MET;
}
