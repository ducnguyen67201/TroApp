// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  LessonCommand,
  LessonVideoFailure,
  LessonVideoSchema,
  LessonVideoStatus,
  LessonVideoStage,
  type LessonVideo,
  type LessonVideoCommand,
  type LessonVideoReply,
} from '#contracts/LessonVideos.js';
import { LessonVideosPage } from '../../../../src/desktop/renderer/lessonVideos/LessonVideosPage.js';
import { createLessonFixture } from '../../../server/features/lessonVideos/LessonVideoFixtures.js';

vi.mock('@remotion/player', () => ({ Player: () => null }));

type CreateCommand = Extract<LessonVideoCommand, { kind: typeof LessonCommand.CREATE }>;
type CreateLesson = (command: CreateCommand) => Promise<LessonVideoReply>;

const lesson = z.object(LessonVideoSchema.shape).parse({
  ...createLessonFixture(),
  status: LessonVideoStatus.STOPPED,
  error: LessonVideoFailure.CONTENT,
});
const materialId = '22222222-2222-4222-8222-222222222222';

function installBridge(create: CreateLesson, initialLessons: LessonVideo[] = []) {
  let savedLessons = initialLessons;
  const controlLessonVideos = vi
    .fn<NonNullable<DesktopBridge['controlLessonVideos']>>()
    .mockImplementation(async (command): Promise<LessonVideoReply> => {
      if (command.kind === LessonCommand.CREATE) {
        const reply = await create(command);
        if (reply.kind === 'lesson') {
          savedLessons = [
            reply.lesson,
            ...savedLessons.filter((item) => item.id !== reply.lesson.id),
          ];
        }
        return reply;
      }
      if (command.kind === LessonCommand.OPTIONS) {
        return {
          kind: 'options',
          available: true,
          estimatedMicroUsd: 72000,
          maximumMicroUsd: 144000,
          classes: [
            {
              id: lesson.classId,
              name: 'Test class',
              materials: [{ id: materialId, name: 'Class notes' }],
            },
          ],
        };
      }
      if (command.kind === LessonCommand.READ) {
        const saved = savedLessons.find((item) => item.id === command.id);
        return saved
          ? { kind: 'lesson', lesson: saved }
          : { kind: 'failed', code: LessonVideoFailure.UNAVAILABLE };
      }
      if (command.kind === LessonCommand.CANCEL) {
        const saved = savedLessons.find((item) => item.id === command.id);
        if (saved) {
          const cancelled = { ...saved, status: LessonVideoStatus.CANCELLED };
          savedLessons = savedLessons.map((item) => (item.id === saved.id ? cancelled : item));
          return { kind: 'lesson', lesson: cancelled };
        }
      }
      return { kind: 'list', lessons: savedLessons };
    });
  Object.defineProperty(window, 'tro', { configurable: true, value: { controlLessonVideos } });
  return controlLessonVideos;
}

