import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const assetsDirectory = resolve('src/desktop/assets');
const source = join(assetsDirectory, 'TroIcon.png');

if (process.platform !== 'darwin') {
  throw new Error('Regenerate the committed desktop icons on macOS using sips and iconutil.');
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tro-icons-'));

try {
  const iconset = join(temporaryDirectory, 'TroIcon.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const dimension = size * scale;
      const filename = `icon_${String(size)}x${String(size)}${scale === 2 ? '@2x' : ''}.png`;
      await runFile('/usr/bin/sips', [
        '-z',
        String(dimension),
        String(dimension),
        source,
        '--out',
        join(iconset, filename),
      ]);
    }
  }
  await runFile('/usr/bin/iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    join(assetsDirectory, 'TroIcon.icns'),
  ]);

  /* ICO frames contain the same transparent PNG artwork at Windows shell sizes. */
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const frames: Buffer[] = [];
  let offset = header.length;

  for (const [index, size] of sizes.entries()) {
    const framePath = join(temporaryDirectory, `TroIcon${String(size)}.png`);
    await runFile('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', framePath]);
    const frame = await readFile(framePath);
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    frames.push(frame);
    offset += frame.length;
  }
  await writeFile(join(assetsDirectory, 'TroIcon.ico'), Buffer.concat([header, ...frames]));
  console.info('Generated Tro macOS and Windows icons from TroIcon.png.');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
