// @vitest-environment happy-dom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createPetPreferences,
  PetReaction,
  PetOverlayAction,
  type PetOverlayBridge,
  type PetSnapshot,
} from '#contracts/Pet.js';
import { PetOverlay } from '../../../../src/desktop/renderer/pets/PetOverlay.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('renders a localized pet and sends a bounded slap command without workspace capabilities', async () => {
  const snapshot: PetSnapshot = {
    revision: 1,
    preferences: { ...createPetPreferences(), locale: 'en', enabled: true },
    reaction: PetReaction.IDLE,
    isVisible: true,
    hasPresentationError: false,
    encouragement: true,
  };
  const bridge = {
    readPet: vi.fn<PetOverlayBridge['readPet']>().mockResolvedValue(snapshot),
    subscribePet: vi.fn<PetOverlayBridge['subscribePet']>().mockReturnValue(() => {}),
    interactWithPet: vi.fn<PetOverlayBridge['interactWithPet']>(),
  } satisfies PetOverlayBridge;
  window.troPet = bridge;
  render(createElement(PetOverlay));
  const pet = await screen.findByRole('button', { name: 'Pet Mochi' });
  expect(screen.getByRole('status').textContent).toBe('One small step at a time.');
  bridge.interactWithPet.mockClear();
  fireEvent.mouseMove(window);
  expect(bridge.interactWithPet).toHaveBeenLastCalledWith({ kind: PetOverlayAction.HOVER });
  fireEvent.mouseLeave(window);
  expect(bridge.interactWithPet).toHaveBeenCalledTimes(2);

  Object.defineProperties(pet, {
    setPointerCapture: { value: vi.fn<(pointerId: number) => void>() },
    hasPointerCapture: { value: () => false },
  });
  bridge.interactWithPet.mockClear();
  fireEvent(
    pet,
    new MouseEvent('pointerdown', { bubbles: true, button: 0, screenX: 72, screenY: 100 }),
  );
  expect(bridge.interactWithPet).not.toHaveBeenCalled();
  fireEvent(
    pet,
    new MouseEvent('pointerup', { bubbles: true, button: 0, screenX: 72, screenY: 100 }),
  );
  expect(bridge.interactWithPet.mock.calls).toEqual([
    [{ kind: PetOverlayAction.END_DRAG }],
    [{ kind: PetOverlayAction.PET }],
  ]);

  bridge.interactWithPet.mockClear();
  fireEvent(
    pet,
    new MouseEvent('pointerdown', { bubbles: true, button: 0, screenX: 72, screenY: 100 }),
  );
  fireEvent(pet, new MouseEvent('pointermove', { bubbles: true, screenX: 80, screenY: 100 }));
  fireEvent(pet, new MouseEvent('pointermove', { bubbles: true, screenX: 90, screenY: 100 }));
  fireEvent(
    pet,
    new MouseEvent('pointerup', { bubbles: true, button: 0, screenX: 90, screenY: 100 }),
  );
  expect(bridge.interactWithPet.mock.calls).toEqual([
    [{ kind: PetOverlayAction.START_DRAG }],
    [{ kind: PetOverlayAction.END_DRAG }],
  ]);

  fireEvent.contextMenu(pet);
  expect(bridge.interactWithPet).toHaveBeenCalledWith({ kind: PetOverlayAction.SLAP });
  cleanup();
  expect(bridge.interactWithPet).toHaveBeenLastCalledWith({ kind: PetOverlayAction.END_DRAG });
});
