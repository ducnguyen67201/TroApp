import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type {
  PracticeCheckpoint,
  PracticeEvidence,
  PracticeEvaluation,
} from '#contracts/PracticeCheck.js';
/** A read-only judge; adapters cannot mutate progress, submissions or rubrics. */
export interface PracticeCheckEvaluator {
  readonly available: boolean;
  readonly version: string;
  evaluate(
    rubric: PracticeCheckpoint,
    evidence: PracticeEvidence[],
    locale: DesktopLocale,
    signal: AbortSignal,
  ): Promise<PracticeEvaluation>;
}
