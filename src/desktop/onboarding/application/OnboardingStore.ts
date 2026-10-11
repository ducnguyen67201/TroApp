import type { OnboardingProgress } from '#contracts/Onboarding.js';

/** Durable device-local storage. Missing data is new; corrupt/unsupported data must throw. */
export interface OnboardingStore {
  readProgress(accountId: string): Promise<OnboardingProgress>;
  saveProgress(accountId: string, progress: OnboardingProgress): Promise<void>;
}
