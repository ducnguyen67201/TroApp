// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  PetRecognitionCategory,
  PetWalletEntryKind,
  PetWorldCommandKind,
  PetWorldFailure,
  PetWorldTiming,
  type PetRecognition,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import { usePetWorld } from '../../../../src/desktop/renderer/petWorld/UsePetWorld.js';
import {
  createOwnWorld,
  emptyRecognition,
  installPetWorldBridge,
  petWorldClassId,
  teacherClassroom,
} from './PetWorldFixtures.js';

const period = { from: emptyRecognition.from, to: emptyRecognition.to };
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const thirdId = '33333333-3333-4333-8333-333333333333';

type PageCommand = Extract<
  PetWorldCommand,
  {
    kind: typeof PetWorldCommandKind.OWN_HISTORY | typeof PetWorldCommandKind.CLASS_RECOGNITION;
  }
>;

function installPaginationBridge(
  role: AccountRole,
  readPage: (command: PageCommand) => PetWorldReply | Promise<PetWorldReply>,
  readTeacherId: () => string = () => 'teacher',
): ReturnType<typeof vi.fn<NonNullable<DesktopBridge['executePetWorld']>>> {
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementation(async (command) => {
      if (
        command.kind === PetWorldCommandKind.OWN_HISTORY ||
        command.kind === PetWorldCommandKind.CLASS_RECOGNITION
      ) {
        return await readPage(command);
      }
      if (command.kind === PetWorldCommandKind.OWN_WORLD) {
        return { kind: 'world', world: createOwnWorld('student') };
      }
      if (command.kind === PetWorldCommandKind.CLASS_NEIGHBORHOOD) {
        return {
          kind: 'neighborhood',
          classId: command.classId,
          homes: [],
          garden: { classroomMoments: 0, gardenMilestone: 0 },
        };
      }
      return { kind: 'catalog', catalog: { revision: 'one', items: [] } };
    });
  installPetWorldBridge(execute, role);
  window.tro.controlClassroom = vi
    .fn<NonNullable<DesktopBridge['controlClassroom']>>()
    .mockImplementation(() =>
      Promise.resolve({
        kind: 'home',
        home: {
          ...teacherClassroom,
          role,
          classes: [petWorldClassId, secondId].flatMap((classId) =>
            teacherClassroom.classes.map((entry) => ({
              ...entry,
              canTeach: role === AccountRole.TEACHER,
              schoolClass: { ...entry.schoolClass, id: classId, teacherId: readTeacherId() },
            })),
          ),
        },
      }),
    );
  return execute;
}

function createRecognition(id: string): PetRecognition {
  return {
    id,
    classId: petWorldClassId,
    teacherId: 'teacher',
    studentId: 'student',
    batchId: id,
    points: '5',
    category: PetRecognitionCategory.CURIOSITY,
    note: id,
    classSessionId: null,
    activityId: null,
    createdAt: '2026-10-11T00:00:00.000Z',
    correction: null,
  };
}

function createHistoryPage(
  id: string,
  nextCursor: string | null,
): Extract<PetWorldReply, { kind: 'history' }> {
  return {
    kind: 'history',
    walletRevision: 1,
    entries: [
      {
        id,
        kind: PetWalletEntryKind.TEACHER_GRANT,
        delta: '5',
        sourceId: id,
        createdAt: '2026-10-11T00:00:00.000Z',
      },
    ],
    recognitions: [createRecognition(id)],
    nextCursor,
  };
}

function createRecognitionPage(
  id: string,
  nextCursor: string | null,
): Extract<PetWorldReply, { kind: 'class-recognition' }> {
  return { ...emptyRecognition, recognitions: [createRecognition(id)], nextCursor };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('accumulates owner entries and recognitions through the final page and preserves them on refresh', async () => {
  const execute = installPaginationBridge(AccountRole.STUDENT, (command) => {
    if (!command.cursor) {
      return createHistoryPage(firstId, 'second');
    }
    return command.cursor === 'second'
      ? createHistoryPage(secondId, 'third')
      : createHistoryPage(thirdId, null);
  });
  const rendered = renderHook(() => usePetWorld('student', null, period));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  for (let page = 0; page < 3; page += 1) {
    await act(async () => {
      await rendered.result.current.readOlderHistory();
    });
  }
  await act(async () => {
    await rendered.result.current.refresh();
    await rendered.result.current.readOlderHistory();
  });
  expect(rendered.result.current.history?.entries.map((entry) => entry.id)).toEqual([
    firstId,
    secondId,
    thirdId,
  ]);
  expect(
    rendered.result.current.history?.recognitions.map((recognition) => recognition.id),
  ).toEqual([firstId, secondId, thirdId]);
  expect(rendered.result.current.history?.nextCursor).toBeNull();
  expect(
    execute.mock.calls.filter(([command]) => command.kind === PetWorldCommandKind.OWN_HISTORY),
  ).toHaveLength(3);
});

it('does not duplicate owner rows when the same cursor is requested twice', async () => {
  const execute = installPaginationBridge(AccountRole.STUDENT, (command) =>
    command.cursor ? createHistoryPage(secondId, null) : createHistoryPage(firstId, 'second'),
  );
  const rendered = renderHook(() => usePetWorld('student', null, period));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  await act(async () => {
    await rendered.result.current.readOlderHistory();
  });
  await act(async () => {
    await Promise.all([
      rendered.result.current.readOlderHistory(),
      rendered.result.current.readOlderHistory(),
    ]);
  });
  expect(rendered.result.current.history?.entries.map((entry) => entry.id)).toEqual([
    firstId,
    secondId,
  ]);
  expect(
    execute.mock.calls.filter(([command]) => command.kind === PetWorldCommandKind.OWN_HISTORY),
  ).toHaveLength(3);
});

it('preserves all loaded teacher pages and their final cursor during polling', async () => {
  vi.useFakeTimers();
  installPaginationBridge(AccountRole.TEACHER, (command) =>
    command.cursor
      ? createRecognitionPage(secondId, null)
      : createRecognitionPage(firstId, 'second'),
  );
  const rendered = renderHook(() => usePetWorld('teacher', petWorldClassId, period));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await rendered.result.current.readOlderRecognitions();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PetWorldTiming.REFRESH_MS);
  });
  expect(
    rendered.result.current.recognition?.recognitions.map((recognition) => recognition.id),
  ).toEqual([firstId, secondId]);
  expect(rendered.result.current.recognition?.nextCursor).toBeNull();
});