async function prepareCreateForm(create: CreateLesson) {
  const bridge = installBridge(create);
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LessonVideosPage, { locale: 'en' }),
    }),
  );
  await waitFor(() => {
    expect(bridge).toHaveBeenCalledTimes(2);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
  fireEvent.click(screen.getByRole('combobox', { name: 'Class' }));
  fireEvent.click(screen.getByRole('option', { name: 'Test class' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Class notes' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Your instructions' }), {
    target: { value: 'Explain the class notes.' },
  });
  return bridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('creates a fresh job with unchanged inputs after a stopped lesson was acknowledged', async () => {
  const create = vi.fn<CreateLesson>().mockResolvedValue({ kind: 'lesson', lesson });
  await prepareCreateForm(create);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await screen.findByRole('button', { name: 'Back to library' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to library' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await waitFor(() => {
    expect(create).toHaveBeenCalledTimes(2);
  });
  const first = create.mock.calls[0]?.[0];
  const second = create.mock.calls[1]?.[0];
  expect(first).toBeDefined();
  expect(second).toEqual({ ...first, requestId: second?.requestId });
  expect(typeof second?.requestId).toBe('string');
  expect(second?.requestId).not.toBe(first?.requestId);
});

it('retains the request ID when a transport failure leaves creation uncertain', async () => {
  const create = vi
    .fn<CreateLesson>()
    .mockRejectedValueOnce(new Error('Connection closed before the reply.'))
    .mockResolvedValue({ kind: 'lesson', lesson });
  await prepareCreateForm(create);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await screen.findByRole('alert');
  await waitFor(() => {
    expect(
      within(screen.getByRole('dialog'))
        .getByRole('button', { name: 'Create video' })
        .hasAttribute('disabled'),
    ).toBe(false);
  });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await waitFor(() => {
    expect(create).toHaveBeenCalledTimes(2);
  });
  expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
});

it('rotates the request ID after a definitive backend rejection', async () => {
  const create = vi
    .fn<CreateLesson>()
    .mockResolvedValueOnce({ kind: 'failed', code: LessonVideoFailure.INVALID })
    .mockResolvedValue({ kind: 'lesson', lesson });
  await prepareCreateForm(create);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await screen.findByRole('alert');
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await waitFor(() => {
    expect(create).toHaveBeenCalledTimes(2);
  });
  expect(create.mock.calls[1]?.[0].requestId).not.toBe(create.mock.calls[0]?.[0].requestId);
});

it('retains the request ID when main reports an unavailable response with an uncertain outcome', async () => {
  const create = vi
    .fn<CreateLesson>()
    .mockResolvedValueOnce({ kind: 'failed', code: LessonVideoFailure.UNAVAILABLE })
    .mockResolvedValue({ kind: 'lesson', lesson });
  await prepareCreateForm(create);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await screen.findByRole('alert');
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  await waitFor(() => {
    expect(create).toHaveBeenCalledTimes(2);
  });
  expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
});

it('shows a welcoming empty library and opens the creation dialog only on demand', async () => {
  const bridge = installBridge(vi.fn<CreateLesson>().mockResolvedValue({ kind: 'lesson', lesson }));
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LessonVideosPage, { locale: 'vi' }),
    }),
  );
  await waitFor(() => {
    expect(bridge).toHaveBeenCalledTimes(2);
  });
  expect(await screen.findByText('Bài giảng đầu tiên bắt đầu từ một ý tưởng.')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Tạo video đầu tiên' }));
  expect(screen.getByRole('dialog', { name: 'Bạn muốn giải thích điều gì?' })).toBeTruthy();
});

it('keeps a created job in the library when its progress dialog is closed without cancelling', async () => {
  const running = { ...lesson, status: LessonVideoStatus.RUNNING, error: null };
  const bridge = await prepareCreateForm(
    vi.fn<CreateLesson>().mockResolvedValue({ kind: 'lesson', lesson: running }),
  );
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  expect(await screen.findByText('Your lesson is taking shape')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close lesson' }));
  expect(await screen.findByRole('button', { name: 'View progress: Boolean' })).toBeTruthy();
  expect(bridge.mock.calls.some(([command]) => command.kind === LessonCommand.CANCEL)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'View progress: Boolean' }));
  expect(await screen.findByRole('dialog', { name: 'Lesson video generation' })).toBeTruthy();
  await waitFor(() => {
    expect(bridge.mock.calls.some(([command]) => command.kind === LessonCommand.READ)).toBe(true);
  });
});

it('only sends cancellation from the explicit cancel action and retains the draft card', async () => {
  const running = { ...lesson, status: LessonVideoStatus.RUNNING, error: null };
  const bridge = await prepareCreateForm(
    vi.fn<CreateLesson>().mockResolvedValue({ kind: 'lesson', lesson: running }),
  );
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create video' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel generation' }));
  expect(await screen.findByText('Your lesson draft')).toBeTruthy();
  expect(bridge).toHaveBeenCalledWith({
    kind: LessonCommand.CANCEL,
    id: lesson.id,
    revision: lesson.revision,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Back to library' }));
  expect(screen.getByRole('button', { name: 'Open draft: Boolean' })).toBeTruthy();
});

it('shows saved content previews and never downloads video media to populate library cards', async () => {
  const ready = {
    ...lesson,
    status: LessonVideoStatus.READY,
    stage: LessonVideoStage.COMBINE,
    error: null,
  };
  const bridge = installBridge(
    vi.fn<CreateLesson>().mockResolvedValue({ kind: 'lesson', lesson }),
    [ready],
  );
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LessonVideosPage, { locale: 'en' }),
    }),
  );
  const card = await screen.findByRole('button', { name: 'Watch lesson: Boolean' });
  expect(within(card).getByText('Test class')).toBeTruthy();
  expect(bridge.mock.calls.map(([command]) => command.kind)).toEqual([
    LessonCommand.OPTIONS,
    LessonCommand.LIST,
  ]);
  fireEvent.click(card);
  expect(await screen.findByRole('dialog', { name: 'Your lesson' })).toBeTruthy();
});
