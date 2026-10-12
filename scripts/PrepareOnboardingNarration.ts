import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import type { SpeechCreateParams } from 'openai/resources/audio/speech';
import { OnboardingSpeechReceiptSchema } from './OnboardingSpeechReceipt.js';
import { readOnboardingSpeechEnv } from './Env.js';
import {
  onboardingSpeechProfile,
  videoNarration,
} from '../examples/previews/onboarding/VideoNarration.js';

const execute = promisify(execFile);

async function measureAudio(path: string): Promise<number> {
  const result = await execute('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const seconds = Number(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Generated narration has no valid audio duration.');
  }
  return seconds;
}

/** Bounded provider adapter; no automatic retries after a paid or unknown outcome. */
async function fetchSpeech(apiKey: string, text: string): Promise<Uint8Array> {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ...onboardingSpeechProfile,
      input: text,
      response_format: 'mp3',
    } satisfies SpeechCreateParams),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok || !response.body) {
    console.warn('onboarding.narration.failed', {
      stage: 'provider',
      status: response.status,
      requestId: response.headers.get('x-request-id'),
    });
    await response.body?.cancel();
    throw new Error('OpenAI narration request failed; no automatic retry was made.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let item = await reader.read();
    while (!item.done) {
      size += item.value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Narration exceeds its byte limit.');
      }
      chunks.push(item.value);
      item = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
  const audio = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return audio;
}

async function prepareNarration(): Promise<void> {
  if (!process.argv.includes('--generate')) {
    throw new Error(
      'Paid audio generation requires --generate and an authorized Doppler invocation. Use check:onboarding-videos for local validation.',
    );
  }
  const { apiKey } = readOnboardingSpeechEnv(process.env);
  const output = resolve('examples/previews/onboarding/public/Audio');
  const working = resolve('.tro-development/onboarding-narration');
  await mkdir(output, { recursive: true });
  await mkdir(working, { recursive: true });
  for (const [topic, narration] of Object.entries(videoNarration)) {
    const destination = join(output, narration.file);
    const receiptPath = join(output, `${narration.file}.json`);
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ ...onboardingSpeechProfile, text: narration.text }))
      .digest('hex');
    let cached = false;
    try {
      const raw: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
      const receipt = OnboardingSpeechReceiptSchema.parse(raw);
      cached =
        receipt.inputHash === inputHash &&
        receipt.audioHash ===
          createHash('sha256')
            .update(await readFile(destination))
            .digest('hex');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new Error(
          'Narration cache is invalid; review the local audio and receipt before regenerating.',
          { cause: error },
        );
      }
    }
    if (cached) {
      console.info(`${topic}: using matching OpenAI narration cache`);
      continue;
    }
    const original = join(working, `${topic}Source.mp3`);
    const prepared = join(working, `${topic}Prepared.mp3`);
    console.info(`${topic}: requesting one OpenAI Vietnamese narration`);
    await writeFile(original, await fetchSpeech(apiKey, narration.text));
    const sourceDurationSeconds = await measureAudio(original);
    const tempoFactor = Math.max(1, sourceDurationSeconds / 9.3);
    if (tempoFactor > 1.15) {
      throw new Error(
        `${topic}: speech is too long; shorten the script before another authorized generation. The source audio was preserved.`,
      );
    }
    await execute('ffmpeg', [
      '-y',
      '-i',
      original,
      '-vn',
      '-af',
      `atempo=${String(tempoFactor)},loudnorm=I=-18:TP=-2:LRA=7`,
      '-ar',
      '24000',
      '-ac',
      '1',
      '-b:a',
      '64k',
      prepared,
    ]);
    const durationSeconds = await measureAudio(prepared);
    if (durationSeconds + 0.15 > 10) {
      throw new Error(
        `${topic}: narration exceeds the ten-second video; source audio was preserved.`,
      );
    }
    const audioHash = createHash('sha256')
      .update(await readFile(prepared))
      .digest('hex');
    await rename(prepared, destination);
    await writeFile(
      receiptPath,
      `${JSON.stringify({ inputHash, audioHash, durationSeconds, sourceDurationSeconds, tempoFactor, provider: 'openai', voice: 'marin' })}\n`,
    );
    console.info(
      `${topic}: ${durationSeconds.toFixed(2)}s, OpenAI Marin; video remains unexported`,
    );
  }
}

try {
  await prepareNarration();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Onboarding narration preparation failed.',
  );
  process.exitCode = 1;
}
