// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  PetRecognitionCategory,
  PetWorldCommandKind,
  PetWorldFailure,
  PetWorldTiming,
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

const period = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('lets a slow refresh finish without adding or superseding it on each polling interval', async () => {
  vi.useFakeTimers();
  let finishRead: ((reply: PetWorldReply) => void) | undefined;
  let ownReads = 0;
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementation((command) => {
      if (command.kind === PetWorldCommandKind.OWN_WORLD) {
        ownReads += 1;
        if (ownReads === 1) {
          return new Promise((resolve) => {
            finishRead = resolve;
          });
        }
        return Promise.resolve({ kind: 'world', world: createOwnWorld('student') });
      }
      return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
    });
  installPetWorldBridge(execute);
  const rendered = renderHook(() => usePetWorld('student', null, period));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PetWorldTiming.REFRESH_MS * 3);
  });
  expect(ownReads).toBe(1);
  await act(async () => {
    finishRead?.({ kind: 'world', world: createOwnWorld('student') });
    await Promise.resolve();
  });
  expect(rendered.result.current.world?.studentId).toBe('student');
  expect(rendered.result.current.isLoading).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PetWorldTiming.REFRESH_MS);
  });
  expect(ownReads).toBe(2);
});

it('restarts history without a stale cursor after recognition changes without a wallet revision', async () => {
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementation((command) => {
      if (command.kind === PetWorldCommandKind.OWN_WORLD) {
        return Promise.resolve({ kind: 'world', world: createOwnWorld('student') });
      }
      if (command.kind === PetWorldCommandKind.OWN_HISTORY) {
        return Promise.resolve(
          command.cursor
            ? { kind: 'failed', code: PetWorldFailure.STALE }
            : {
                kind: 'history',
                walletRevision: 1,
                entries: [],
                recognitions: [],
                nextCursor: 'prior-recognition-revision',
              },
        );
      }
      return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
    });
  installPetWorldBridge(execute);
  const rendered = renderHook(() => usePetWorld('student', null, period));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  await act(async () => {
    await rendered.result.current.readOlderHistory();
  });
  expect(rendered.result.current.history?.nextCursor).toBe('prior-recognition-revision');
  await act(async () => {
    await rendered.result.current.readOlderHistory();
  });
  expect(rendered.result.current.failure).toBe(PetWorldFailure.STALE);
  expect(rendered.result.current.history).toBeNull();
  await act(async () => {
    await rendered.result.current.refresh();
    await rendered.result.current.readOlderHistory();
  });
  expect(
    execute.mock.calls.filter(([command]) => command.kind === PetWorldCommandKind.OWN_HISTORY),
  ).toEqual([
    [{ kind: PetWorldCommandKind.OWN_HISTORY }],
    [{ kind: PetWorldCommandKind.OWN_HISTORY, cursor: 'prior-recognition-revision' }],
    [{ kind: PetWorldCommandKind.OWN_HISTORY }],
  ]);
});

it('drops a browsed history page when a fresh wallet revision arrives', async () => {
  let walletRevision = 1;
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementation((command) => {
      if (command.kind === PetWorldCommandKind.OWN_WORLD) {
        const world = createOwnWorld('student');
        return Promise.resolve({
          kind: 'world',
          world: { ...world, wallet: { ...world.wallet, revision: walletRevision } },
        });
      }
      if (command.kind === PetWorldCommandKind.OWN_HISTORY) {
        return Promise.resolve({
          kind: 'history',
          walletRevision,
          entries: [],
          recognitions: [],
          nextCursor: 'old-wallet-revision',
        });
      }
      return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
    });
  installPetWorldBridge(execute);
  const rendered = renderHook(() => usePetWorld('student', null, period));
  await waitFor(() => {
    expect(rendered.result.current.isLoading).toBe(false);
  });
  await act(async () => {
    await rendered.result.current.readOlderHistory();
  });
  expect(rendered.result.current.history?.walletRevision).toBe(1);
  walletRevision = 2;
  await act(async () => {
    await rendered.result.current.refresh();
  });
  expect(rendered.result.current.history).toBeNull();
  await act(async () => {
    await rendered.result.current.readOlderHistory();
  });
  expect(execute).toHaveBeenLastCalledWith({ kind: PetWorldCommandKind.OWN_HISTORY });
});

