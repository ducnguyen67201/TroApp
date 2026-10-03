import {
  GuidanceReason,
  TeachingOutcome,
  type TeachingResult,
} from '#contracts/CursorCompanion.js';
import type { TranslationCatalog, TranslationKey } from './localization/English.js';

export const TeachingOutcomeLabel = {
  [TeachingOutcome.GOAL_REACHED]: 'guidanceGoalReached',
  [TeachingOutcome.DEMONSTRATED]: 'guidanceDemonstrated',
  [TeachingOutcome.NEEDS_INPUT]: 'guidanceNeedsInput',
  [TeachingOutcome.CANCELED]: 'guidanceCanceled',
  [TeachingOutcome.FAILED]: 'guidanceFailed',
} satisfies Record<TeachingOutcome, TranslationKey>;

/** Failed or canceled guides use deterministic copy, never an unverified model answer. */
export function describeTeachingResult(
  result: TeachingResult,
  translations: TranslationCatalog,
): string {
  if (
    (result.outcome === TeachingOutcome.FAILED || result.outcome === TeachingOutcome.CANCELED) &&
    result.reason === GuidanceReason.TARGET_INVALIDATED
  ) {
    return translations.guidanceTargetChangedMessage;
  }
  switch (result.outcome) {
    case TeachingOutcome.GOAL_REACHED:
    case TeachingOutcome.DEMONSTRATED:
      return result.answer;
    case TeachingOutcome.NEEDS_INPUT:
      return result.answer ?? translations.guidanceNeedsInputMessage;
    case TeachingOutcome.CANCELED:
      return translations.guidanceCanceledMessage;
    case TeachingOutcome.FAILED:
      return translations.guidanceFailedMessage;
  }
}
