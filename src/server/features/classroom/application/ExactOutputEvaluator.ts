import { PracticeVerification } from '#contracts/PracticeAssessment.js';
import type { PracticeEvaluation } from '#contracts/PracticeCheck.js';
import { readPracticeMessages } from '../../../localization/PracticeMessages.js';
import { checkPracticeEvidence } from '../domain/CheckPracticeEvidence.js';
import type {
  CriterionEvaluationInput,
  PracticeCriterionEvaluator,
} from './PracticeCriterionEvaluator.js';

export class ExactOutputEvaluator implements PracticeCriterionEvaluator {
  readonly id: string = PracticeVerification.EXACT_OUTPUT;
  readonly version = 'supplied-text-v1';
  readonly available = true;
  supports(input: CriterionEvaluationInput): boolean {
    return input.rubric.criteria.every((criterion) => criterion.verification?.kind === this.id);
  }
  evaluate(input: CriterionEvaluationInput, signal: AbortSignal): Promise<PracticeEvaluation> {
    signal.throwIfAborted();
    return Promise.resolve({
      results: input.rubric.criteria.map((criterion) => ({
        criterionId: criterion.id,
        ...checkPracticeEvidence(criterion, input.prepared.units),
        feedback: readPracticeMessages(input.locale).exactOutputFeedback,
      })),
    });
  }
}
