import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PetId,
  createPetPreferences,
  PetReaction,
  PetBackdropId,
  type PetSnapshot,
} from '#contracts/Pet.js';
import {
  PetOwnWorldSchema,
  PetWorldCommandKind,
  PetWorldFailure,
  PetRecognitionCategory,
  PetWorldTiming,
  type PetWorldCommand,
  type PetWorldReply,
} from '#contracts/PetWorld.js';
import type { AuthResult } from '#contracts/AuthSession.js';
import { AccountTransitionGate } from '../../../../src/desktop/main/accounts/AccountTransitionGate.js';
import type { PetController } from '../../../../src/desktop/main/pets/PetController.js';
import { PetWorldController } from '../../../../src/desktop/main/petWorld/PetWorldController.js';
import type { PetWorldApiClient } from '../../../../src/desktop/main/petWorld/PetWorldApiClient.js';
import {
  createPetWorldLocalState,
  type PetWorldLocalState,
  type PetWorldLocalStore,
} from '../../../../src/desktop/main/petWorld/PetWorldLocalState.js';

const requestId = 'a399b31a-c33c-4f32-9c96-f76dd22cba3c';
const batchId = 'b399b31a-c33c-4f32-9c96-f76dd22cba3c';
const classId = 'c399b31a-c33c-4f32-9c96-f76dd22cba3c';
const recognitionId = 'd399b31a-c33c-4f32-9c96-f76dd22cba3c';
const controllers: PetWorldController[] = [];

function createWorld(revision = 1): Extract<PetWorldReply, { kind: 'world' }> {
  return {
    kind: 'world',
    world: PetOwnWorldSchema.parse({
      studentId: 'student',
      wallet: { balance: '50', revision },
      profile: {
        activePetId: PetId.FOX,
        names: { cat: 'Clover', fox: 'Fern' },
        revision,
        slots: { garden: null, home: null, feature: null },
        backdropItemId: 'meadow',
        outfitItemId: null,
      },
      inventory: [],
      entries: [],
      recognitions: [],
      shares: [],
    }),
  };
}

const grant: PetWorldCommand = {
  kind: PetWorldCommandKind.GRANT_POINTS,
  requestId,
  classId,
  studentIds: ['student'],
  pointsPerStudent: '50',
  category: PetRecognitionCategory.PERSISTENCE,
};

const granted: PetWorldReply = {
  kind: 'granted',
  requestId,
  batchId,
  createdAt: '2026-10-11T12:00:00.000Z',
  recognitions: [{ id: recognitionId, studentId: 'student', points: '50' }],
};

function createHarness(savedState = createPetWorldLocalState()) {
  let state = structuredClone(savedState);
  const store = {
    readState: vi
      .fn<PetWorldLocalStore['readState']>()
      .mockImplementation(() => Promise.resolve(structuredClone(state))),
    saveState: vi.fn<PetWorldLocalStore['saveState']>().mockImplementation((_account, next) => {
      state = structuredClone(next);
      return Promise.resolve();
    }),
  } satisfies PetWorldLocalStore;
  const snapshot: PetSnapshot = {
    revision: 1,
    preferences: {
      ...createPetPreferences(),
      activePetId: PetId.CAT,
      names: { cat: 'Local cat', fox: 'Local fox' },
    },
    reaction: PetReaction.IDLE,
    isVisible: false,
    hasPresentationError: false,
    encouragement: false,
    backdropId: null,
  };
  const pets = {
    setAccount: vi.fn<PetController['setAccount']>().mockResolvedValue(),
    readSnapshot: vi
      .fn<PetController['readSnapshot']>()
      .mockImplementation(() => structuredClone(snapshot)),
    applyCloudAppearance: vi.fn<PetController['applyCloudAppearance']>(),
    executeCommand: vi
      .fn<PetController['executeCommand']>()
      .mockResolvedValue({ kind: 'ok', snapshot }),
  };
  const api = {
    execute: vi
      .fn<PetWorldApiClient['execute']>()
      .mockResolvedValue({ kind: 'failed', code: PetWorldFailure.UNAVAILABLE }),
  };
  const readSession = vi.fn<() => Promise<AuthResult>>().mockResolvedValue({
    kind: 'signed-in',
    user: { id: 'student', name: 'Student', email: 'student@example.test' },
  });
  const controller = new PetWorldController(
    api,
    new AccountTransitionGate(
      () => false,
      () => false,
    ),
    store,
    pets,
    readSession,
    () => requestId,
  );
  controllers.push(controller);
  return { controller, store, pets, api, readSession, readState: (): PetWorldLocalState => state };
}

afterEach(() => {
  controllers.forEach((controller) => {
    controller.dispose();
  });
  controllers.length = 0;
  vi.useRealTimers();
});

