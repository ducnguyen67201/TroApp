// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudentQrScanner } from '../../../../src/desktop/renderer/accounts/StudentQrScanner.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('QR camera lifetime', () => {
  it('stops a stream that arrives after its scan view was closed', async () => {
    const control = vi.fn<() => Promise<{ kind: 'done' }>>().mockResolvedValue({ kind: 'done' });
    Object.defineProperty(window, 'tro', {
      configurable: true,
      value: { controlStudentAccess: control },
    });
    let finish: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn<typeof navigator.mediaDevices.getUserMedia>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const view = render(
      createElement(MantineProvider, {
        env: 'test',
        children: createElement(LocaleProvider, {
          children: createElement(StudentQrScanner, { onRead: () => {}, onClose: () => {} }),
        }),
      }),
    );
    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledOnce();
    });
    view.unmount();
    const stream = document.createElement('canvas').captureStream();
    /* Happy DOM implements video tracks but omits the standard getTracks method. */
    Object.defineProperty(stream, 'getTracks', { value: () => stream.getVideoTracks() });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error('Missing synthetic media track.');
    }
    const stop = vi.spyOn(track, 'stop');

    await act(async () => {
      finish?.(stream);
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalled();
    expect(control).toHaveBeenCalledWith({ kind: 'camera-stop' });
  });
});
