import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  createPetPreferences,
  PetAction,
  PetId,
  PetReaction,
  type PetSnapshot,
} from '#contracts/Pet.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

const doubles = vi.hoisted(() => {
  const exposed: { bridge: DesktopBridge | null } = { bridge: null };
  const listeners = new Map<string, (event: unknown, raw: unknown) => void>();
  return {
    exposed,
    listeners,
    invoke: vi.fn<(channel: string, command?: unknown) => Promise<unknown>>(),
    send: vi.fn<(channel: string, command: unknown) => void>(),
    exposeInMainWorld: (name: string, bridge: DesktopBridge) => {
      if (name === 'tro') {
        exposed.bridge = bridge;
      }
    },
    on: (channel: string, callback: (event: unknown, raw: unknown) => void) => {
      listeners.set(channel, callback);
    },
    removeListener: (channel: string) => {
      listeners.delete(channel);
    },
  };
});
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: doubles.exposeInMainWorld },
  ipcRenderer: {
    invoke: doubles.invoke,
    send: doubles.send,
    on: doubles.on,
    removeListener: doubles.removeListener,
  },
}));
await import('../../../src/desktop/preload/Preload.js');
const { petOverlayBridge } = await import('../../../src/desktop/preload/PetPreload.js');

const snapshot: PetSnapshot = {
  revision: 1,
  preferences: createPetPreferences(),
  reaction: PetReaction.IDLE,
  isVisible: false,
  hasPresentationError: false,
  encouragement: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  doubles.listeners.clear();
});

describe('pet preload boundaries', () => {
  it('validates commands, replies and subscribed snapshots', async () => {
    const bridge = doubles.exposed.bridge;
    if (!bridge?.readPets || !bridge.controlPet || !bridge.subscribePet) {
      throw new Error('Missing pet bridge');
    }
    doubles.invoke.mockResolvedValue({ kind: 'ok', snapshot });
    expect(await bridge.readPets()).toEqual({ kind: 'ok', snapshot });
    expect(
      await bridge.controlPet({
        kind: PetAction.ADOPT,
        petId: PetId.CAT,
        name: 'Mochi',
        locale: DesktopLocale.ENGLISH,
      }),
    ).toEqual({ kind: 'ok', snapshot });
    expect(doubles.invoke).toHaveBeenLastCalledWith('tro:pet-command', {
      kind: PetAction.ADOPT,
      petId: PetId.CAT,
      name: 'Mochi',
      locale: DesktopLocale.ENGLISH,
    });
    await bridge.controlPet({
      kind: PetAction.ADOPT,
      petId: PetId.CAT,
      name: '',
      locale: DesktopLocale.ENGLISH,
    });
    expect(doubles.invoke).toHaveBeenCalledTimes(2);
    doubles.invoke.mockResolvedValue({
      kind: 'ok',
      snapshot: { ...snapshot, preferences: { ...snapshot.preferences, assetPath: '/private' } },
    });
    expect(await bridge.readPets()).toEqual({ kind: 'failed', reason: 'unavailable' });
    const listener = vi.fn<(snapshot: PetSnapshot) => void>();
    const unsubscribe = bridge.subscribePet(listener);
    doubles.listeners.get('tro:pet-snapshot')?.({}, snapshot);
    doubles.listeners.get('tro:pet-snapshot')?.({}, { ...snapshot, reaction: 'invalid' });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(doubles.listeners.size).toBe(0);
  });

  it('provides the overlay only three capabilities with no auth, agent or generic IPC', async () => {
    expect(Object.keys(petOverlayBridge).sort()).toEqual([
      'interactWithPet',
      'readPet',
      'subscribePet',
    ]);
    doubles.invoke.mockResolvedValue(snapshot);
    expect(await petOverlayBridge.readPet()).toEqual(snapshot);
    petOverlayBridge.interactWithPet({ kind: 'pet' });
    expect(doubles.send).toHaveBeenCalledWith('tro:pet-overlay-command', { kind: 'pet' });
    doubles.invoke.mockResolvedValue({ ...snapshot, isVisible: 'yes' });
    await expect(petOverlayBridge.readPet()).rejects.toThrow();
  });
});
