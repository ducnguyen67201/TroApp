export const LessonFailure = {
  FORBIDDEN: 'forbidden',
  INVALID: 'invalidPlan',
  STALE: 'versionConflict',
  UNAVAILABLE: 'unavailable',
  BUDGET: 'budgetBlocked',
  UNCERTAIN: 'usageUncertain',
  FAILED: 'stageFailed',
} as const;

export type LessonFailure = (typeof LessonFailure)[keyof typeof LessonFailure];

export class LessonError extends Error {
  constructor(readonly code: LessonFailure) {
    super(code);
    this.name = 'LessonError';
  }
}
