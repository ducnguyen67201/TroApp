import { expect, it, vi } from 'vitest';
import type { OnboardingReply } from '#contracts/Onboarding.js';
import { OnboardingAction, OnboardingFailure } from '#contracts/OnboardingValues.js';
import {
  registerOnboardingHandlers,
  type OnboardingAccess,
} from '../../../../src/desktop/main/onboarding/RegisterOnboarding.js';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';
import { OnboardingService } from '../../../../src/desktop/onboarding/application/OnboardingService.js';
import type { OnboardingStore } from '../../../../src/desktop/onboarding/application/OnboardingStore.js';
import { createOnboardingProgress } from '../../../../src/desktop/onboarding/domain/OnboardingProgress.js';

interface TestEvent {
  trusted: boolean;
}

function createHandlers() {
  const store = {
    readProgress: vi
      .fn<OnboardingStore['readProgress']>()
      .mockResolvedValue(createOnboardingProgress()),
    saveProgress: vi.fn<OnboardingStore['saveProgress']>().mockResolvedValue(),
  } satisfies OnboardingStore;
  const gate = new AccountTransitionGate(
    () => false,
    () => false,
  );
  const access = {
    gate,
    isTrustedSender: (event: TestEvent) => event.trusted,
    readSession: vi.fn<OnboardingAccess<TestEvent>['readSession']>().mockResolvedValue({
      kind: 'signed-in',
      user: { id: 'current', name: 'Sample', email: 'sample@example.test', isAdmin: false },
    }),
  } satisfies OnboardingAccess<TestEvent>;
  const handlers = new Map<string, (event: TestEvent, raw: unknown) => Promise<OnboardingReply>>();
  registerOnboardingHandlers(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    access,
    new OnboardingService(store),
  );
  return {
    store,
    access,
    gate,
    invoke: async (channel: string, raw: unknown, event: TestEvent = { trusted: true }) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error('Missing onboarding handler');
      }
      return handler(event, raw);
    },
  };
}

it('checks sender and active identity before disk access and rejects injected capabilities', async () => {
  const { store, access, invoke } = createHandlers();
  const request = { expectedAccountId: 'current' };
  expect(await invoke('tro:onboarding-read', request, { trusted: false })).toEqual({
    kind: 'failed',
    reason: OnboardingFailure.UNAVAILABLE,
  });
  expect(access.readSession).not.toHaveBeenCalled();
  expect(await invoke('tro:onboarding-read', { expectedAccountId: 'previous' })).toEqual({
    kind: 'failed',
    reason: OnboardingFailure.UNAVAILABLE,
  });
  expect(await invoke('tro:onboarding-read', { ...request, path: '/private' })).toEqual({
    kind: 'failed',
    reason: OnboardingFailure.INVALID,
  });
  expect(store.readProgress).not.toHaveBeenCalled();
  expect(await invoke('tro:onboarding-read', request)).toMatchObject({ kind: 'ok' });
  expect(store.readProgress).toHaveBeenCalledExactlyOnceWith('current');
  await invoke('tro:onboarding-update', {
    ...request,
    expectedRevision: 0,
    action: OnboardingAction.START,
  });
  await invoke('tro:onboarding-restart', { ...request, expectedRevision: 0 });
  expect(store.saveProgress).toHaveBeenCalledTimes(2);
});

it('rechecks the sender after session verification and holds account changes through the operation', async () => {
  const { store, access, gate, invoke } = createHandlers();
  const event = { trusted: true };
  let completeSession:
    | ((session: Awaited<ReturnType<OnboardingAccess<TestEvent>['readSession']>>) => void)
    | undefined;
  access.readSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeSession = resolve;
      }),
  );
  const request = invoke('tro:onboarding-read', { expectedAccountId: 'current' }, event);
  expect((await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).kind).toBe(
    'failed',
  );
  event.trusted = false;
  completeSession?.({
    kind: 'signed-in',
    user: { id: 'current', name: 'Sample', email: 'sample@example.test', isAdmin: false },
  });
  expect(await request).toEqual({ kind: 'failed', reason: OnboardingFailure.UNAVAILABLE });
  expect(store.readProgress).not.toHaveBeenCalled();
  expect(await gate.changeAccount(() => Promise.resolve({ kind: 'signed-out' }))).toEqual({
    kind: 'signed-out',
  });
});
