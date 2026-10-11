// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import type { OnboardingReply } from '#contracts/Onboarding.js';
import { OnboardingAction, OnboardingStatus, OnboardingStep } from '#contracts/OnboardingValues.js';
import { createOnboardingProgress } from '../../../../src/desktop/onboarding/domain/OnboardingProgress.js';
import { useOnboarding } from '../../../../src/desktop/renderer/onboarding/UseOnboarding.js';

function createBridge() {
  const progress = createOnboardingProgress();
  return {
    readOnboardingProgress: vi
      .fn<NonNullable<DesktopBridge['readOnboardingProgress']>>()
      .mockResolvedValue({ kind: 'ok', progress }),
    updateOnboardingProgress: vi
      .fn<NonNullable<DesktopBridge['updateOnboardingProgress']>>()
      .mockResolvedValue({
        kind: 'ok',
        progress: { ...progress, revision: 1, status: OnboardingStatus.IN_PROGRESS },
      }),
    restartOnboarding: vi.fn<NonNullable<DesktopBridge['restartOnboarding']>>().mockResolvedValue({
      kind: 'ok',
      progress: { ...progress, revision: 2, status: OnboardingStatus.IN_PROGRESS },
    }),
  } satisfies Pick<
    DesktopBridge,
    'readOnboardingProgress' | 'updateOnboardingProgress' | 'restartOnboarding'
  >;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('fences a pending read when the active account changes', async () => {
  const bridge = createBridge();
  let finishRead: ((reply: OnboardingReply) => void) | undefined;
  bridge.readOnboardingProgress.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result, rerender } = renderHook(({ accountId }) => useOnboarding(accountId), {
    initialProps: { accountId: 'first' },
  });
  rerender({ accountId: 'second' });
  await waitFor(() => {
    expect(result.current.progress?.revision).toBe(0);
  });
  await act(async () => {
    finishRead?.({
      kind: 'ok',
      progress: { ...createOnboardingProgress(), revision: 99, status: OnboardingStatus.COMPLETED },
    });
    await Promise.resolve();
  });
  expect(result.current.progress?.status).toBe(OnboardingStatus.NEW);
  expect(bridge.readOnboardingProgress).toHaveBeenLastCalledWith({ expectedAccountId: 'second' });
});

it('fences a pending save from a previous account and does not open its completion', async () => {
  const bridge = createBridge();
  bridge.readOnboardingProgress.mockResolvedValueOnce({
    kind: 'ok',
    progress: {
      ...createOnboardingProgress(),
      status: OnboardingStatus.IN_PROGRESS,
      stepId: OnboardingStep.GUIDED_LESSONS,
    },
  });
  let finishSave: ((reply: OnboardingReply) => void) | undefined;
  bridge.updateOnboardingProgress.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result, rerender } = renderHook(({ accountId }) => useOnboarding(accountId), {
    initialProps: { accountId: 'first' },
  });
  await waitFor(() => {
    expect(result.current.progress?.stepId).toBe(OnboardingStep.GUIDED_LESSONS);
  });
  let pendingSave: Promise<boolean> | undefined;
  act(() => {
    pendingSave = result.current.sendAction(OnboardingAction.NEXT);
  });
  rerender({ accountId: 'second' });
  await waitFor(() => {
    expect(result.current.progress?.status).toBe(OnboardingStatus.NEW);
  });
  await act(async () => {
    finishSave?.({
      kind: 'ok',
      progress: { ...createOnboardingProgress(), status: OnboardingStatus.COMPLETED, revision: 1 },
    });
    await pendingSave;
  });
  expect(result.current.showCompletion).toBe(false);
  expect(result.current.progress?.revision).toBe(0);
});

it('keeps failed saves visible, prevents overlapping actions and reloads before retrying', async () => {
  const bridge = createBridge();
  bridge.updateOnboardingProgress.mockResolvedValueOnce({ kind: 'failed', reason: 'storage' });
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const { result } = renderHook(() => useOnboarding('student'));
  await waitFor(() => {
    expect(result.current.progress).not.toBeNull();
  });
  await act(async () => {
    await result.current.sendAction(OnboardingAction.START);
  });
  expect(result.current.hasError).toBe(true);
  expect(result.current.progress?.revision).toBe(0);
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.hasError).toBe(false);
  await act(async () => {
    await Promise.all([
      result.current.sendAction(OnboardingAction.START),
      result.current.sendAction(OnboardingAction.START),
    ]);
  });
  expect(bridge.updateOnboardingProgress).toHaveBeenCalledTimes(2);
  await act(async () => {
    await result.current.restart();
  });
  expect(bridge.restartOnboarding).toHaveBeenCalledWith({
    expectedAccountId: 'student',
    expectedRevision: 1,
  });
});
