// @vitest-environment happy-dom
import { createElement } from 'react';
import { randomUUID } from 'node:crypto';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PracticeCaptureCommand, PracticeCaptureReply } from '#contracts/PracticeCapture.js';
import { PracticeCaptureControls } from '../../../../src/desktop/renderer/classroom/PracticeCaptureControls.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('opens a local preview without starting a network check', async () => {
  const onCaptured = vi.fn();
  const captureId = randomUUID();
  const controlPracticeCapture = vi
    .fn<(command: PracticeCaptureCommand) => Promise<PracticeCaptureReply>>()
    .mockResolvedValue({
      kind: 'captured',
      evidence: {
        id: randomUUID(),
        kind: 'image',
        name: 'Captured work',
        mediaType: 'image/jpeg',
        base64: '/9j/AQ==',
        capture: {
          id: captureId,
          capturedAt: new Date().toISOString(),
          width: 800,
          height: 600,
          digest: 'a'.repeat(64),
        },
      },
    });
  const controlPractice = vi.fn();
  vi.stubGlobal('tro', { controlPracticeCapture, controlPractice });
  render(
    createElement(
      MantineProvider,
      null,
      createElement(PracticeCaptureControls, {
        enabled: true,
        busy: false,
        onCaptured,
        t: (english) => english,
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Check current window' }));
  await waitFor(() => {
    expect(onCaptured).toHaveBeenCalledTimes(1);
  });
  expect(controlPracticeCapture).toHaveBeenCalledWith({ kind: 'capture' });
  expect(controlPractice).not.toHaveBeenCalled();
});

it('reports a failed window listing and allows retry', async () => {
  const controlPracticeCapture = vi
    .fn<(command: PracticeCaptureCommand) => Promise<PracticeCaptureReply>>()
    .mockRejectedValue(new Error('Denied'));
  vi.stubGlobal('tro', { controlPracticeCapture });
  render(
    createElement(
      MantineProvider,
      null,
      createElement(PracticeCaptureControls, {
        enabled: true,
        busy: false,
        onCaptured: () => {},
        t: (english) => english,
      }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose work window' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Choose work window' }).hasAttribute('disabled')).toBe(
    false,
  );
});
