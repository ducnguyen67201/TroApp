import { expect, it, vi } from 'vitest';
import type { OnboardingProgress } from '#contracts/Onboarding.js';
import {
  OnboardingAction,
  OnboardingFailure,
  OnboardingStatus,
  OnboardingStep,
} from '#contracts/OnboardingValues.js';
import { OnboardingService } from '../../../../src/desktop/onboarding/application/OnboardingService.js';
import type { OnboardingStore } from '../../../../src/desktop/onboarding/application/OnboardingStore.js';
import { createOnboardingProgress } from '../../../../src/desktop/onboarding/domain/OnboardingProgress.js';

function createStore() {
  const saved = new Map<string, OnboardingProgress>();
  return {
    readProgress: vi
      .fn<OnboardingStore['readProgress']>()
      .mockImplementation((accountId) =>
        Promise.resolve(structuredClone(saved.get(accountId) ?? createOnboardingProgress())),
      ),
    saveProgress: vi
      .fn<OnboardingStore['saveProgress']>()
      .mockImplementation((accountId, progress) => {
        saved.set(accountId, structuredClone(progress));
        return Promise.resolve();
      }),
  } satisfies OnboardingStore;
}

it('serializes reset with pending updates and rejects a later stale save', async () => {
  const store = createStore();
  const service = new OnboardingService(store);
  await service.changeProgress('first', 0, OnboardingAction.START);
  const advance = service.changeProgress('first', 1, OnboardingAction.NEXT);
  const reset = service.changeProgress('first', 2, OnboardingAction.RESTART);
  const stale = service.changeProgress('first', 2, OnboardingAction.NEXT);
  expect(await advance).toMatchObject({ kind: 'ok', progress: { stepId: OnboardingStep.CLASSES } });
  expect(await reset).toMatchObject({
    kind: 'ok',
    progress: { revision: 3, stepId: OnboardingStep.WORKSPACE },
  });
  expect(await stale).toEqual({ kind: 'failed', reason: OnboardingFailure.CONFLICT });
  expect(await service.readProgress('first')).toMatchObject({
    kind: 'ok',
    progress: { revision: 3, stepId: OnboardingStep.WORKSPACE },
  });
  expect(await service.readProgress('second')).toMatchObject({
    kind: 'ok',
    progress: { revision: 0, status: OnboardingStatus.NEW },
  });
});

it('does not report failed writes as saved, and recovers the command queue', async () => {
  const store = createStore();
  const service = new OnboardingService(store);
  store.saveProgress.mockRejectedValueOnce(new Error('disk unavailable'));
  expect(await service.changeProgress('student', 0, OnboardingAction.START)).toEqual({
    kind: 'failed',
    reason: OnboardingFailure.STORAGE,
  });
  expect(await service.readProgress('student')).toMatchObject({
    kind: 'ok',
    progress: { revision: 0 },
  });
  expect(await service.changeProgress('student', 0, OnboardingAction.START)).toMatchObject({
    kind: 'ok',
    progress: { revision: 1 },
  });
});

it('never overwrites a file after a failed read or invalid transition', async () => {
  const store = createStore();
  const service = new OnboardingService(store);
  store.readProgress.mockRejectedValueOnce(new Error('unsupported file'));
  expect(await service.changeProgress('student', 0, OnboardingAction.RESTART)).toEqual({
    kind: 'failed',
    reason: OnboardingFailure.STORAGE,
  });
  expect(await service.changeProgress('student', 0, OnboardingAction.NEXT)).toEqual({
    kind: 'failed',
    reason: OnboardingFailure.INVALID,
  });
  expect(store.saveProgress).not.toHaveBeenCalled();
});
