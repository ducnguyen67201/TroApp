/** Stable IDs persist across translations and recording updates. */
export const OnboardingStep = {
  WORKSPACE: 'workspace',
  CLASSES: 'classes',
  INSIGHTS: 'insights',
  GUIDED_LESSONS: 'guided-lessons',
  MICROPHONE: 'microphone',
  PETS: 'pets',
} as const;

export type OnboardingStep = (typeof OnboardingStep)[keyof typeof OnboardingStep];

export const onboardingSteps = [
  OnboardingStep.WORKSPACE,
  OnboardingStep.CLASSES,
  OnboardingStep.INSIGHTS,
  OnboardingStep.GUIDED_LESSONS,
  OnboardingStep.MICROPHONE,
  OnboardingStep.PETS,
] as const;

export const OnboardingStatus = {
  NEW: 'new',
  IN_PROGRESS: 'in-progress',
  DISMISSED: 'dismissed',
  COMPLETED: 'completed',
} as const;

export type OnboardingStatus = (typeof OnboardingStatus)[keyof typeof OnboardingStatus];

export const OnboardingAction = {
  START: 'start',
  NEXT: 'next',
  BACK: 'back',
  DISMISS: 'dismiss',
  RESTART: 'restart',
} as const;

export type OnboardingAction = (typeof OnboardingAction)[keyof typeof OnboardingAction];

export const OnboardingFailure = {
  UNAVAILABLE: 'unavailable',
  INVALID: 'invalid',
  CONFLICT: 'conflict',
  STORAGE: 'storage',
} as const;

export const onboardingTourVersion = 1;
