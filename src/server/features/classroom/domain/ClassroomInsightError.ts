import type { InsightFailure } from '#contracts/ClassroomInsights.js';

/** Safe refusal code; never carries evidence, credentials or validation input. */
export class ClassroomInsightError extends Error {
  constructor(readonly code: InsightFailure) {
    super(code);
    this.name = 'ClassroomInsightError';
  }
}
