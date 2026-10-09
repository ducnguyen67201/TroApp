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

it('renders a localized pet and sends only bounded hover and drag commands', async () => {
  const snapshot: PetSnapshot = {
    revision: 1,
    preferences: {
      ...createPetPreferences(),
      locale: 'en',
      enabled: true,
    },
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
  fireEvent(pet, new MouseEvent('pointermove', { bubbles: true, screenX: 72, screenY: 100 }));
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
  expect(bridge.interactWithPet.mock.calls).toEqual([[{ kind: PetOverlayAction.END_DRAG }]]);

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
  expect(bridge.interactWithPet).not.toHaveBeenCalledWith({ kind: PetOverlayAction.SLAP });
  cleanup();
  expect(bridge.interactWithPet).toHaveBeenLastCalledWith({ kind: PetOverlayAction.END_DRAG });
});

it('suppresses a mascot click after dragging or cancellation, but permits the next click', async () => {
  const bridge = {
    readPet: vi.fn<PetOverlayBridge['readPet']>().mockResolvedValue({
      revision: 1,
      preferences: { ...createPetPreferences(), enabled: true, locale: 'en' },
      reaction: PetReaction.IDLE,
      isVisible: true,
      hasPresentationError: false,
      encouragement: false,
    }),
    subscribePet: vi.fn<PetOverlayBridge['subscribePet']>().mockReturnValue(() => {}),
    interactWithPet: vi.fn<PetOverlayBridge['interactWithPet']>(),
  } satisfies PetOverlayBridge;
  window.troPet = bridge;
  render(createElement(PetOverlay));
  const pet = await screen.findByRole('button', { name: 'Pet Mochi' });
  const click = vi.fn<(event: Event) => void>();
  pet.addEventListener('click', click);
  Object.defineProperties(pet, {
    setPointerCapture: { value: vi.fn<(pointerId: number) => void>() },
    hasPointerCapture: { value: () => false },
  });
  const pointer = (type: string, screenX: number): void => {
    fireEvent(pet, new MouseEvent(type, { bubbles: true, button: 0, screenX, screenY: 100 }));
  };
  pointer('pointerdown', 72);
  pointer('pointermove', 90);
  pointer('pointerup', 90);
  fireEvent.click(pet, { detail: 1 });
  expect(click).not.toHaveBeenCalled();
  pointer('pointerdown', 72);
  pointer('pointercancel', 72);
  fireEvent.click(pet, { detail: 1 });
  expect(click).not.toHaveBeenCalled();
  pointer('pointerdown', 72);
  pointer('pointerup', 72);
  // A capture-loss notification after release must not swallow the ordinary click.
  pointer('lostpointercapture', 72);
  // Prevent the package animation in this DOM test; Electron verifies its real click below.
  pet.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  fireEvent.click(pet);
  expect(click).toHaveBeenCalledOnce();
  expect(bridge.interactWithPet).not.toHaveBeenCalledWith({ kind: PetOverlayAction.PET });
  fireEvent.contextMenu(pet);
  expect(bridge.interactWithPet).not.toHaveBeenCalledWith({ kind: PetOverlayAction.SLAP });
});
