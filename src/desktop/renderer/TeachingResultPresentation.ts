import { TeachingOutcome, type TeachingResult } from '#contracts/CursorCompanion.js';
import type { TranslationCatalog, TranslationKey } from './localization/English.js';

export const TeachingOutcomeLabel = {
  [TeachingOutcome.DEMONSTRATED]: 'guidanceDemonstrated',
  [TeachingOutcome.EXPLAINED]: 'guidanceExplained',
  [TeachingOutcome.NEEDS_INPUT]: 'guidanceNeedsInput',
  [TeachingOutcome.CANCELED]: 'guidanceCanceled',
  [TeachingOutcome.FAILED]: 'guidanceFailed',
} satisfies Record<TeachingOutcome, TranslationKey>;

/** Failed or canceled guides use deterministic copy, never an unverified model answer. */
export function describeTeachingResult(
  result: TeachingResult,
  translations: TranslationCatalog,
): string {
  switch (result.outcome) {
    case TeachingOutcome.DEMONSTRATED:
    case TeachingOutcome.EXPLAINED:
      return result.answer;
    case TeachingOutcome.NEEDS_INPUT:
      return result.answer ?? translations.guidanceNeedsInputMessage;
    case TeachingOutcome.CANCELED:
      return translations.guidanceCanceledMessage;
    case TeachingOutcome.FAILED:
      return translations.guidanceFailedMessage;
  }
}
