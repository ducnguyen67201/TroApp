import type { LessonVideoSettings } from '../../../config/LessonVideoConfig.js';

/** Integer micro-USD; all possible transport attempts are reserved before dispatch. */
export function estimateContentReservation(
  settings: LessonVideoSettings,
  inputTokens = settings.content.inputTokens,
): number {
  return Math.ceil(
    settings.content.attempts *
      (inputTokens * settings.budget.inputMicroUsdPerToken +
        settings.content.outputTokens * settings.budget.outputMicroUsdPerToken),
  );
}
