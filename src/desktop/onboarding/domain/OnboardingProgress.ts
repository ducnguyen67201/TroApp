import type { OnboardingProgress } from '#contracts/Onboarding.js';
import {
  OnboardingAction,
  OnboardingStatus,
  onboardingSteps,
  onboardingTourVersion,
} from '#contracts/OnboardingValues.js';

export function createOnboardingProgress(): OnboardingProgress {
  return {
    storageVersion: 1,
    tourVersion: onboardingTourVersion,
    revision: 0,
    status: OnboardingStatus.NEW,
    stepId: onboardingSteps[0],
  };
}

/** Explicit actions advance progress; video duration and locale never determine completion. */
export function applyOnboardingAction(
  progress: OnboardingProgress,
  action: OnboardingAction,
): OnboardingProgress | null {
  const next = { ...progress, revision: progress.revision + 1 };
  if (action === OnboardingAction.RESTART) {
    return {
      ...createOnboardingProgress(),
      revision: next.revision,
      status: OnboardingStatus.IN_PROGRESS,
    };
  }
  if (action === OnboardingAction.START && progress.status === OnboardingStatus.NEW) {
    return { ...next, status: OnboardingStatus.IN_PROGRESS };
  }
  if (
    action === OnboardingAction.DISMISS &&
    (progress.status === OnboardingStatus.NEW || progress.status === OnboardingStatus.IN_PROGRESS)
  ) {
    return { ...next, status: OnboardingStatus.DISMISSED };
  }
  if (progress.status !== OnboardingStatus.IN_PROGRESS) {
    return null;
  }
  const index = onboardingSteps.indexOf(progress.stepId);
  if (action === OnboardingAction.NEXT) {
    const stepId = onboardingSteps[index + 1];
    return stepId ? { ...next, stepId } : { ...next, status: OnboardingStatus.COMPLETED };
  }
  if (action === OnboardingAction.BACK) {
    const stepId = onboardingSteps[index - 1];
    return stepId ? { ...next, stepId } : null;
  }
  return null;
}
