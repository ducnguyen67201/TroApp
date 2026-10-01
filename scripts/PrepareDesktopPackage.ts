import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const metadata: unknown = JSON.parse(await readFile('package.json', 'utf8'));
const packageMetadata = z
  .object({
    name: z.string(),
    version: z.string(),
    build: z.record(z.string(), z.unknown()),
    devDependencies: z.object({ electron: z.string() }),
  })
  .parse(metadata);

/* The worker bundles its TypeScript dependencies. PackageDesktop.ts adds a
 * verified Cua Driver release as an executable resource outside ASAR. The app
 * package has no runtime node_modules or backend dependencies. */
await writeFile(
  'out/package.json',
  JSON.stringify(
    {
      ...packageMetadata,
      type: 'module',
      main: 'main/Main.js',
      description: 'Tro desktop workspace',
      dependencies: {},
      build: {
        ...packageMetadata.build,
        electronVersion: packageMetadata.devDependencies.electron,
        directories: { output: '../release' },
      },
    },
    null,
    2,
  ) + '\n',
);
