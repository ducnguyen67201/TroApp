import {
  PracticeCapability,
  PracticeVerification,
  type PracticeGrounding,
} from '#contracts/PracticeAssessment.js';
import {
  PracticeEvaluationSchema,
  PracticeFinding,
  PracticeFailure,
  PracticeLimits,
  type PracticeCheckpoint,
  type PracticeEvidence,
  type PracticeEvaluation,
} from '#contracts/PracticeCheck.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { countPracticeInput } from './PracticeEvidence.js';
import { PracticeError } from '../domain/PracticeFindings.js';
import { validatePracticeFindings } from '../domain/PracticeFindings.js';
import type { PracticeCheckEvaluator } from './PracticeCheckEvaluator.js';
import type { PracticeCriterionEvaluator } from './PracticeCriterionEvaluator.js';
import { PreparePracticeEvidence } from './PreparePracticeEvidence.js';

/** Routes only approved methods; abstains on missing capabilities and batches LLM criteria. */
export class PracticeAssessmentService implements PracticeCheckEvaluator {
  readonly available = true;
  readonly version: string;
  constructor(
    private readonly evaluators: readonly PracticeCriterionEvaluator[],
    private readonly preparation: PreparePracticeEvidence,
  ) {
    this.version =
      `assessment-v1/${evaluators.map((evaluator) => evaluator.version).join('+')}`.slice(0, 200);
  }
  async evaluate(
    rubric: PracticeCheckpoint,
    evidence: PracticeEvidence[],
    locale: DesktopLocale,
    signal: AbortSignal,
    context?: { grounding: PracticeGrounding },
  ): Promise<PracticeEvaluation> {
    if (!context) {
      throw new Error('Missing authorized class context.');
    }
    const prepared = await this.preparation.prepare(evidence, signal);
    const grounding = context.grounding;
    if (
      countPracticeInput({ rubric, grounding, units: prepared.units }, evidence) >
      PracticeLimits.INPUT_TOKENS
    ) {
      throw new PracticeError(PracticeFailure.LIMIT);
    }
    const results: PracticeEvaluation['results'] = [];
    const traces: NonNullable<PracticeEvaluation['assessment']>['evaluators'] = [];
    const groups = new Map<string, PracticeCheckpoint['criteria']>();
    for (const criterion of rubric.criteria) {
      const method = criterion.verification?.kind ?? PracticeVerification.LLM;
      const capabilities = criterion.capabilities ?? [];
      const supported =
        evidence.some((item) => (prepared.capabilities.get(item.id)?.length ?? 0) > 0) &&
        capabilities.every((capability) =>
          evidence.some((item) => prepared.capabilities.get(item.id)?.includes(capability)),
        );
      const missingSource = criterion.sourceIds.some((id) =>
        grounding.missingSourceIds.includes(id),
      );
      const requiresStructure = method === PracticeVerification.SCRATCH_STRUCTURE;
      const structural =
        !requiresStructure ||
        [...prepared.capabilities.values()].some((values) =>
          values.includes(PracticeCapability.PROJECT_STRUCTURE),
        );
      if (!supported || !structural || missingSource || method === PracticeVerification.TEACHER) {
        results.push({
          criterionId: criterion.id,
          finding: PracticeFinding.INSUFFICIENT_EVIDENCE,
          evidenceIds: [],
          feedback:
            locale === 'vi'
              ? 'Cần thêm bằng chứng phù hợp, tài liệu đã duyệt hoặc giáo viên kiểm tra.'
              : 'Additional suitable evidence, approved class context or teacher review is required.',
        });
        traces.push({ criterionId: criterion.id, id: method, version: 'capability-guard-v1' });
      } else {
        groups.set(method, [...(groups.get(method) ?? []), criterion]);
      }
    }
    for (const [method, criteria] of groups) {
      signal.throwIfAborted();
      const evaluator = this.evaluators.find((item) => item.id === method);
      const input = { rubric: { ...rubric, criteria }, prepared, grounding, locale };
      if (!evaluator || !evaluator.supports(input)) {
        for (const criterion of criteria) {
          results.push({
            criterionId: criterion.id,
            finding: PracticeFinding.INSUFFICIENT_EVIDENCE,
            evidenceIds: [],
            feedback:
              locale === 'vi'
                ? 'Chưa hỗ trợ cách kiểm tra này.'
                : 'This verification method is not supported.',
          });
          traces.push({
            criterionId: criterion.id,
            id: criterion.verification?.kind ?? PracticeVerification.LLM,
            version: 'unsupported-v1',
          });
        }
        continue;
      }
      if (!evaluator.available) {
        throw new Error('Evaluator unavailable.');
      }
      const evaluation = PracticeEvaluationSchema.parse(await evaluator.evaluate(input, signal));
      validatePracticeFindings(
        input.rubric,
        evaluation,
        evidence.map((item) => item.id),
      );
      results.push(
        ...evaluation.results.map((result) => {
          const criterion = criteria.find((item) => item.id === result.criterionId);
          const suitable = (criterion?.capabilities ?? []).every((capability) =>
            result.evidenceIds.some((id) => prepared.capabilities.get(id)?.includes(capability)),
          );
          return suitable
            ? result
            : {
                ...result,
                finding: PracticeFinding.INSUFFICIENT_EVIDENCE,
                evidenceIds: [],
                feedback:
                  locale === 'vi'
                    ? 'Bằng chứng được trích chưa đủ để xác minh yêu cầu này.'
                    : 'The cited evidence cannot establish this requirement.',
              };
        }),
      );
      traces.push(
        ...criteria.map((criterion) => ({
          criterionId: criterion.id,
          id: criterion.verification?.kind ?? PracticeVerification.LLM,
          version: evaluator.version,
        })),
      );
    }
    signal.throwIfAborted();
    return PracticeEvaluationSchema.parse({
      results,
      assessment: {
        version: 'practice-assessment-v1',
        courseRevisionId: grounding.courseRevisionId,
        sourceIds: grounding.sources.map((source) => source.id),
        missingSourceIds: grounding.missingSourceIds,
        extractorVersion: prepared.extractorVersion,
        units: prepared.units,
        warnings: prepared.warnings,
        evaluators: traces,
      },
    });
  }
}
