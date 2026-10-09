import { PracticeVerification, PracticeCapability } from '#contracts/PracticeAssessment.js';
import type { PracticeEvaluation } from '#contracts/PracticeCheck.js';
import { readPracticeMessages } from '../../../localization/PracticeMessages.js';
import { checkPracticeEvidence } from '../domain/CheckPracticeEvidence.js';
import type {
  CriterionEvaluationInput,
  PracticeCriterionEvaluator,
} from './PracticeCriterionEvaluator.js';

export class ScratchStructureEvaluator implements PracticeCriterionEvaluator {
  readonly id = PracticeVerification.SCRATCH_STRUCTURE;
  readonly version = 'connected-next-chain-v1';
  readonly available = true;
  supports(input: CriterionEvaluationInput): boolean {
    return input.rubric.criteria.every((criterion) => criterion.verification?.kind === this.id);
  }
  evaluate(input: CriterionEvaluationInput, signal: AbortSignal): Promise<PracticeEvaluation> {
    signal.throwIfAborted();
    return Promise.resolve({
      results: input.rubric.criteria.map((criterion) => ({
        criterionId: criterion.id,
        ...checkPracticeEvidence(
          criterion,
          input.prepared.units.filter((unit) =>
            input.prepared.capabilities
              .get(unit.evidenceId)
              ?.includes(PracticeCapability.PROJECT_STRUCTURE),
          ),
        ),
        feedback: readPracticeMessages(input.locale).scratchStructureFeedback,
      })),
    });
  }
}
