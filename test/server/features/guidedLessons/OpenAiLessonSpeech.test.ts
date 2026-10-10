import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  OpenAiLessonSpeech,
  readWaveMetadata,
} from '../../../../src/server/features/guidedLessons/infrastructure/OpenAiLessonSpeech.js';
import { LessonProviderNotDispatchedError } from '../../../../src/server/features/guidedLessons/application/LessonPorts.js';

function writeTag(bytes: Uint8Array, offset: number, tag: string): void {
  bytes.set(
    Array.from(tag, (character) => character.charCodeAt(0)),
    offset,
  );
}

function createWave(
  options: {
    durationMs?: number;
    sampleRate?: number;
    channels?: number;
    bits?: number;
    streaming?: boolean;
    extraChunk?: boolean;
  } = {},
): Uint8Array<ArrayBuffer> {
  const sampleRate = options.sampleRate ?? 24000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataLength = Math.ceil((byteRate * (options.durationMs ?? 1000)) / 1000);
  const extraLength = options.extraChunk ? 12 : 0;
  const bytes = new Uint8Array(44 + extraLength + dataLength);
  const view = new DataView(bytes.buffer);
  writeTag(bytes, 0, 'RIFF');
  view.setUint32(4, options.streaming ? 0xffffffff : bytes.length - 8, true);
  writeTag(bytes, 8, 'WAVE');
  writeTag(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  if (options.extraChunk) {
    writeTag(bytes, 36, 'JUNK');
    view.setUint32(40, 3, true);
    bytes.set([1, 2, 3, 0], 44);
  }
  const dataOffset = 36 + extraLength;
  writeTag(bytes, dataOffset, 'data');
  view.setUint32(dataOffset + 4, options.streaming ? 0xffffffff : dataLength, true);
  return bytes;
}

const SpeechRequest = {
  beatId: 'beat-1',
  text: 'Add the current input to the running total.',
  language: 'en' as const,
  contentHash: 'a'.repeat(64),
};

it('measures PCM data through padded metadata chunks rather than a fixed header', () => {
  expect(readWaveMetadata(createWave({ durationMs: 1250, extraChunk: true }))).toEqual({
    durationMs: 1250,
    sampleRate: 24000,
  });
});

it('measures streaming WAV sentinel lengths using actual accepted PCM bytes', () => {
  expect(readWaveMetadata(createWave({ durationMs: 750, streaming: true }))).toEqual({
    durationMs: 750,
    sampleRate: 24000,
  });
});

it('requires a matching PCM block alignment and complete mono/stereo sample frames', () => {
  const wrongAlignment = createWave();
  new DataView(wrongAlignment.buffer).setUint16(32, 4, true);
  expect(() => readWaveMetadata(wrongAlignment)).toThrow('unsupported PCM parameters');

  for (const channels of [1, 2]) {
    const missingChannelSample = createWave({ channels }).slice(0, -(channels === 1 ? 1 : 2));
    const view = new DataView(missingChannelSample.buffer);
    view.setUint32(4, missingChannelSample.length - 8, true);
    view.setUint32(40, missingChannelSample.length - 44, true);
    expect(() => readWaveMetadata(missingChannelSample)).toThrow('whole PCM sample frames');
  }

  const truncatedStreamingSample = createWave({ streaming: true }).slice(0, -1);
  expect(() => readWaveMetadata(truncatedStreamingSample)).toThrow('whole PCM sample frames');
  expect(readWaveMetadata(createWave({ channels: 2, durationMs: 750 }))).toEqual({
    durationMs: 750,
    sampleRate: 24000,
  });
});

it('rejects truncated data, non-PCM format, unsupported sample rate and channel parameters', () => {
  const truncated = createWave().slice(0, -1);
  expect(() => readWaveMetadata(truncated)).toThrow('incomplete WAV chunk');
  const compressed = createWave();
  new DataView(compressed.buffer).setUint16(20, 3, true);
  expect(() => readWaveMetadata(compressed)).toThrow('PCM WAV');
  expect(() => readWaveMetadata(createWave({ sampleRate: 4000 }))).toThrow('valid PCM samples');
  expect(() => readWaveMetadata(createWave({ channels: 3 }))).toThrow('unsupported PCM parameters');
  expect(() => readWaveMetadata(new Uint8Array(44))).toThrow('valid WAV artifact');
});

it('sends the exact approved text once and returns a measured artifact with no SDK retry', async () => {
  const wave = createWave({ durationMs: 1250, extraChunk: true });
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(wave.buffer));
  const signal = new AbortController().signal;
  const speech = new OpenAiLessonSpeech('test-key', undefined, undefined, request);
  const result = await speech.synthesize(SpeechRequest, signal);
  expect(result.durationMs).toBe(1250);
  expect(result.sampleRate).toBe(24000);
  expect(result.bytes).toEqual(wave);
  expect(result.voiceConfigHash).toMatch(/^[a-f0-9]{64}$/);
  expect(request).toHaveBeenCalledTimes(1);
  const call = request.mock.calls[0];
  expect(call?.[0]).toBe('https://api.openai.com/v1/audio/speech');
  expect(call?.[1]?.signal).toBe(signal);
  const body = call?.[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected a JSON speech request.');
  }
  const payload = z
    .strictObject({
      input: z.string(),
      model: z.string(),
      voice: z.string(),
      instructions: z.string(),
      response_format: z.string(),
    })
    .parse(JSON.parse(body));
  expect(payload.input).toBe(SpeechRequest.text);
  expect(payload.response_format).toBe('wav');
  expect(payload.voice).toBe('marin');
});

it('does not dispatch when the speech provider is unconfigured', async () => {
  const request = vi.fn<typeof fetch>();
  const speech = new OpenAiLessonSpeech(undefined, undefined, undefined, request);
  await expect(
    speech.synthesize(SpeechRequest, new AbortController().signal),
  ).rejects.toBeInstanceOf(LessonProviderNotDispatchedError);
  expect(request).not.toHaveBeenCalled();
});

it('cancels an oversized stream before accepting an artifact', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
  const speech = new OpenAiLessonSpeech('test-key', undefined, undefined, request);
  await expect(speech.synthesize(SpeechRequest, new AbortController().signal)).rejects.toThrow(
    'artifact allowance',
  );
  expect(cancelled).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

it('rejects overlong narration and failed provider responses without retrying', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(createWave({ sampleRate: 8000, durationMs: 300001 }).buffer),
    )
    .mockResolvedValueOnce(new Response('failure', { status: 429 }));
  const speech = new OpenAiLessonSpeech('test-key', undefined, undefined, request);
  await expect(speech.synthesize(SpeechRequest, new AbortController().signal)).rejects.toThrow(
    'duration limit',
  );
  await expect(speech.synthesize(SpeechRequest, new AbortController().signal)).rejects.toThrow(
    'narration failed',
  );
  expect(request).toHaveBeenCalledTimes(2);
});
