// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
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
