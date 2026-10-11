// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { PetWorldCommandKind, type PetWorldReply } from '#contracts/PetWorld.js';
import { usePetWorld } from '../../../../src/desktop/renderer/petWorld/UsePetWorld.js';
import { createOwnWorld } from './PetWorldFixtures.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
      home: { role: AccountRole.STUDENT, courses: [], classes: [] },
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
      home: { role: AccountRole.STUDENT, courses: [], classes: [] },
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
