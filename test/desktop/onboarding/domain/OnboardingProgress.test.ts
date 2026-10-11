import { expect, it } from 'vitest';
import { OnboardingProgressSchema, OnboardingUpdateSchema } from '#contracts/Onboarding.js';
import { OnboardingAction, OnboardingStatus, OnboardingStep } from '#contracts/OnboardingValues.js';
import {
  applyOnboardingAction,
  createOnboardingProgress,
} from '../../../../src/desktop/onboarding/domain/OnboardingProgress.js';

it('requires explicit start and final advancement, and allows returning to the previous step', () => {
  const fresh = createOnboardingProgress();
  expect(applyOnboardingAction(fresh, OnboardingAction.NEXT)).toBeNull();
  const started = applyOnboardingAction(fresh, OnboardingAction.START);
  expect(started?.status).toBe(OnboardingStatus.IN_PROGRESS);
  if (!started) {
    throw new Error('Expected started tour');
  }
  expect(applyOnboardingAction(started, OnboardingAction.BACK)).toBeNull();
  const classes = applyOnboardingAction(started, OnboardingAction.NEXT);
  if (!classes) {
    throw new Error('Expected classes step');
  }
  expect(classes.stepId).toBe(OnboardingStep.CLASSES);
  expect(applyOnboardingAction(classes, OnboardingAction.BACK)?.stepId).toBe(
    OnboardingStep.WORKSPACE,
  );
  const lessons = { ...classes, stepId: OnboardingStep.GUIDED_LESSONS };
  const microphone = applyOnboardingAction(lessons, OnboardingAction.NEXT);
  expect(microphone?.stepId).toBe(OnboardingStep.MICROPHONE);
  if (!microphone) {
    throw new Error('Expected microphone step');
  }
  const last = applyOnboardingAction(microphone, OnboardingAction.NEXT);
  expect(last?.stepId).toBe(OnboardingStep.PETS);
  if (!last) {
    throw new Error('Expected pets step');
  }
  expect(applyOnboardingAction(last, OnboardingAction.BACK)?.stepId).toBe(
    OnboardingStep.MICROPHONE,
  );
  const completed = applyOnboardingAction(last, OnboardingAction.NEXT);
  expect(completed?.status).toBe(OnboardingStatus.COMPLETED);
  expect(last.status).toBe(OnboardingStatus.IN_PROGRESS);
  if (!completed) {
    throw new Error('Expected completed tour');
  }
  expect(applyOnboardingAction(completed, OnboardingAction.NEXT)).toBeNull();
  expect(applyOnboardingAction(completed, OnboardingAction.RESTART)).toMatchObject({
    stepId: OnboardingStep.WORKSPACE,
    status: OnboardingStatus.IN_PROGRESS,
    revision: completed.revision + 1,
  });
});

it('dismissal suppresses automatic continuation until an explicit restart', () => {
  const dismissed = applyOnboardingAction(createOnboardingProgress(), OnboardingAction.DISMISS);
  if (!dismissed) {
    throw new Error('Expected dismissal');
  }
  expect(dismissed.status).toBe(OnboardingStatus.DISMISSED);
  expect(applyOnboardingAction(dismissed, OnboardingAction.START)).toBeNull();
  expect(applyOnboardingAction(dismissed, OnboardingAction.RESTART)?.status).toBe(
    OnboardingStatus.IN_PROGRESS,
  );
});

it('rejects unknown versions, steps, media paths and locale-dependent progress', () => {
  const progress = createOnboardingProgress();
  expect(OnboardingProgressSchema.safeParse({ ...progress, tourVersion: 2 }).success).toBe(false);
  expect(OnboardingProgressSchema.safeParse({ ...progress, stepId: 'unknown' }).success).toBe(
    false,
  );
  expect(OnboardingProgressSchema.safeParse({ ...progress, locale: 'vi' }).success).toBe(false);
  expect(
    OnboardingUpdateSchema.safeParse({
      expectedAccountId: 'student',
      expectedRevision: 0,
      action: OnboardingAction.START,
      path: '/private',
    }).success,
  ).toBe(false);
});

it('preserves completed and dismissed version-one tours when new steps are added', () => {
  for (const status of [OnboardingStatus.COMPLETED, OnboardingStatus.DISMISSED]) {
    const saved = { ...createOnboardingProgress(), status, stepId: OnboardingStep.GUIDED_LESSONS };
    expect(OnboardingProgressSchema.parse(saved)).toEqual(saved);
    expect(applyOnboardingAction(saved, OnboardingAction.NEXT)).toBeNull();
    expect(applyOnboardingAction(saved, OnboardingAction.RESTART)?.status).toBe(
      OnboardingStatus.IN_PROGRESS,
    );
  }
});
