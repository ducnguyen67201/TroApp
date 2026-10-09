import { PracticeVerification } from '#contracts/PracticeAssessment.js';
import type { PracticeEvaluation } from '#contracts/PracticeCheck.js';
import type { PracticeCheckEvaluator } from '../application/PracticeCheckEvaluator.js';
import type {
  CriterionEvaluationInput,
  PracticeCriterionEvaluator,
} from '../application/PracticeCriterionEvaluator.js';

/** Adapts the existing provider port, retaining one bounded batch request. */
export class LlmCriterionEvaluator implements PracticeCriterionEvaluator {
  readonly id = PracticeVerification.LLM;
  constructor(private readonly provider: PracticeCheckEvaluator) {}
  get version(): string {
    return this.provider.version;
  }
  get available(): boolean {
    return this.provider.available;
  }
  supports(input: CriterionEvaluationInput): boolean {
    return input.rubric.criteria.every(
      (criterion) => !criterion.verification || criterion.verification.kind === this.id,
    );
  }
  evaluate(input: CriterionEvaluationInput, signal: AbortSignal): Promise<PracticeEvaluation> {
    return this.provider.evaluate(input.rubric, input.prepared.evidence, input.locale, signal, {
      grounding: input.grounding,
      units: input.prepared.units,
    });
  }
}
