import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const metadata: unknown = JSON.parse(await readFile('package.json', 'utf8'));
const packageMetadata = z.object({ name: z.string(), version: z.string() }).parse(metadata);

/* Bundle desktop dependencies and give the packager an isolated app root. Backend Prisma,
 * migrations, server code, and backend-only dependencies never enter the desktop artifact. */
await writeFile(
  'out/package.json',
  JSON.stringify(
    {
      ...packageMetadata,
      type: 'module',
      main: 'main/Main.js',
      description: 'Tro desktop workspace',
    },
    null,
    2,
  ) + '\n',
);
