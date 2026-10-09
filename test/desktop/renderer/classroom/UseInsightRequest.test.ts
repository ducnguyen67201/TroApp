// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClassroomInsightReply } from '#contracts/ClassroomInsights.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { useInsightRequest } from '../../../../src/desktop/renderer/classroom/UseInsightRequest.js';
import { insightClassId } from '../../ClassroomInsightDesktopFixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('rejects out-of-order same-scope replies and an A → B → A lifetime reply', async () => {
  const finishes: ((reply: ClassroomInsightReply) => void)[] = [];
  const send = vi.fn<NonNullable<DesktopBridge['controlClassroomInsights']>>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(resolve);
      }),
  );
  vi.stubGlobal('tro', { controlClassroomInsights: send });
  const view = renderHook(({ scope }: { scope: string }) => useInsightRequest(scope), {
    initialProps: { scope: 'teacher:class:minh' },
  });
  const command = { kind: 'status' as const, classId: insightClassId };
  const first = view.result.current(command, 'query');
  const second = view.result.current(command, 'query');
  await act(async () => {
    finishes[1]?.({ kind: 'failed', code: 'forbidden' });
    await Promise.resolve();
  });
  expect(await second).toEqual({ kind: 'failed', code: 'forbidden' });
  await act(async () => {
    finishes[0]?.({ kind: 'failed', code: 'forbidden' });
    await Promise.resolve();
  });
  expect(await first).toEqual({ kind: 'failed', code: 'stale' });
  const oldMinh = view.result.current(command, 'query');
  view.rerender({ scope: 'teacher:class:an' });
  view.rerender({ scope: 'teacher:class:minh' });
  await act(async () => {
    finishes[2]?.({ kind: 'failed', code: 'forbidden' });
    await Promise.resolve();
  });
  expect(await oldMinh).toEqual({ kind: 'failed', code: 'stale' });
});
