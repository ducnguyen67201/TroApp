import { createHash } from 'node:crypto';
import type { SpeechCreateParams } from 'openai/resources/audio/speech';
import { LessonProviderNotDispatchedError } from '../application/LessonPorts.js';
import type { LessonSpeech } from '../application/LessonPorts.js';
import { LessonPrompts } from './LessonPrompts.js';

const maximumAudioBytes = 16 * 1024 * 1024;

/** Durable exact-script speech. Each physical request is admitted by the application before this adapter runs. */
export class OpenAiLessonSpeech implements LessonSpeech {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model = 'gpt-4o-mini-tts',
    private readonly voice = 'marin',
    private readonly request: typeof fetch = fetch,
  ) {}

  async synthesize(
    input: Parameters<LessonSpeech['synthesize']>[0],
    signal: AbortSignal,
  ): ReturnType<LessonSpeech['synthesize']> {
    if (!this.apiKey) {
      throw new LessonProviderNotDispatchedError(
        'Guided lesson narration requires a configured speech provider.',
      );
    }
    const instructions =
      input.language === 'vi' ? LessonPrompts.NARRATION_VI : LessonPrompts.NARRATION_EN;
    const response = await this.request('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        input: input.text,
        model: this.model,
        voice: this.voice,
        instructions,
        response_format: 'wav',
      } satisfies SpeechCreateParams),
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Guided lesson narration failed.');
    }
    const bytes = await readBoundedAudio(response.body, maximumAudioBytes);
    const measured = readWaveMetadata(bytes);
    if (measured.durationMs > 300_000) {
      throw new Error('Guided lesson narration exceeds its duration limit.');
    }
    return {
      bytes,
      mimeType: 'audio/wav',
      ...measured,
      voiceConfigHash: createHash('sha256')
        .update(
          JSON.stringify({
            model: this.model,
            voice: this.voice,
            language: input.language,
            instructions,
          }),
        )
        .digest('hex'),
    };
  }
}

/** Decode RIFF chunk metadata rather than assuming a fixed 44-byte WAV header. */
export function readWaveMetadata(bytes: Uint8Array): { durationMs: number; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Narration is not a valid WAV artifact.');
  }
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const kind = tag(offset);
    const declaredSize = view.getUint32(offset + 4, true);
    const start = offset + 8;
    // Streaming WAV may declare data length as UINT32_MAX; use actual accepted bytes.
    const size =
      kind === 'data' && declaredSize === 0xffffffff ? bytes.byteLength - start : declaredSize;
    if (start + size > bytes.byteLength) {
      throw new Error('Narration contains an incomplete WAV chunk.');
    }
    if (kind === 'fmt ') {
      if (size < 16 || view.getUint16(start, true) !== 1) {
        throw new Error('Narration must use PCM WAV.');
      }
      sampleRate = view.getUint32(start + 4, true);
      byteRate = view.getUint32(start + 8, true);
      const channels = view.getUint16(start + 2, true);
      const bits = view.getUint16(start + 14, true);
      blockAlign = view.getUint16(start + 12, true);
      if (
        channels < 1 ||
        channels > 2 ||
        bits !== 16 ||
        blockAlign !== channels * 2 ||
        byteRate !== sampleRate * blockAlign
      ) {
        throw new Error('Narration has unsupported PCM parameters.');
      }
    } else if (kind === 'data') {
      if (blockAlign === 0 || size % blockAlign !== 0) {
        throw new Error('Narration data must contain whole PCM sample frames.');
      }
      dataSize += size;
    }
    offset = start + size + (size % 2);
  }
  if (sampleRate < 8000 || sampleRate > 96000 || byteRate === 0 || dataSize === 0) {
    throw new Error('Narration has no valid PCM samples.');
  }
  return { sampleRate, durationMs: Math.ceil((dataSize / byteRate) * 1000) };
}

async function readBoundedAudio(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error('Narration exceeds its artifact allowance.');
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
