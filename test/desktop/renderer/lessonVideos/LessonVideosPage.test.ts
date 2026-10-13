// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  LessonCommand,
  LessonVideoFailure,
  LessonVideoSchema,
  LessonVideoStatus,
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

function installBridge(create: CreateLesson) {
  const controlLessonVideos = vi
    .fn<NonNullable<DesktopBridge['controlLessonVideos']>>()
    .mockImplementation(async (command): Promise<LessonVideoReply> => {
      if (command.kind === LessonCommand.CREATE) {
        return create(command);
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
      return { kind: 'list', lessons: [] };
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
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
  await screen.findByRole('button', { name: /Library/ });
  fireEvent.click(screen.getByRole('button', { name: /Library/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
  await screen.findByRole('alert');
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Create video' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Create video' }));
  await waitFor(() => {
    expect(create).toHaveBeenCalledTimes(2);
  });
  expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
});
