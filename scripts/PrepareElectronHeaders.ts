import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { prepareElectronHeaders } from './ElectronHeaders.js';

try {
  const rawPackage: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const packageMetadata = z
    .looseObject({
      devDependencies: z.looseObject({ electron: z.string() }),
    })
    .parse(rawPackage);
  await prepareElectronHeaders({
    electronVersion: packageMetadata.devDependencies.electron,
    architecture: process.arch,
  });
} catch {
  console.error('Electron header preparation failed. Inspect desktop.headers events.');
  process.exitCode = 1;
}
