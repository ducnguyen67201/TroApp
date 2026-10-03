import { afterEach, expect, it, vi } from 'vitest';
import { VoiceoverPlayback } from '../../../../src/desktop/renderer/voiceover/VoiceoverPlayback.js';

class AudioBufferDouble {
  readonly duration: number;
  readonly samples: Float32Array;
  constructor(sampleCount: number, sampleRate: number) {
    this.duration = sampleCount / sampleRate;
    this.samples = new Float32Array(sampleCount);
  }
  getChannelData(): Float32Array {
    return this.samples;
  }
}

class AudioSourceDouble {
  buffer: AudioBufferDouble | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn<() => void>();
  disconnect = vi.fn<() => void>();
  start = vi.fn<(time: number) => void>();
  stop = vi.fn<() => void>();
}

const sources: AudioSourceDouble[] = [];
const buffers: AudioBufferDouble[] = [];

class AudioContextDouble {
  currentTime = 0;
  state = 'running';
  destination = {};
  resume = vi.fn<() => Promise<void>>().mockResolvedValue();
  close = vi.fn<() => Promise<void>>().mockResolvedValue();
  createBuffer(_channels: number, count: number, rate: number): AudioBufferDouble {
    const buffer = new AudioBufferDouble(count, rate);
    buffers.push(buffer);
    return buffer;
  }
  createBufferSource(): AudioSourceDouble {
    const source = new AudioSourceDouble();
    sources.push(source);
    return source;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  sources.length = 0;
  buffers.length = 0;
});
const utteranceId = '11111111-1111-4111-8111-111111111111';

it('decodes little-endian PCM and waits for audio drain before completion', async () => {
  vi.stubGlobal('AudioContext', AudioContextDouble);
  const playback = new VoiceoverPlayback();
  expect(await playback.receiveCommand({ kind: 'start', utteranceId, sequence: 0 })).toBe(true);
  expect(
    await playback.receiveCommand({
      kind: 'chunk',
      utteranceId,
      sequence: 1,
      pcm: new Uint8Array([0, 128, 255, 127]),
    }),
  ).toBe(true);
  expect(buffers[0]?.samples[0]).toBe(-1);
  expect(buffers[0]?.duration).toBe(2 / 24000);
  let drained = false;
  const ending = playback
    .receiveCommand({ kind: 'end', utteranceId, sequence: 2 })
    .then((accepted) => {
      drained = accepted;
    });
  await Promise.resolve();
  expect(drained).toBe(false);
  sources[0]?.onended?.();
  await ending;
  expect(drained).toBe(true);
  await playback.stop();
});

it('stops queued audio and refuses stale chunks before another microphone can open', async () => {
  vi.stubGlobal('AudioContext', AudioContextDouble);
  const playback = new VoiceoverPlayback();
  const starting = playback.receiveCommand({ kind: 'start', utteranceId, sequence: 0 });
  await playback.receiveCommand({ kind: 'stop', utteranceId, sequence: -1 });
  expect(await starting).toBe(false);
  await playback.receiveCommand({ kind: 'start', utteranceId, sequence: 0 });
  await playback.receiveCommand({
    kind: 'chunk',
    utteranceId,
    sequence: 1,
    pcm: new Uint8Array([0, 0]),
  });
  expect(await playback.receiveCommand({ kind: 'stop', utteranceId, sequence: -1 })).toBe(true);
  expect(sources[0]?.stop).toHaveBeenCalledOnce();
  expect(
    await playback.receiveCommand({
      kind: 'chunk',
      utteranceId,
      sequence: 2,
      pcm: new Uint8Array([0, 0]),
    }),
  ).toBe(false);
});
