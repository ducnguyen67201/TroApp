import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { OnboardingSpeechReceiptSchema } from './OnboardingSpeechReceipt.js';
import {
  shotIds,
  onboardingShots,
  videoTopics,
} from '../examples/previews/onboarding/VideoContent.js';
import {
  onboardingSpeechProfile,
  videoNarration,
} from '../examples/previews/onboarding/VideoNarration.js';

const execute = promisify(execFile);
const mediaRoot = resolve('examples/previews/onboarding/public');
let bytes = 0;

/* Local asset/timing validation only. This never calls a model or exports video. */
for (const [topic, narration] of Object.entries(videoNarration)) {
  const audioPath = resolve(mediaRoot, 'Audio', narration.file);
  const result = await execute('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ]);
  const audioSeconds = Number(result.stdout.trim());
  const raw: unknown = JSON.parse(await readFile(`${audioPath}.json`, 'utf8'));
  const receipt = OnboardingSpeechReceiptSchema.parse(raw);
  const expectedHash = createHash('sha256')
    .update(JSON.stringify({ ...onboardingSpeechProfile, text: narration.text }))
    .digest('hex');
  const audioHash = createHash('sha256')
    .update(await readFile(audioPath))
    .digest('hex');
  if (
    !Number.isFinite(audioSeconds) ||
    audioSeconds <= 0 ||
    audioSeconds + 0.15 > 10 ||
    expectedHash !== receipt.inputHash ||
    audioHash !== receipt.audioHash ||
    Math.abs(audioSeconds - receipt.durationSeconds) > 0.05
  ) {
    throw new Error(
      `${topic}: narration is outdated, missing, changed, or longer than the ten-second preview.`,
    );
  }
  bytes += (await stat(audioPath)).size;
  console.info(`${topic}: video 10.00s · OpenAI Marin narration ${audioSeconds.toFixed(2)}s`);
}

for (const key of shotIds) {
  const shot = onboardingShots[key];
  if (!shot.screen) {
    continue;
  }
  const image = await readFile(resolve(mediaRoot, 'Screens', shot.screen));
  if (image.length < 24 || image.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new Error(`${shot.screen}: expected a PNG capture.`);
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  const { crop, pointer } = shot;
  if (
    width !== 1280 ||
    height !== 800 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.x + crop.width > width ||
    crop.y + crop.height > height ||
    pointer.x < crop.x ||
    pointer.y < crop.y ||
    pointer.x > crop.x + crop.width ||
    pointer.y > crop.y + crop.height
  ) {
    throw new Error(`${key}: crop/cursor does not fit the captured screen.`);
  }
}
console.info(
  `Checked ${String(Object.keys(videoTopics).length)} ten-second previews, narration hashes/timing and all screenshot crops. Audio: ${(bytes / 1024 / 1024).toFixed(2)} MiB. No provider calls or video export.`,
);
