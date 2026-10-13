import type { LessonVideoSettings } from '../../../config/LessonVideoConfig.js';

/** First-pass ceiling includes optional visuals; speech and worker compute are separate. */
export function estimateLessonFirstPass(settings: LessonVideoSettings): number {
  return Math.ceil(
    settings.content.inputTokens * settings.budget.inputMicroUsdPerToken +
      settings.content.outputTokens * settings.budget.outputMicroUsdPerToken +
      (settings.visual.enabled
        ? settings.visual.maxScenes *
          (settings.visual.inputTokens * settings.budget.inputMicroUsdPerToken +
            settings.visual.outputTokens * settings.budget.outputMicroUsdPerToken)
        : 0),
  );
}

/** Integer micro-USD; all possible transport attempts are reserved before dispatch. */
export function estimateLessonReservation(settings: LessonVideoSettings): number {
  const contentReservation =
    settings.content.attempts *
    (settings.content.inputTokens * settings.budget.inputMicroUsdPerToken +
      settings.content.outputTokens * settings.budget.outputMicroUsdPerToken);
  const visualReservation = settings.visual.enabled
    ? settings.visual.maxScenes *
      settings.visual.attempts *
      (settings.visual.inputTokens * settings.budget.inputMicroUsdPerToken +
        settings.visual.outputTokens * settings.budget.outputMicroUsdPerToken)
    : 0;
  return Math.ceil(contentReservation + visualReservation);
}