it('accepts an older teacher page even when an unchanged refresh starts while it is pending', async () => {
  let finishPage: ((reply: PetWorldReply) => void) | undefined;
  installPaginationBridge(AccountRole.TEACHER, (command) => {
    if (command.cursor) {
      return new Promise((resolve) => {
        finishPage = resolve;
      });
    }
    return createRecognitionPage(firstId, 'second');
  });
  const rendered = renderHook(() => usePetWorld('teacher', petWorldClassId, period));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  let page: Promise<void> | undefined;
  act(() => {
    page = rendered.result.current.readOlderRecognitions();
  });
  await act(async () => {
    await rendered.result.current.refresh();
    finishPage?.(createRecognitionPage(secondId, null));
    await page;
  });
  expect(
    rendered.result.current.recognition?.recognitions.map((recognition) => recognition.id),
  ).toEqual([firstId, secondId]);
});

it('resets teacher pages when the dataset changes and ignores the previous pending cursor reply', async () => {
  let changed = false;
  let finishPage: ((reply: PetWorldReply) => void) | undefined;
  installPaginationBridge(AccountRole.TEACHER, (command) => {
    if (command.cursor) {
      return new Promise((resolve) => {
        finishPage = resolve;
      });
    }
    return changed
      ? createRecognitionPage(thirdId, 'new-second')
      : createRecognitionPage(firstId, 'second');
  });
  const rendered = renderHook(() => usePetWorld('teacher', petWorldClassId, period));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  let page: Promise<void> | undefined;
  act(() => {
    page = rendered.result.current.readOlderRecognitions();
  });
  changed = true;
  await act(async () => {
    await rendered.result.current.refresh();
    finishPage?.(createRecognitionPage(secondId, null));
    await page;
  });
  expect(
    rendered.result.current.recognition?.recognitions.map((recognition) => recognition.id),
  ).toEqual([thirdId]);
  expect(rendered.result.current.recognition?.nextCursor).toBe('new-second');
});

it('recovers an expired teacher cursor by reading the latest first page without the cursor', async () => {
  let changed = false;
  const execute = installPaginationBridge(AccountRole.TEACHER, (command) => {
    if (command.cursor) {
      changed = true;
      return { kind: 'failed', code: PetWorldFailure.STALE };
    }
    return changed
      ? createRecognitionPage(thirdId, 'new-second')
      : createRecognitionPage(firstId, 'second');
  });
  const rendered = renderHook(() => usePetWorld('teacher', petWorldClassId, period));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  await act(async () => {
    await rendered.result.current.readOlderRecognitions();
  });
  expect(
    rendered.result.current.recognition?.recognitions.map((recognition) => recognition.id),
  ).toEqual([thirdId]);
  expect(execute).toHaveBeenLastCalledWith({
    kind: PetWorldCommandKind.CLASS_RECOGNITION,
    classId: petWorldClassId,
    ...period,
  });
});

it.each(['class', 'period', 'account'] as const)(
  'discards an older teacher page after the %s changes',
  async (selection) => {
    let currentTeacherId = 'teacher';
    let finishPage: ((reply: PetWorldReply) => void) | undefined;
    installPaginationBridge(
      AccountRole.TEACHER,
      (command) => {
        if (command.kind !== PetWorldCommandKind.CLASS_RECOGNITION) {
          throw new Error('Expected a teacher page request.');
        }
        if (command.cursor) {
          return new Promise((resolve) => {
            finishPage = resolve;
          });
        }
        return {
          ...createRecognitionPage(
            command.classId === secondId || command.from !== period.from ? thirdId : firstId,
            'second',
          ),
          classId: command.classId,
          from: command.from,
          to: command.to,
        };
      },
      () => currentTeacherId,
    );
    const rendered = renderHook(
      ({ userId, classId, selectedPeriod }) => usePetWorld(userId, classId, selectedPeriod),
      {
        initialProps: { userId: 'teacher', classId: petWorldClassId, selectedPeriod: period },
      },
    );
    await waitFor(() => {
      expect(rendered.result.current.isLoading).toBe(false);
    });
    let page: Promise<void> | undefined;
    act(() => {
      page = rendered.result.current.readOlderRecognitions();
    });
    currentTeacherId = selection === 'account' ? 'other-teacher' : 'teacher';
    rendered.rerender({
      userId: currentTeacherId,
      classId: selection === 'class' ? secondId : petWorldClassId,
      selectedPeriod:
        selection === 'period' ? { ...period, from: '2026-10-02T00:00:00.000Z' } : period,
    });
    await waitFor(() => {
      expect(rendered.result.current.recognition).not.toBeNull();
    });
    await act(async () => {
      finishPage?.(createRecognitionPage(secondId, null));
      await page;
    });
    expect(
      rendered.result.current.recognition?.recognitions.map((recognition) => recognition.id),
    ).toEqual([selection === 'account' ? firstId : thirdId]);
    expect(rendered.result.current.recognition?.nextCursor).toBe('second');
  },
);
