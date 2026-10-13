// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  LessonCommand,
  LessonVideoSchema,
  LessonVideoStatus,
  type LessonVideoReply,
} from '#contracts/LessonVideos.js';
import { z } from 'zod';
import { useLessonVideo } from '../../../../src/desktop/renderer/lessonVideos/UseLessonVideo.js';
import { createLessonFixture } from '../../../server/features/lessonVideos/LessonVideoFixtures.js';

// Only public DTO fields cross the bridge, just as in the production API.
const lesson = z.object(LessonVideoSchema.shape).parse(createLessonFixture());

function installBridge() {
  const controlLessonVideos = vi
    .fn<NonNullable<DesktopBridge['controlLessonVideos']>>()
    .mockImplementation((command) =>
      Promise.resolve(
        command.kind === LessonCommand.OPTIONS
          ? {
              kind: 'options',
              classes: [],
              available: true,
              estimatedMicroUsd: 13500,
              maximumMicroUsd: 108000,
            }
          : { kind: 'list', lessons: [] },
      ),
    );
  Object.defineProperty(window, 'tro', { configurable: true, value: { controlLessonVideos } });
  return controlLessonVideos;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('ignores a pending lesson response after returning to the library', async () => {
  const bridge = installBridge();
  const { result } = renderHook(() => useLessonVideo());
  await waitFor(() => {
    expect(bridge).toHaveBeenCalledTimes(2);
  });
  let resolveRead: ((reply: LessonVideoReply) => void) | undefined;
  bridge.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  let pending: Promise<void> | undefined;
  act(() => {
    pending = result.current.execute({ kind: LessonCommand.READ, id: lesson.id });
  });
  act(() => {
    result.current.select(null);
  });
  await act(async () => {
    resolveRead?.({ kind: 'lesson', lesson });
    await pending;
  });
  expect(result.current.selected).toBeNull();
});

it('unmounting an active lesson does not issue a cancel command', async () => {
  const bridge = installBridge();
  const { result, unmount } = renderHook(() => useLessonVideo());
  await waitFor(() => {
    expect(bridge).toHaveBeenCalledTimes(2);
  });
  act(() => {
    result.current.select({ ...lesson, status: LessonVideoStatus.RUNNING });
  });
  unmount();
  expect(bridge.mock.calls.some(([command]) => command.kind === LessonCommand.CANCEL)).toBe(false);
});
