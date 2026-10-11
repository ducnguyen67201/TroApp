// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { PetWorldTiming, type PetWorldReply } from '#contracts/PetWorld.js';
import { usePetHomeVisit } from '../../../../src/desktop/renderer/petWorld/UsePetHomeVisit.js';
import { createOwnWorld, petWorldClassId } from './PetWorldFixtures.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('removes the visited cosmetic projection when sharing is revoked on refresh', async () => {
  vi.useFakeTimers();
  const profile = createOwnWorld('student').profile;
  if (!profile) {
    throw new Error('Fixture requires a profile.');
  }
  const bridge = {
    executePetWorld: vi
      .fn<NonNullable<DesktopBridge['executePetWorld']>>()
      .mockResolvedValueOnce({
        kind: 'home',
        home: { studentId: 'student', displayName: 'An', profile },
      })
      .mockResolvedValue({ kind: 'failed', code: 'home_unavailable' }),
  } satisfies Pick<DesktopBridge, 'executePetWorld'>;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const rendered = renderHook(() => usePetHomeVisit('visitor', petWorldClassId));
  await act(async () => {
    await rendered.result.current.visitHome('student');
  });
  expect(rendered.result.current.home?.displayName).toBe('An');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(rendered.result.current.home).toBeNull();
  expect(rendered.result.current.isUnavailable).toBe(true);
});

it('waits for a slow visit instead of replacing it with each automatic poll', async () => {
  vi.useFakeTimers();
  const profile = createOwnWorld('student').profile;
  if (!profile) {
    throw new Error('Fixture requires a profile.');
  }
  let finishVisit: ((reply: PetWorldReply) => void) | undefined;
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishVisit = resolve;
        }),
    )
    .mockResolvedValue({ kind: 'failed', code: 'home_unavailable' });
  Object.defineProperty(window, 'tro', {
    configurable: true,
    value: { executePetWorld: execute },
  });
  const rendered = renderHook(() => usePetHomeVisit('visitor', petWorldClassId));
  let visiting: Promise<void> | undefined;
  await act(async () => {
    visiting = rendered.result.current.visitHome('student');
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PetWorldTiming.REFRESH_MS * 3);
  });
  expect(execute).toHaveBeenCalledOnce();
  await act(async () => {
    finishVisit?.({ kind: 'home', home: { studentId: 'student', displayName: 'An', profile } });
    await visiting;
  });
  expect(rendered.result.current.home?.displayName).toBe('An');
  expect(rendered.result.current.isLoading).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PetWorldTiming.REFRESH_MS);
  });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(rendered.result.current.home).toBeNull();
  expect(rendered.result.current.isUnavailable).toBe(true);
});

it('lets explicit choices and closing supersede a pending visit without accepting its late reply', async () => {
  const profile = createOwnWorld('student').profile;
  if (!profile) {
    throw new Error('Fixture requires a profile.');
  }
  let finishFirstVisit: ((reply: PetWorldReply) => void) | undefined;
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstVisit = resolve;
        }),
    )
    .mockResolvedValue({
      kind: 'home',
      home: { studentId: 'second', displayName: 'Bao', profile },
    });
  Object.defineProperty(window, 'tro', {
    configurable: true,
    value: { executePetWorld: execute },
  });
  const rendered = renderHook(() => usePetHomeVisit('visitor', petWorldClassId));
  let firstVisit: Promise<void> | undefined;
  await act(async () => {
    firstVisit = rendered.result.current.visitHome('student');
    await Promise.resolve();
  });
  await act(async () => {
    await rendered.result.current.visitHome('second');
  });
  expect(rendered.result.current.home?.displayName).toBe('Bao');
  act(() => {
    rendered.result.current.closeHome();
  });
  await act(async () => {
    finishFirstVisit?.({
      kind: 'home',
      home: { studentId: 'student', displayName: 'An', profile },
    });
    await firstVisit;
  });
  expect(rendered.result.current.home).toBeNull();
  expect(rendered.result.current.isOpen).toBe(false);
  await act(async () => {
    await rendered.result.current.visitHome('second');
  });
  expect(rendered.result.current.home?.displayName).toBe('Bao');
  expect(execute).toHaveBeenCalledTimes(3);
});
