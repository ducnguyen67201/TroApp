// @vitest-environment happy-dom
import { AudioFormat } from '#contracts/Transcription.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceAudioCapture } from './VoiceAudioCapture.js';

import { TestAudioTrack, TestAudioStream, stubCapture } from './AudioCaptureFixture.js';

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('selected microphone capture', () => {
  it('requests only the selected microphone and cancels on hardware disconnection', async () => {
    const track = new TestAudioTrack();
    const stream = new TestAudioStream(track);
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
    stubCapture(getUserMedia);
    const fail = vi.fn<() => void>();
    const capture = new VoiceAudioCapture(() => {}, fail);
    await capture.startCapture('usb');
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: {
        deviceId: { exact: 'usb' },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    track.onended?.call(track, new Event('ended'));
    expect(fail).toHaveBeenCalledOnce();
    capture.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it('stops a microphone that finishes opening after cancellation', async () => {
    const stream = new TestAudioStream(new TestAudioTrack());
    let finish: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    stubCapture(getUserMedia);
    const capture = new VoiceAudioCapture(
      () => {},
      () => {},
    );
    const opening = capture.startCapture('usb');
    capture.dispose();
    finish?.(stream);
    await opening;
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('does not retry a missing device with the system default', async () => {
    const getUserMedia = vi
      .fn<MediaDevices['getUserMedia']>()
      .mockRejectedValue(new DOMException('Missing device', 'OverconstrainedError'));
    stubCapture(getUserMedia);
    const capture = new VoiceAudioCapture(
      () => {},
      () => {},
    );
    await expect(capture.startCapture('missing')).rejects.toThrow('Missing device');
    expect(getUserMedia).toHaveBeenCalledOnce();
    capture.dispose();
  });
});

it.each(['sample rate', 'worklet loading', 'context resume'])(
  'releases its resources when %s fails without depending on caller cleanup',
  async (failure) => {
    const stream = new TestAudioStream(new TestAudioTrack());
    const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
    const resources = stubCapture(getUserMedia, {
      sampleRate: failure === 'sample rate' ? 48000 : AudioFormat.SAMPLE_RATE,
      loadWorklet: () =>
        failure === 'worklet loading'
          ? Promise.reject(new Error('Worklet unavailable'))
          : Promise.resolve(),
      resumeContext: () =>
        failure === 'context resume'
          ? Promise.reject(new Error('Context unavailable'))
          : Promise.resolve(),
    });
    const capture = new VoiceAudioCapture(
      () => {},
      () => {},
    );
    await expect(capture.startCapture('usb')).rejects.toThrow();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(stream.track.onended).toBeNull();
    expect(resources.closeContext).toHaveBeenCalledOnce();
    capture.dispose();
    expect(stream.track.stop).toHaveBeenCalledOnce();
  },
);

it('stops physical capture before tail flush and closes resources after acknowledgment', async () => {
  const stream = new TestAudioStream(new TestAudioTrack());
  const resources = stubCapture(vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream));
  const capture = new VoiceAudioCapture(
    () => {},
    () => {},
  );
  await capture.startCapture('usb');
  const flushing = capture.flushCapture();
  expect(stream.track.stop).toHaveBeenCalledOnce();
  expect(resources.postMessage).toHaveBeenCalledWith('flush');
  expect(resources.closeContext).not.toHaveBeenCalled();
  resources.port.onmessage?.(new MessageEvent('message', { data: 'flushed' }));
  await flushing;
  expect(resources.closeContext).toHaveBeenCalledOnce();
  expect(resources.disconnectWorklet).toHaveBeenCalledOnce();
  expect(resources.closePort).toHaveBeenCalledOnce();
  expect(resources.port.onmessage).toBeNull();
  expect(stream.track.stop).toHaveBeenCalledOnce();
});

it('cleans up even when the worklet never acknowledges release', async () => {
  vi.useFakeTimers();
  const stream = new TestAudioStream(new TestAudioTrack());
  const resources = stubCapture(vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream));
  const capture = new VoiceAudioCapture(
    () => {},
    () => {},
  );
  await capture.startCapture('usb');
  const rejection = expect(capture.flushCapture()).rejects.toThrow('Audio flush timed out');
  await vi.advanceTimersByTimeAsync(1500);
  await rejection;
  expect(stream.track.stop).toHaveBeenCalledOnce();
  expect(resources.closeContext).toHaveBeenCalledOnce();
  expect(resources.closePort).toHaveBeenCalledOnce();
});

it('never opens another stream for a disposed or already-started capture', async () => {
  const stream = new TestAudioStream(new TestAudioTrack());
  const getUserMedia = vi.fn<MediaDevices['getUserMedia']>().mockResolvedValue(stream);
  stubCapture(getUserMedia);
  const capture = new VoiceAudioCapture(
    () => {},
    () => {},
  );
  await capture.startCapture('usb');
  await expect(capture.startCapture('other')).rejects.toThrow('already started');
  capture.dispose();
  await capture.startCapture('other');
  expect(getUserMedia).toHaveBeenCalledOnce();
});
