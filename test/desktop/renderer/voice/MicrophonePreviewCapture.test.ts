// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrophonePreviewCapture } from '../../../../src/desktop/renderer/voice/MicrophonePreviewCapture.js';
import {
  TestAudioTrack,
  TestAudioStream,
  stubCapture,
} from '../../../../src/desktop/renderer/voice/AudioCaptureFixture.js';

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('continuous local microphone preview', () => {
  it('follows the OS input route and continues until disposed without a recording timeout', async () => {
    vi.useFakeTimers();
    const stream = new TestAudioStream(new TestAudioTrack());
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
    const resources = stubCapture(getUserMedia);
    const receive = vi.fn<(levelDb: number) => void>();
    const fail = vi.fn<() => void>();
    const capture = new MicrophonePreviewCapture(receive, fail);
    await capture.startPreview('default');
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      video: false,
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fail).not.toHaveBeenCalled();
    expect(stream.track.stop).not.toHaveBeenCalled();
    const receiveMessage = resources.port.onmessage;
    receiveMessage?.(new MessageEvent('message', { data: { kind: 'level', levelDb: -120 } }));
    receiveMessage?.(new MessageEvent('message', { data: { kind: 'level', levelDb: -30 } }));
    expect(receive.mock.calls).toEqual([[-120], [-30]]);

    capture.dispose();
    receiveMessage?.(new MessageEvent('message', { data: { kind: 'level', levelDb: 0 } }));
    expect(receive).toHaveBeenCalledTimes(2);
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.disconnectWorklet).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
    expect(resources.closePort).toHaveBeenCalledOnce();
    expect(resources.port.onmessage).toBeNull();
    capture.dispose();
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('uses exact device constraints and refuses communications aliases or a second start', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
    stubCapture(getUserMedia);
    const capture = new MicrophonePreviewCapture(
      () => {},
      () => {},
    );
    await expect(capture.startPreview('communications')).rejects.toThrow();
    expect(getUserMedia).not.toHaveBeenCalled();
    await capture.startPreview('usb');
    expect(getUserMedia.mock.calls[0]?.[0]?.audio).toMatchObject({ deviceId: { exact: 'usb' } });
    await expect(capture.startPreview('usb')).rejects.toThrow();
    capture.dispose();
    await capture.startPreview('default');
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it.each([
    { reason: 'raw samples', message: new Float32Array(128) },
    { reason: 'non-finite level', message: { kind: 'level', levelDb: NaN } },
    { reason: 'above-range level', message: { kind: 'level', levelDb: 1 } },
    { reason: 'below-range level', message: { kind: 'level', levelDb: -121 } },
    {
      reason: 'samples attached to a level',
      message: { kind: 'level', levelDb: -30, samples: new Float32Array(128) },
    },
    {
      reason: 'comparison progress',
      message: { kind: 'progress', phase: 'quiet', secondsRemaining: 2 },
    },
    {
      reason: 'comparison results',
      message: {
        kind: 'result',
        measurement: { version: 1, noiseDb: -50, speechDb: -20, clippedFraction: 0 },
      },
    },
  ])('rejects $reason and closes audio resources', async ({ message }) => {
    const stream = new TestAudioStream(new TestAudioTrack());
    const resources = stubCapture(vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream));
    const receive = vi.fn<(levelDb: number) => void>();
    const fail = vi.fn<() => void>();
    const capture = new MicrophonePreviewCapture(receive, fail);
    await capture.startPreview('usb');
    resources.port.onmessage?.(new MessageEvent('message', { data: message }));
    expect(receive).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
    expect(resources.closePort).toHaveBeenCalledOnce();
  });

  it.each(['disconnection', 'worklet error'])('cleans up after %s', async (failure) => {
    const stream = new TestAudioStream(new TestAudioTrack());
    const resources = stubCapture(vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream));
    const fail = vi.fn<() => void>();
    const capture = new MicrophonePreviewCapture(() => {}, fail);
    await capture.startPreview('usb');
    if (failure === 'disconnection') {
      stream.track.onended?.call(stream.track, new Event('ended'));
    } else {
      resources.triggerProcessorError();
    }
    expect(fail).toHaveBeenCalledOnce();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
  });

  it('expires pending startup and stops a stream returned after the deadline', async () => {
    vi.useFakeTimers();
    const stream = new TestAudioStream(new TestAudioTrack());
    let allowMicrophone: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          allowMicrophone = resolve;
        }),
    );
    stubCapture(getUserMedia);
    const fail = vi.fn<() => void>();
    const capture = new MicrophonePreviewCapture(() => {}, fail);
    const startup = capture.startPreview('default');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fail).toHaveBeenCalledOnce();
    allowMicrophone?.(stream);
    await startup;
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('fences worklet loading that completes after disposal', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    let finishLoading: (() => void) | undefined;
    const loadWorklet = vi.fn<() => Promise<void>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }),
    );
    const resources = stubCapture(vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream), {
      loadWorklet,
    });
    const capture = new MicrophonePreviewCapture(
      () => {},
      () => {},
    );
    const startup = capture.startPreview('usb');
    await Promise.resolve();
    expect(loadWorklet).toHaveBeenCalledOnce();
    capture.dispose();
    finishLoading?.();
    await startup;
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
    expect(resources.port.onmessage).toBeNull();
  });

  it('fences context startup that completes after disposal', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    let finishResuming: (() => void) | undefined;
    const resumeContext = vi.fn<() => Promise<void>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishResuming = resolve;
        }),
    );
    const resources = stubCapture(vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream), {
      resumeContext,
    });
    const receive = vi.fn<(levelDb: number) => void>();
    const capture = new MicrophonePreviewCapture(receive, () => {});
    const startup = capture.startPreview('usb');
    await Promise.resolve();
    await Promise.resolve();
    expect(resumeContext).toHaveBeenCalledOnce();
    const receiveMessage = resources.port.onmessage;
    capture.dispose();
    finishResuming?.();
    await startup;
    receiveMessage?.(new MessageEvent('message', { data: { kind: 'level', levelDb: -20 } }));
    expect(receive).not.toHaveBeenCalled();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
    expect(resources.closePort).toHaveBeenCalledOnce();
  });

  it('cleans up a rejected worklet startup', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    const resources = stubCapture(vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream), {
      loadWorklet: () => Promise.reject(new Error('Missing preview worklet')),
    });
    const capture = new MicrophonePreviewCapture(
      () => {},
      () => {},
    );
    await expect(capture.startPreview('usb')).rejects.toThrow('Missing preview worklet');
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(resources.closeContext).toHaveBeenCalledOnce();
  });
});
