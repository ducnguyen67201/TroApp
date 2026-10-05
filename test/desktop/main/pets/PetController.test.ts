import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPetPreferences,
  PetAction,
  PetFailure,
  PetId,
  PetMotion,
  PetReaction,
  type PetPreferences,
  type PetSnapshot,
} from '#contracts/Pet.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  PetController,
  type PetStore,
  type PetPresentation,
  type PetClock,
} from '../../../../src/desktop/main/pets/PetController.js';

function createHarness() {
  const store = {
    readPreferences: vi.fn<PetStore['readPreferences']>().mockResolvedValue(createPetPreferences()),
    savePreferences: vi.fn<PetStore['savePreferences']>().mockResolvedValue(),
  } satisfies PetStore;
  const presentation = {
    showPet: vi.fn<PetPresentation['showPet']>(),
    hidePet: vi.fn<PetPresentation['hidePet']>(),
  } satisfies PetPresentation;
  const clock: PetClock = {
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
  };
  const emit = vi.fn<(snapshot: PetSnapshot) => void>();
  return {
    store,
    presentation,
    emit,
    controller: new PetController(store, presentation, clock, emit),
  };
}

const adoption = {
  kind: PetAction.ADOPT,
  petId: PetId.FOX,
  name: 'Maple',
  locale: DesktopLocale.ENGLISH,
} as const;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('local pet lifecycle', () => {
  it('adopts only after a successful save, preserves names and recovers from save failure', async () => {
    const { controller, store, presentation } = createHarness();
    await controller.setAccount('student');
    expect(controller.readSnapshot().isVisible).toBe(false);
    store.savePreferences.mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await controller.executeCommand(adoption)).toEqual({
      kind: 'failed',
      reason: PetFailure.SAVE,
    });
    expect(presentation.showPet).not.toHaveBeenCalled();
    expect((await controller.executeCommand(adoption)).kind).toBe('ok');
    expect(controller.readSnapshot()).toMatchObject({
      isVisible: true,
      preferences: { activePetId: PetId.FOX, names: { cat: 'Mochi', fox: 'Maple' } },
    });
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fences late preference loads and in-flight adoption across sign-out', async () => {
    const { controller, store, presentation } = createHarness();
    let completeRead: ((preferences: PetPreferences) => void) | undefined;
    store.readPreferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeRead = resolve;
        }),
    );
    const loading = controller.setAccount('old-student');
    await controller.setAccount('new-student');
    completeRead?.({ ...createPetPreferences(), enabled: true });
    await loading;
    expect(presentation.showPet).not.toHaveBeenCalled();
    let completeSave: (() => void) | undefined;
    store.savePreferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }),
    );
    const adopting = controller.executeCommand(adoption);
    await vi.waitFor(() => {
      expect(store.savePreferences).toHaveBeenCalledOnce();
    });
    controller.dispose();
    completeSave?.();
    expect(await adopting).toEqual({ kind: 'failed', reason: PetFailure.UNAVAILABLE });
    expect(presentation.showPet).not.toHaveBeenCalled();
  });

  it('serializes concurrent changes without losing adoption or quiet preferences', async () => {
    const { controller, store } = createHarness();
    await controller.setAccount('student');
    const adopt = controller.executeCommand(adoption);
    const quiet = controller.executeCommand({
      kind: PetAction.PREFERENCES,
      quiet: true,
      motion: PetMotion.REDUCED,
      locale: DesktopLocale.ENGLISH,
    });
    await Promise.all([adopt, quiet]);
    expect(controller.readSnapshot().preferences).toMatchObject({
      activePetId: PetId.FOX,
      enabled: true,
      quiet: true,
      motion: PetMotion.REDUCED,
    });
    expect(store.savePreferences).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('coalesces reactions and suppresses optional presentation during work', async () => {
    const { controller } = createHarness();
    await controller.setAccount('student');
    await controller.executeCommand(adoption);
    controller.reactToPet(PetReaction.HAPPY);
    vi.advanceTimersByTime(500);
    controller.reactToPet(PetReaction.STARTLED);
    vi.advanceTimersByTime(500);
    expect(controller.readSnapshot().reaction).toBe(PetReaction.STARTLED);
    controller.setSuspended(true);
    expect(controller.readSnapshot().isVisible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    controller.setSuspended(false);
    expect(controller.readSnapshot()).toMatchObject({
      isVisible: true,
      reaction: PetReaction.IDLE,
    });
    controller.dispose();
  });

  it('uses bounded encouragement and clears all timers when hidden', async () => {
    const { controller } = createHarness();
    await controller.setAccount('student');
    await controller.executeCommand(adoption);
    vi.advanceTimersByTime(599_999);
    expect(controller.readSnapshot().encouragement).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.readSnapshot().encouragement).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(controller.readSnapshot().encouragement).toBe(false);
    await controller.executeCommand({ kind: PetAction.HIDE });
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.readSnapshot().isVisible).toBe(false);
  });

  it('does not retry a failed overlay until the student explicitly updates it', async () => {
    const { controller, presentation } = createHarness();
    await controller.setAccount('student');
    await controller.executeCommand(adoption);
    controller.markPresentationFailed();
    const calls = presentation.showPet.mock.calls.length;
    controller.setSuspended(true);
    controller.setSuspended(false);
    expect(presentation.showPet).toHaveBeenCalledTimes(calls);
    expect(controller.readSnapshot()).toMatchObject({
      isVisible: false,
      hasPresentationError: true,
    });
    await controller.executeCommand(adoption);
    expect(controller.readSnapshot().isVisible).toBe(true);
    controller.dispose();
  });
});
