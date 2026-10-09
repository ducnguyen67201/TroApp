// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  createPetPreferences,
  PetAction,
  PetId,
  PetReaction,
  type PetSnapshot,
} from '#contracts/Pet.js';
import { PetGallery } from '../../../../src/desktop/renderer/pets/PetGallery.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  localeStorageKey,
  DesktopLocale,
} from '../../../../src/desktop/renderer/localization/Locale.js';

const initialSnapshot: PetSnapshot = {
  revision: 1,
  preferences: createPetPreferences(),
  reaction: PetReaction.IDLE,
  isVisible: false,
  hasPresentationError: false,
  encouragement: false,
};

function createBridge() {
  return {
    readPets: vi
      .fn<NonNullable<DesktopBridge['readPets']>>()
      .mockResolvedValue({ kind: 'ok', snapshot: initialSnapshot }),
    controlPet: vi
      .fn<NonNullable<DesktopBridge['controlPet']>>()
      .mockResolvedValue({ kind: 'ok', snapshot: { ...initialSnapshot, revision: 2 } }),
    subscribePet: vi.fn<NonNullable<DesktopBridge['subscribePet']>>().mockReturnValue(() => {}),
  } satisfies Pick<DesktopBridge, 'readPets' | 'controlPet' | 'subscribePet'>;
}

function renderGallery(accountId = 'student') {
  return render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(PetGallery, { accountId }),
      }),
    }),
  );
}

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

it('previews all bundled pets and adopts a named pet through the narrow bridge', async () => {
  const bridge = createBridge();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderGallery();
  const fox = await screen.findByRole('region', { name: 'Fox' });
  expect(screen.getAllByRole('region')).toHaveLength(3);
  fireEvent.change(within(fox).getByLabelText('Pet name'), { target: { value: 'Fennel' } });
  fireEvent.click(within(fox).getByRole('button', { name: 'Adopt pet' }));
  await waitFor(() => {
    expect(bridge.controlPet).toHaveBeenCalledWith({
      kind: PetAction.ADOPT,
      petId: PetId.FOX,
      name: 'Fennel',
      locale: DesktopLocale.ENGLISH,
    });
  });
  expect(screen.getByText(/Custom pet generation is planned/)).toBeTruthy();
});

it('does not expose a previous account after a pending read completes', async () => {
  const bridge = createBridge();
  let finishRead:
    ((reply: Awaited<ReturnType<NonNullable<DesktopBridge['readPets']>>>) => void) | undefined;
  bridge.readPets.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const rendered = renderGallery('first');
  rendered.unmount();
  renderGallery('second');
  await screen.findByRole('region', { name: 'Fox' });
  finishRead?.({
    kind: 'ok',
    snapshot: {
      ...initialSnapshot,
      revision: 100,
      preferences: {
        ...initialSnapshot.preferences,
        names: { ...initialSnapshot.preferences.names, fox: 'Private name' },
      },
    },
  });
  await waitFor(() => {
    expect(screen.queryByDisplayValue('Private name')).toBeNull();
  });
});

it('lets hidden pet previews react locally without adopting or showing them', async () => {
  const bridge = createBridge();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderGallery();
  const slime = await screen.findByRole('region', { name: 'Slime' });
  const preview = within(slime).getByRole('button', { name: 'Pet Jelly' });
  fireEvent.click(preview);
  expect(preview.querySelector('img')?.dataset.reaction).toBe(PetReaction.HAPPY);
  fireEvent.contextMenu(preview);
  expect(preview.querySelector('img')?.dataset.reaction).toBe(PetReaction.STARTLED);
  expect(bridge.controlPet).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(preview.querySelector('img')?.dataset.reaction).toBe(PetReaction.IDLE);
  });
});

it('keeps a failed adoption visible and retryable instead of pretending it was saved', async () => {
  const bridge = createBridge();
  bridge.controlPet.mockResolvedValueOnce({ kind: 'failed', reason: 'save' });
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderGallery();
  const fox = await screen.findByRole('region', { name: 'Fox' });
  fireEvent.click(within(fox).getByRole('button', { name: 'Adopt pet' }));
  await screen.findByRole('alert');
  expect(within(fox).queryByText('Active')).toBeNull();
  fireEvent.click(within(fox).getByRole('button', { name: 'Adopt pet' }));
  await waitFor(() => {
    expect(bridge.controlPet).toHaveBeenCalledTimes(2);
  });
});

it('offers remote reaction controls only for slime', async () => {
  const bridge = createBridge();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderGallery();
  await screen.findByRole('region', { name: 'Fox' });
  expect(screen.queryByRole('button', { name: 'Playful slap' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Pet' })).toBeNull();
  expect(screen.getByText(/Slime also reacts to right-clicks/)).toBeTruthy();
});

it('lets fox reactions stay local without adopting or showing a pet', async () => {
  const bridge = createBridge();
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderGallery();
  const fox = await screen.findByRole('region', { name: 'Fox' });
  const preview = within(fox).getByRole('button', { name: 'Pet Maple' });
  fireEvent.click(preview);
  expect(bridge.controlPet).not.toHaveBeenCalled();
  expect(preview.querySelector('button')).toBeNull();
  fireEvent.contextMenu(preview);
  expect(bridge.controlPet).not.toHaveBeenCalled();
});

it('uses the renderer capability to keep slime remote reaction controls available', async () => {
  const bridge = createBridge();
  bridge.readPets.mockResolvedValue({
    kind: 'ok',
    snapshot: {
      ...initialSnapshot,
      isVisible: true,
      preferences: { ...initialSnapshot.preferences, activePetId: PetId.SLIME, enabled: true },
    },
  });
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  renderGallery();
  const slap = await screen.findByRole('button', { name: 'Playful slap' });
  fireEvent.click(slap);
  await waitFor(() => {
    expect(bridge.controlPet).toHaveBeenCalledWith({
      kind: PetAction.REACT,
      reaction: PetReaction.STARTLED,
    });
  });
});