it('refreshes the current class when an award finishes after the teacher switches classes', async () => {
  const nextClassId = '66666666-6666-4666-8666-666666666666';
  let finishAward: ((reply: PetWorldReply) => void) | undefined;
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementation((command) => {
      if (command.kind === PetWorldCommandKind.OWN_WORLD) {
        return Promise.resolve({ kind: 'failed', code: PetWorldFailure.FORBIDDEN });
      }
      if (command.kind === PetWorldCommandKind.GRANT_POINTS) {
        return new Promise((resolve) => {
          finishAward = resolve;
        });
      }
      if (command.kind === PetWorldCommandKind.CLASS_RECOGNITION) {
        return Promise.resolve({ ...emptyRecognition, classId: command.classId });
      }
      if (command.kind === PetWorldCommandKind.CLASS_NEIGHBORHOOD) {
        return Promise.resolve({
          kind: 'neighborhood',
          classId: command.classId,
          homes: [],
          garden: { classroomMoments: 0, gardenMilestone: 0 },
        });
      }
      return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
    });
  installPetWorldBridge(
    execute,
    AccountRole.TEACHER,
    [petWorldClassId, nextClassId].flatMap((classId) =>
      teacherClassroom.classes.map((entry) => ({
        ...entry,
        schoolClass: { ...entry.schoolClass, id: classId },
      })),
    ),
  );
  const rendered = renderHook(({ classId }) => usePetWorld('teacher', classId, period), {
    initialProps: { classId: petWorldClassId },
  });
  await waitFor(() => {
    expect(rendered.result.current.recognition?.classId).toBe(petWorldClassId);
  });
  const command: PetWorldCommand = {
    kind: PetWorldCommandKind.GRANT_POINTS,
    requestId: '33333333-3333-4333-8333-333333333333',
    classId: petWorldClassId,
    studentIds: ['student'],
    pointsPerStudent: '5',
    category: PetRecognitionCategory.CURIOSITY,
  };
  let award: Promise<boolean> | undefined;
  await act(async () => {
    award = rendered.result.current.sendCommand(command);
    await Promise.resolve();
  });
  rendered.rerender({ classId: nextClassId });
  await waitFor(() => {
    expect(rendered.result.current.recognition?.classId).toBe(nextClassId);
  });
  await act(async () => {
    finishAward?.({
      kind: 'granted',
      requestId: command.requestId,
      batchId: '44444444-4444-4444-8444-444444444444',
      createdAt: '2026-10-11T00:00:00.000Z',
      recognitions: [
        { id: '55555555-5555-4555-8555-555555555555', studentId: 'student', points: '5' },
      ],
    });
    await award;
  });
  expect(rendered.result.current.recognition?.classId).toBe(nextClassId);
  expect(execute).toHaveBeenLastCalledWith({
    kind: PetWorldCommandKind.CLASS_RECOGNITION,
    classId: nextClassId,
    ...period,
  });
});

it('discards a previous account read that finishes after the account changes', async () => {
  let finishOldRead: ((reply: PetWorldReply) => void) | undefined;
  let ownReads = 0;
  const bridge = {
    executePetWorld: vi
      .fn<NonNullable<DesktopBridge['executePetWorld']>>()
      .mockImplementation((command) => {
        if (command.kind === PetWorldCommandKind.OWN_WORLD) {
          ownReads += 1;
          if (ownReads === 1) {
            return new Promise((resolve) => {
              finishOldRead = resolve;
            });
          }
          return Promise.resolve({ kind: 'world', world: createOwnWorld('second', '20') });
        }
        return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
      }),
    controlClassroom: vi.fn<NonNullable<DesktopBridge['controlClassroom']>>().mockResolvedValue({
      kind: 'home',
      home: { role: AccountRole.STUDENT, isAdmin: false, courses: [], classes: [] },
    }),
    readPetWorldPending: vi
      .fn<NonNullable<DesktopBridge['readPetWorldPending']>>()
      .mockResolvedValue([]),
  } satisfies Pick<DesktopBridge, 'executePetWorld' | 'controlClassroom' | 'readPetWorldPending'>;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const period = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };
  const rendered = renderHook(({ userId }) => usePetWorld(userId, null, period), {
    initialProps: { userId: 'first' },
  });
  await waitFor(() => {
    expect(ownReads).toBe(1);
  });
  rendered.rerender({ userId: 'second' });
  await waitFor(() => {
    expect(rendered.result.current.world?.studentId).toBe('second');
  });
  await act(async () => {
    finishOldRead?.({ kind: 'world', world: createOwnWorld('first', '999') });
    await Promise.resolve();
  });
  expect(rendered.result.current.world?.wallet.balance).toBe('20');
  expect(rendered.result.current.world?.studentId).toBe('second');
});

