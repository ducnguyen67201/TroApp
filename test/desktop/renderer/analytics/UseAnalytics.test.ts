// @vitest-environment happy-dom
import { createElement, StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsScreen, type AnalyticsReply } from '#contracts/Analytics.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  AnalyticsPreferenceFailure,
  useAnalytics,
} from '../../../../src/desktop/renderer/analytics/UseAnalytics.js';

function createBridge(enabled = false) {
  const bridge = {
    readAnalyticsStatus: vi
      .fn<NonNullable<DesktopBridge['readAnalyticsStatus']>>()
      .mockResolvedValue({ kind: 'ok', status: { configured: true, enabled } }),
    setAnalyticsEnabled: vi
      .fn<NonNullable<DesktopBridge['setAnalyticsEnabled']>>()
      .mockImplementation((nextEnabled) =>
        Promise.resolve({ kind: 'ok', status: { configured: true, enabled: nextEnabled } }),
      ),
    trackScreenView: vi.fn<NonNullable<DesktopBridge['trackScreenView']>>().mockResolvedValue(),
  } satisfies Pick<
    DesktopBridge,
    'readAnalyticsStatus' | 'setAnalyticsEnabled' | 'trackScreenView'
  >;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  return bridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('respects saved opt-out and reports only screen changes after re-enabling, including under StrictMode', async () => {
  const bridge = createBridge();
  const initialProps: { screen: AnalyticsScreen | null } = { screen: AnalyticsScreen.WORKSPACE };
  const { result, rerender } = renderHook(
    ({ screen }: { screen: AnalyticsScreen | null }) => useAnalytics(screen),
    {
      initialProps,
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, { children }),
    },
  );
  await waitFor(() => {
    expect(result.current.isLoading).toBe(false);
  });
  expect(bridge.trackScreenView).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.changeEnabled(true);
  });
  expect(result.current.isSaving).toBe(false);
  expect(bridge.trackScreenView).toHaveBeenCalledExactlyOnceWith(AnalyticsScreen.WORKSPACE);
  rerender({ screen: AnalyticsScreen.WORKSPACE });
  expect(bridge.trackScreenView).toHaveBeenCalledTimes(1);
  rerender({ screen: AnalyticsScreen.CLASSROOM });
  expect(bridge.trackScreenView).toHaveBeenLastCalledWith(AnalyticsScreen.CLASSROOM);
  await act(async () => {
    await result.current.changeEnabled(false);
  });
  rerender({ screen: AnalyticsScreen.INSIGHTS });
  expect(bridge.trackScreenView).toHaveBeenCalledTimes(2);
  expect(result.current.status?.enabled).toBe(false);
});

it('keeps analytics unavailable without a configured project', async () => {
  const bridge = createBridge();
  bridge.readAnalyticsStatus.mockResolvedValue({
    kind: 'ok',
    status: { configured: false, enabled: false },
  });
  const { result } = renderHook(() => useAnalytics(AnalyticsScreen.WORKSPACE));
  await waitFor(() => {
    expect(result.current.isLoading).toBe(false);
  });
  await act(async () => {
    await result.current.changeEnabled(true);
  });
  expect(bridge.setAnalyticsEnabled).not.toHaveBeenCalled();
  expect(bridge.trackScreenView).not.toHaveBeenCalled();
});

it('retries a failed read and does not collect until the sharing preference is known', async () => {
  const bridge = createBridge(true);
  bridge.readAnalyticsStatus.mockRejectedValueOnce(new Error('Unavailable'));
  const { result } = renderHook(() => useAnalytics(AnalyticsScreen.CLASSROOM));
  await waitFor(() => {
    expect(result.current.failure).toBe(AnalyticsPreferenceFailure.LOAD);
  });
  expect(bridge.trackScreenView).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.retry();
  });
  expect(result.current.failure).toBeNull();
  expect(bridge.trackScreenView).toHaveBeenCalledExactlyOnceWith(AnalyticsScreen.CLASSROOM);
});

it('retains the confirmed preference on a failed opt-in and retries the intended choice', async () => {
  const bridge = createBridge();
  bridge.setAnalyticsEnabled.mockResolvedValueOnce({ kind: 'failed' });
  const { result } = renderHook(() => useAnalytics(AnalyticsScreen.WORKSPACE));
  await waitFor(() => {
    expect(result.current.isLoading).toBe(false);
  });
  await act(async () => {
    await result.current.changeEnabled(true);
  });
  expect(result.current.status?.enabled).toBe(false);
  expect(result.current.failure).toBe(AnalyticsPreferenceFailure.SAVE);
  expect(bridge.trackScreenView).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.retry();
  });
  expect(result.current.status?.enabled).toBe(true);
  expect(result.current.failure).toBeNull();
  expect(bridge.setAnalyticsEnabled).toHaveBeenLastCalledWith(true);
});

it('reflects an immediate opt-out when saving failed and retries its persistence', async () => {
  const bridge = createBridge(true);
  const initialProps: { screen: AnalyticsScreen | null } = { screen: AnalyticsScreen.WORKSPACE };
  bridge.setAnalyticsEnabled.mockResolvedValueOnce({ kind: 'failed' });
  const { result, rerender } = renderHook(
    ({ screen }: { screen: AnalyticsScreen | null }) => useAnalytics(screen),
    { initialProps },
  );
  await waitFor(() => {
    expect(result.current.isLoading).toBe(false);
  });
  bridge.readAnalyticsStatus.mockResolvedValue({
    kind: 'ok',
    status: { configured: true, enabled: false },
  });
  await act(async () => {
    await result.current.changeEnabled(false);
  });
  expect(result.current.status?.enabled).toBe(false);
  expect(result.current.failure).toBe(AnalyticsPreferenceFailure.SAVE);
  rerender({ screen: AnalyticsScreen.CLASSROOM });
  expect(bridge.trackScreenView).toHaveBeenCalledTimes(1);
  await act(async () => {
    await result.current.retry();
  });
  expect(bridge.setAnalyticsEnabled).toHaveBeenLastCalledWith(false);
  expect(result.current.failure).toBeNull();
});

it('prevents overlapping preference saves and ignores replies after unmount', async () => {
  const bridge = createBridge();
  let finishSave: ((reply: AnalyticsReply) => void) | undefined;
  bridge.setAnalyticsEnabled.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  const { result, unmount } = renderHook(() => useAnalytics(AnalyticsScreen.WORKSPACE));
  await waitFor(() => {
    expect(result.current.isLoading).toBe(false);
  });
  let saving: Promise<void> | undefined;
  act(() => {
    saving = result.current.changeEnabled(true);
    void result.current.changeEnabled(false);
  });
  expect(bridge.setAnalyticsEnabled).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => {
    finishSave?.({ kind: 'ok', status: { configured: true, enabled: true } });
    await saving;
  });
  expect(bridge.trackScreenView).not.toHaveBeenCalled();
});