describe('pet world desktop synchronization', () => {
  it('keeps one companion poll in flight when the API takes longer than the refresh interval', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.pets.readSnapshot.mockReturnValue({
      ...harness.pets.readSnapshot(),
      isVisible: true,
    });
    let finishPoll: ((reply: PetWorldReply) => void) | undefined;
    harness.api.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve;
        }),
    );
    await harness.controller.setAccount('student');
    await vi.advanceTimersByTimeAsync(PetWorldTiming.REFRESH_MS * 3);
    expect(harness.api.execute).toHaveBeenCalledOnce();
    finishPoll?.({ kind: 'failed', code: PetWorldFailure.UNAVAILABLE });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PetWorldTiming.REFRESH_MS);
    expect(harness.api.execute).toHaveBeenCalledTimes(2);
  });

  it('shares account initialization across concurrent initial reads', async () => {
    const harness = createHarness();
    await Promise.all([
      harness.controller.execute({ kind: PetWorldCommandKind.CATALOG }, () => true),
      harness.controller.execute({ kind: PetWorldCommandKind.OWN_HISTORY }, () => true),
      harness.controller.readPending(() => true),
    ]);
    expect(harness.pets.setAccount).toHaveBeenCalledTimes(1);
    expect(harness.api.execute).toHaveBeenCalledTimes(2);
  });

  it('persists the exact intent before dispatch and retains it on an uncertain outcome', async () => {
    const harness = createHarness();
    harness.api.execute.mockImplementation((command) => {
      expect(harness.readState().pending).toEqual([command]);
      return Promise.resolve<PetWorldReply>({ kind: 'failed', code: PetWorldFailure.UNAVAILABLE });
    });
    await harness.controller.execute(grant, () => true);
    expect(await harness.controller.readPending(() => true)).toEqual([grant]);
    harness.controller.dispose();
    const restarted = createHarness(harness.readState());
    expect(await restarted.controller.readPending(() => true)).toEqual([grant]);
    expect(restarted.api.execute).not.toHaveBeenCalled();
    restarted.api.execute.mockResolvedValueOnce(granted);
    expect(await restarted.controller.execute(grant, () => true)).toEqual(granted);
    expect(restarted.api.execute).toHaveBeenCalledWith(grant, expect.any(AbortSignal));
    expect(restarted.readState().pending).toEqual([]);
  });

  it('does not dispatch when retaining the intent fails', async () => {
    const harness = createHarness();
    harness.store.saveState.mockRejectedValue(new Error('disk unavailable'));
    expect(await harness.controller.execute(grant, () => true)).toEqual({
      kind: 'failed',
      code: PetWorldFailure.UNAVAILABLE,
    });
    expect(harness.api.execute).not.toHaveBeenCalled();
  });

  it('keeps a retained intent without dispatching when the window closes during its save', async () => {
    const harness = createHarness();
    const saveState = harness.store.saveState.getMockImplementation();
    let completeSave: (() => void) | undefined;
    harness.store.saveState.mockImplementationOnce(
      (accountId, state) =>
        new Promise<void>((resolve, reject) => {
          completeSave = () => {
            void saveState?.(accountId, state).then(resolve, reject);
          };
        }),
    );
    const request = harness.controller.execute(grant, () => true);
    await vi.waitFor(() => {
      expect(completeSave).toBeDefined();
    });
    harness.controller.dispose();
    completeSave?.();
    expect(await request).toEqual({ kind: 'failed', code: PetWorldFailure.STALE });
    expect(harness.api.execute).not.toHaveBeenCalled();
    expect(harness.readState().pending).toEqual([grant]);
  });

  it('finishes the previous save before reloading intents for the same account', async () => {
    const harness = createHarness();
    let completeSave: (() => void) | undefined;
    harness.store.saveState.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeSave = resolve;
        }),
    );
    const request = harness.controller.execute(grant, () => true);
    await vi.waitFor(() => {
      expect(completeSave).toBeDefined();
    });
    harness.controller.dispose();
    const newerIntent: PetWorldCommand = { ...grant, requestId: batchId };
    harness.store.readState.mockResolvedValueOnce({
      version: 1,
      appearance: null,
      pending: [newerIntent],
    });
    harness.store.readState.mockClear();
    const reload = harness.controller.setAccount('student');
    expect(harness.store.readState).not.toHaveBeenCalled();
    completeSave?.();
    expect(await request).toEqual({ kind: 'failed', code: PetWorldFailure.STALE });
    await reload;
    expect(await harness.controller.readPending(() => true)).toEqual([newerIntent]);
    expect(harness.api.execute).not.toHaveBeenCalled();
  });

  it('discards an authentication result that arrives after disposal', async () => {
    const harness = createHarness();
    let completeSession: ((session: AuthResult) => void) | undefined;
    harness.readSession.mockImplementationOnce(
      () =>
        new Promise<AuthResult>((resolve) => {
          completeSession = resolve;
        }),
    );
    const request = harness.controller.execute(grant, () => true);
    await vi.waitFor(() => {
      expect(completeSession).toBeDefined();
    });
    harness.controller.dispose();
    completeSession?.({
      kind: 'signed-in',
      user: { id: 'student', name: 'Student', email: 'student@example.test' },
    });
    expect(await request).toEqual({ kind: 'failed', code: PetWorldFailure.STALE });
    expect(harness.pets.setAccount).not.toHaveBeenCalled();
    expect(harness.api.execute).not.toHaveBeenCalled();
  });

  it('keeps the original unresolved intent when its key is reused for edited content', async () => {
    const harness = createHarness({ version: 1, appearance: null, pending: [grant] });
    expect(
      await harness.controller.execute({ ...grant, pointsPerStudent: '51' }, () => true),
    ).toEqual({ kind: 'failed', code: PetWorldFailure.REQUEST_CONFLICT });
    expect(harness.api.execute).not.toHaveBeenCalled();
    expect(harness.readState().pending).toEqual([grant]);
  });

  it('removes a definitively rejected stale intent so a new choice can be made', async () => {
    const harness = createHarness();
    harness.api.execute.mockResolvedValue({ kind: 'failed', code: PetWorldFailure.STALE });
    await harness.controller.execute(grant, () => true);
    expect(harness.readState().pending).toEqual([]);
  });

  it('imports both local names once and applies the authoritative cloud profile', async () => {
    const harness = createHarness();
    let initialized = false;
    harness.api.execute.mockImplementation((command) => {
      if (command.kind === PetWorldCommandKind.OWN_WORLD) {
        const world = createWorld();
        return Promise.resolve<PetWorldReply>(
          initialized ? world : { kind: 'world', world: { ...world.world, profile: null } },
        );
      }
      if (command.kind === PetWorldCommandKind.INITIALIZE_WORLD) {
        expect(command.names).toEqual({ cat: 'Local cat', fox: 'Local fox' });
        initialized = true;
        return Promise.resolve<PetWorldReply>({
          kind: 'ok',
          requestId,
          walletRevision: 1,
          worldRevision: 1,
        });
      }
      if (command.kind === PetWorldCommandKind.CATALOG) {
        return Promise.resolve<PetWorldReply>({
          kind: 'catalog',
          catalog: {
            revision: '1',
            items: [
              {
                id: 'meadow',
                assetId: 'meadow',
                name: 'Meadow',
                description: '',
                price: '10',
                category: 'backdrop',
                slot: null,
                petIds: [PetId.CAT, PetId.FOX],
                available: true,
              },
            ],
          },
        });
      }
      return Promise.resolve<PetWorldReply>({ kind: 'failed', code: PetWorldFailure.INVALID });
    });
    expect(
      (await harness.controller.execute({ kind: PetWorldCommandKind.OWN_WORLD }, () => true)).kind,
    ).toBe('world');
    await harness.controller.execute({ kind: PetWorldCommandKind.OWN_WORLD }, () => true);
    expect(
      harness.api.execute.mock.calls.filter(
        ([command]) => command.kind === PetWorldCommandKind.INITIALIZE_WORLD,
      ),
    ).toHaveLength(1);
    expect(harness.pets.applyCloudAppearance).toHaveBeenLastCalledWith('student', {
      revision: 1,
      activePetId: PetId.FOX,
      names: { cat: 'Clover', fox: 'Fern' },
      backdropId: PetBackdropId.MEADOW,
    });
  });

  it('rejects old snapshots and fences an in-flight reply after disposal', async () => {
    const harness = createHarness();
    harness.api.execute.mockResolvedValueOnce(createWorld(5));
    harness.api.execute.mockResolvedValueOnce({
      kind: 'catalog',
      catalog: { revision: '1', items: [] },
    });
    await harness.controller.execute({ kind: PetWorldCommandKind.OWN_WORLD }, () => true);
    harness.api.execute.mockResolvedValueOnce(createWorld(4));
    expect(
      await harness.controller.execute({ kind: PetWorldCommandKind.OWN_WORLD }, () => true),
    ).toEqual({ kind: 'failed', code: PetWorldFailure.STALE });
    let complete: ((reply: PetWorldReply) => void) | undefined;
    harness.api.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const request = harness.controller.execute({ kind: PetWorldCommandKind.OWN_WORLD }, () => true);
    await vi.waitFor(() => {
      expect(complete).toBeDefined();
    });
    const applications = harness.pets.applyCloudAppearance.mock.calls.length;
    harness.controller.dispose();
    complete?.(createWorld(6));
    expect(await request).toEqual({ kind: 'failed', code: PetWorldFailure.STALE });
    expect(harness.pets.applyCloudAppearance).toHaveBeenCalledTimes(applications);
  });
});