it('keeps the last confirmed wallet when a purchase result is unknown and exposes its original intent', async () => {
  const command = {
    kind: PetWorldCommandKind.BUY_ITEM,
    requestId: '33333333-3333-4333-8333-333333333333',
    itemId: 'little-fern',
    catalogRevision: 'one',
    displayedPrice: '10',
    equipAfterPurchase: false,
    expectedWorldRevision: 1,
  } as const;
  let pending = false;
  const bridge = {
    executePetWorld: vi
      .fn<NonNullable<DesktopBridge['executePetWorld']>>()
      .mockImplementation((input) => {
        if (input.kind === PetWorldCommandKind.OWN_WORLD) {
          return Promise.resolve({ kind: 'world', world: createOwnWorld('student') });
        }
        if (input.kind === PetWorldCommandKind.BUY_ITEM) {
          pending = true;
          return Promise.resolve({ kind: 'failed', code: 'unavailable' });
        }
        return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
      }),
    controlClassroom: vi.fn<NonNullable<DesktopBridge['controlClassroom']>>().mockResolvedValue({
      kind: 'home',
      home: { role: AccountRole.STUDENT, isAdmin: false, courses: [], classes: [] },
    }),
    readPetWorldPending: vi
      .fn<NonNullable<DesktopBridge['readPetWorldPending']>>()
      .mockImplementation(() => Promise.resolve(pending ? [command] : [])),
  } satisfies Pick<DesktopBridge, 'executePetWorld' | 'controlClassroom' | 'readPetWorldPending'>;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const period = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };
  const rendered = renderHook(() => usePetWorld('student', null, period));
  await waitFor(() => {
    expect(rendered.result.current.world?.wallet.balance).toBe('20');
  });
  await act(async () => {
    await rendered.result.current.sendCommand(command);
  });
  expect(rendered.result.current.world?.wallet.balance).toBe('20');
  expect(rendered.result.current.pendingCommands).toEqual([command]);
});

it('reads recognition only for the selected assigned teacher class in a mixed-role home', async () => {
  const joinedClassId = '66666666-6666-4666-8666-666666666666';
  const execute = vi
    .fn<NonNullable<DesktopBridge['executePetWorld']>>()
    .mockImplementation((command) => {
      if (command.kind === PetWorldCommandKind.OWN_WORLD) {
        return Promise.resolve({ kind: 'world', world: createOwnWorld('teacher') });
      }
      if (command.kind === PetWorldCommandKind.CLASS_NEIGHBORHOOD) {
        return Promise.resolve({
          kind: 'neighborhood',
          classId: command.classId,
          homes: [],
          garden: { classroomMoments: 0, gardenMilestone: 0 },
        });
      }
      if (command.kind === PetWorldCommandKind.CLASS_RECOGNITION) {
        return Promise.resolve({ ...emptyRecognition, classId: command.classId });
      }
      return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
    });
  installPetWorldBridge(execute, AccountRole.TEACHER, [
    ...teacherClassroom.classes.map((entry) => ({ ...entry, canTeach: true })),
    ...teacherClassroom.classes.map((entry) => ({
      ...entry,
      canTeach: false,
      schoolClass: { ...entry.schoolClass, id: joinedClassId, teacherId: 'another-teacher' },
    })),
  ]);
  const rendered = renderHook(({ classId }) => usePetWorld('teacher', classId, period), {
    initialProps: { classId: petWorldClassId },
  });
  await waitFor(() => {
    expect(rendered.result.current.recognition?.classId).toBe(petWorldClassId);
  });
  rendered.rerender({ classId: joinedClassId });
  await waitFor(() => {
    expect(rendered.result.current.neighborhood?.classId).toBe(joinedClassId);
  });
  expect(rendered.result.current.recognition).toBeNull();
  expect(rendered.result.current.world?.studentId).toBe('teacher');
  expect(rendered.result.current.failure).toBeNull();
  expect(
    execute.mock.calls.filter(
      ([command]) =>
        command.kind === PetWorldCommandKind.CLASS_RECOGNITION && command.classId === joinedClassId,
    ),
  ).toEqual([]);
});
