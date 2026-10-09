// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PetId, PetReaction } from '#contracts/Pet.js';
import type {
  PetRenderOptions,
  PetRenderer,
} from '../../../../src/desktop/renderer/pets/PetRenderer.js';
import { PetMascot } from '../../../../src/desktop/renderer/pets/PetMascot.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('uses a localized accessible name and does not nest buttons', () => {
  render(
    createElement(PetMascot, { petId: PetId.FOX, label: 'Vuốt ve Maple', reducedMotion: false }),
  );
  const button = screen.getByRole('button', { name: 'Vuốt ve Maple' });
  expect(button.querySelector('button')).toBeNull();
  expect(screen.queryByRole('button', { name: /Boop/ })).toBeNull();
});

it('uses a still center sprite for the app preference and restores the component when disabled', () => {
  const view = render(
    createElement(PetMascot, { petId: PetId.CAT, label: 'Pet Mochi', reducedMotion: true }),
  );
  expect(screen.getByRole('img', { name: 'Pet Mochi' }).className).toBe('pet-mascot-still');
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(
    createElement(PetMascot, { petId: PetId.CAT, label: 'Pet Mochi', reducedMotion: false }),
  );
  expect(screen.getByRole('button', { name: 'Pet Mochi' })).toBeTruthy();
});

it('follows live system reduced-motion changes and removes its listener', () => {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  vi.spyOn(window, 'matchMedia').mockReturnValue(preference);
  const removeListener = vi.spyOn(preference, 'removeEventListener');
  render(createElement(PetMascot, { petId: PetId.FOX, label: 'Pet Maple', reducedMotion: false }));
  Object.defineProperty(preference, 'matches', { configurable: true, value: true });
  act(() => {
    preference.dispatchEvent(new Event('change'));
  });
  expect(screen.getByRole('img', { name: 'Pet Maple' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  cleanup();
  expect(removeListener).toHaveBeenCalledWith('change', expect.any(Function));
});

it('retains slime click and context-menu callbacks', () => {
  const onPet = vi.fn<() => void>();
  const onSlap = vi.fn<() => void>();
  render(
    createElement(PetMascot, {
      petId: PetId.SLIME,
      label: 'Pet Jelly',
      reducedMotion: false,
      onPet,
      onSlap,
    }),
  );
  const button = screen.getByRole('button', { name: 'Pet Jelly' });
  fireEvent.click(button);
  fireEvent.contextMenu(button);
  expect(onPet).toHaveBeenCalledOnce();
  expect(onSlap).toHaveBeenCalledOnce();
});

it('switches renderer classes without losing presentation inputs or motion preferences', () => {
  class StillPetRenderer implements PetRenderer {
    renderPet(options: PetRenderOptions): ReactElement {
      return createElement('img', {
        alt: options.label,
        'data-pet-id': options.petId,
        'data-reaction': options.reaction,
        'data-motion': options.reducedMotion ? 'reduced' : 'system',
      });
    }

    supportsControlledReactions(): boolean {
      return false;
    }
  }

  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  vi.spyOn(window, 'matchMedia').mockReturnValue(preference);
  const view = render(
    createElement(PetMascot, {
      petId: PetId.FOX,
      label: 'Pet Maple',
      reaction: PetReaction.HAPPY,
      reducedMotion: false,
    }),
  );
  expect(screen.getByRole('button', { name: 'Pet Maple' })).toBeTruthy();
  view.rerender(
    createElement(PetMascot, {
      renderer: new StillPetRenderer(),
      petId: PetId.FOX,
      label: 'Pet Maple',
      reaction: PetReaction.HAPPY,
      reducedMotion: false,
    }),
  );
  const image = screen.getByRole('img', { name: 'Pet Maple' });
  expect(image.dataset.petId).toBe(PetId.FOX);
  expect(image.dataset.reaction).toBe(PetReaction.HAPPY);
  expect(image.dataset.motion).toBe('system');
  expect(screen.queryByRole('button')).toBeNull();
  Object.defineProperty(preference, 'matches', { configurable: true, value: true });
  act(() => {
    preference.dispatchEvent(new Event('change'));
  });
  expect(image.dataset.motion).toBe('reduced');
});
