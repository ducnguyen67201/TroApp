// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrophoneTestCapture } from '../../../../src/desktop/renderer/voice/MicrophoneTestCapture.js';
import {
  TestAudioTrack,
  TestAudioStream,
  stubCapture,
} from '../../../../src/desktop/renderer/voice/AudioCaptureFixture.js';
import type { MicrophoneMeasurementEvent } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurements.js';

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('local-only test audio resources', () => {
  it('uses exact constraints, accepts only scalar measurements and releases resources before completion', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
    const resources = stubCapture(getUserMedia);
    const receive = vi.fn<(event: MicrophoneMeasurementEvent) => void>();
    const capture = new MicrophoneTestCapture(receive, () => {});
    await capture.startTest('usb');
    expect(getUserMedia.mock.calls[0]?.[0]?.audio).toMatchObject({ deviceId: { exact: 'usb' } });
    const measurement = { version: 1, noiseDb: -50, speechDb: -20, clippedFraction: 0 };
    resources.port.onmessage?.(
      new MessageEvent('message', { data: { kind: 'result', measurement } }),
    );
    expect(receive).toHaveBeenCalledWith({ kind: 'result', measurement });
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
    expect(resources.closePort).toHaveBeenCalledOnce();
    expect(resources.port.onmessage).toBeNull();
    capture.dispose();
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('stops late streams after canceled permission/setup', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    let grant: ((stream: MediaStream) => void) | undefined;
    stubCapture(
      vi.fn<MediaDevices['getUserMedia']>().mockImplementation(
        () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      ),
    );
    const capture = new MicrophoneTestCapture(
      () => {},
      () => {},
    );
    const pending = capture.startTest('usb');
    capture.dispose();
    grant?.(stream);
    await pending;
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it.each(['disconnected', 'invalid-message', 'timeout', 'worklet-error'])(
    'cleans up when %s happens',
    async (failure) => {
      vi.useFakeTimers();
      const stream = new TestAudioStream(new TestAudioTrack());
      const resources = stubCapture(
        vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream),
      );
      const fail = vi.fn<() => void>();
      const receive = vi.fn<(event: MicrophoneMeasurementEvent) => void>();
      const capture = new MicrophoneTestCapture(receive, fail);
      await capture.startTest('usb');
      if (failure === 'disconnected') {
        stream.track.onended?.call(stream.track, new Event('ended'));
      } else if (failure === 'invalid-message') {
        resources.port.onmessage?.(new MessageEvent('message', { data: new Uint8Array(960) }));
      } else if (failure === 'worklet-error') {
        resources.triggerProcessorError();
      } else {
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(fail).toHaveBeenCalledOnce();
      expect(receive).not.toHaveBeenCalled();
      expect(stream.track.stop).toHaveBeenCalledOnce();
      expect(resources.closeContext).toHaveBeenCalledOnce();
      capture.dispose();
    },
  );

  it('cleans up failed worklet setup and refuses default aliases or a second start', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
    const resources = stubCapture(getUserMedia, {
      loadWorklet: () => Promise.reject(new Error('Missing module')),
    });
    const capture = new MicrophoneTestCapture(
      () => {},
      () => {},
    );
    await expect(capture.startTest('default')).rejects.toThrow();
    await expect(capture.startTest('usb')).rejects.toThrow('Missing module');
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
    await capture.startTest('usb');
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});
