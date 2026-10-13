import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Names are generated locally, never taken from API input. All clips share the trusted codec. */
export async function combineLessonClips(
  directory: string,
  count: number,
  output: string,
  signal: AbortSignal,
): Promise<void> {
  const manifest = join(directory, 'Clips.txt');
  await writeFile(
    manifest,
    Array.from({ length: count }, (_, index) => `file 'Clip${String(index)}.mp4'`).join('\n'),
  );
  await promisify(execFile)(
    'ffmpeg',
    [
      '-nostdin',
      '-y',
      '-f',
      'concat',
      '-safe',
      '1',
      '-i',
      manifest,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ],
    { signal, timeout: 180000, maxBuffer: 1024 * 1024 },
  );
}
