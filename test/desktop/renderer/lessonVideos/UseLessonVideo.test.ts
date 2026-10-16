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
  vi.useRealTimers();
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

it('updates background cards after dismissing progress without busy flicker or reopening the lesson', async () => {
  const bridge = installBridge();
  const { result } = renderHook(() => useLessonVideo());
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });
  bridge.mockResolvedValueOnce({ kind: 'lesson', lesson });
  await act(async () => {
    await result.current.execute({ kind: LessonCommand.READ, id: lesson.id });
  });
  act(() => {
    result.current.select(null);
  });
  const ready = { ...lesson, status: LessonVideoStatus.READY };
  bridge.mockResolvedValue({ kind: 'list', lessons: [ready] });
  vi.useFakeTimers();
  // Restart the polling effect under the test clock.
  act(() => {
    result.current.select(lesson);
  });
  act(() => {
    result.current.select(null);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.lessons[0]?.status).toBe(LessonVideoStatus.READY);
  expect(result.current.selected).toBeNull();
  expect(result.current.busy).toBe(false);
  const calls = bridge.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(bridge).toHaveBeenCalledTimes(calls);
});

it('refreshes all active jobs behind the selected progress dialog', async () => {
  const bridge = installBridge();
  const { result } = renderHook(() => useLessonVideo());
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });
  vi.useFakeTimers();
  const second = {
    ...lesson,
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Second lesson',
    status: LessonVideoStatus.READY,
  };
  const ready = { ...lesson, status: LessonVideoStatus.READY };
  bridge.mockResolvedValue({ kind: 'list', lessons: [ready, second] });
  act(() => {
    result.current.select(lesson);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(result.current.selected?.status).toBe(LessonVideoStatus.READY);
  expect(result.current.lessons).toEqual([ready, second]);
});

it('preserves an acknowledged mutation after the dialog closes without selecting it again', async () => {
  const bridge = installBridge();
  const { result } = renderHook(() => useLessonVideo());
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });
  let resolveCommand: ((reply: LessonVideoReply) => void) | undefined;
  bridge.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
  );
  act(() => {
    result.current.select(lesson);
  });
  let pending: Promise<void> | undefined;
  act(() => {
    pending = result.current.execute({
      kind: LessonCommand.CANCEL,
      id: lesson.id,
      revision: lesson.revision,
    });
  });
  act(() => {
    result.current.select(null);
  });
  const cancelled = { ...lesson, status: LessonVideoStatus.CANCELLED };
  await act(async () => {
    resolveCommand?.({ kind: 'lesson', lesson: cancelled });
    await pending;
  });
  expect(result.current.selected).toBeNull();
  expect(result.current.lessons).toEqual([cancelled]);
  expect(result.current.busy).toBe(false);
});

it('discards an older poll when a foreground command has started', async () => {
  const bridge = installBridge();
  const { result } = renderHook(() => useLessonVideo());
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });
  vi.useFakeTimers();
  let resolvePoll: ((reply: LessonVideoReply) => void) | undefined;
  bridge.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePoll = resolve;
      }),
  );
  act(() => {
    result.current.select(lesson);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const cancelled = { ...lesson, status: LessonVideoStatus.CANCELLED };
  bridge.mockResolvedValueOnce({ kind: 'lesson', lesson: cancelled });
  await act(async () => {
    await result.current.execute({
      kind: LessonCommand.CANCEL,
      id: lesson.id,
      revision: lesson.revision,
    });
  });
  await act(async () => {
    resolvePoll?.({ kind: 'list', lessons: [lesson] });
    await Promise.resolve();
  });
  expect(result.current.selected?.status).toBe(LessonVideoStatus.CANCELLED);
  expect(result.current.lessons).toEqual([cancelled]);
});

it('retries a failed background refresh and accepts the later saved result', async () => {
  const bridge = installBridge();
  const { result } = renderHook(() => useLessonVideo());
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
  });
  vi.useFakeTimers();
  bridge.mockRejectedValueOnce(new Error('Offline'));
  act(() => {
    result.current.select(lesson);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(result.current.selected?.status).toBe(LessonVideoStatus.RUNNING);
  bridge.mockResolvedValueOnce({
    kind: 'list',
    lessons: [{ ...lesson, status: LessonVideoStatus.READY }],
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(result.current.selected?.status).toBe(LessonVideoStatus.READY);
});
