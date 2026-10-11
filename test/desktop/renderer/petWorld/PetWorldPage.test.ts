// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  PetRecognitionCategory,
  PetWorldCommandKind,
  type PetWorldCommand,
} from '#contracts/PetWorld.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../../src/desktop/renderer/localization/Locale.js';
import { PetWorldPage } from '../../../../src/desktop/renderer/petWorld/PetWorldPage.js';
import {
  emptyGarden,
  emptyRecognition,
  petWorldClassId,
  teacherClassroom,
} from './PetWorldFixtures.js';

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it('retries the persisted original award without creating a new request ID', async () => {
  const original: PetWorldCommand = {
    kind: PetWorldCommandKind.GRANT_POINTS,
    requestId: '33333333-3333-4333-8333-333333333333',
    classId: petWorldClassId,
    studentIds: ['student'],
    pointsPerStudent: '5',
    category: PetRecognitionCategory.CURIOSITY,
    note: 'Asked why.',
  };
  let unresolved = true;
  const bridge = {
    executePetWorld: vi
      .fn<NonNullable<DesktopBridge['executePetWorld']>>()
      .mockImplementation((command) => {
        if (command.kind === PetWorldCommandKind.OWN_WORLD) {
          return Promise.resolve({ kind: 'failed', code: 'forbidden' });
        }
        if (command.kind === PetWorldCommandKind.CLASS_RECOGNITION) {
          return Promise.resolve(emptyRecognition);
        }
        if (command.kind === PetWorldCommandKind.CLASS_NEIGHBORHOOD) {
          return Promise.resolve({
            kind: 'neighborhood',
            classId: petWorldClassId,
            homes: [],
            garden: emptyGarden,
          });
        }
        if (command.kind === PetWorldCommandKind.GRANT_POINTS) {
          unresolved = false;
          return Promise.resolve({
            kind: 'granted',
            requestId: command.requestId,
            batchId: '44444444-4444-4444-8444-444444444444',
            createdAt: '2026-10-11T00:00:00.000Z',
            recognitions: [
              { id: '55555555-5555-4555-8555-555555555555', studentId: 'student', points: '5' },
            ],
          });
        }
        return Promise.resolve({ kind: 'catalog', catalog: { revision: 'one', items: [] } });
      }),
    controlClassroom: vi
      .fn<NonNullable<DesktopBridge['controlClassroom']>>()
      .mockResolvedValue({ kind: 'home', home: teacherClassroom }),
    readPetWorldPending: vi
      .fn<NonNullable<DesktopBridge['readPetWorldPending']>>()
      .mockImplementation(() => Promise.resolve(unresolved ? [original] : [])),
  } satisfies Pick<DesktopBridge, 'executePetWorld' | 'controlClassroom' | 'readPetWorldPending'>;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  render(
    createElement(MantineProvider, {
      env: 'test',
      children: createElement(LocaleProvider, {
        children: createElement(PetWorldPage, {
          userId: 'teacher',
          userName: 'Ms Linh',
          initialClassId: petWorldClassId,
          onChooseClass: vi.fn(),
          onRoleChange: vi.fn(),
        }),
      }),
    }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original action' }));
  await waitFor(() => {
    expect(bridge.executePetWorld).toHaveBeenCalledWith(original);
  });
  const awards = bridge.executePetWorld.mock.calls.filter(
    ([command]) => command.kind === PetWorldCommandKind.GRANT_POINTS,
  );
  expect(awards).toEqual([[original]]);
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Retry original action' })).toBeNull();
  });
});
