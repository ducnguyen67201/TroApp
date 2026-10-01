import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

await cp('scripts/DesktopEntitlements.plist', 'out/DesktopEntitlements.plist');
await mkdir('out/node_modules', { recursive: true });
await cp('node_modules/uiohook-napi', 'out/node_modules/uiohook-napi', {
  recursive: true,
  dereference: true,
});
const require = createRequire(import.meta.url);
const nativeLoaderDirectory = dirname(
  require.resolve('node-gyp-build/package.json', {
    paths: [dirname(require.resolve('uiohook-napi/package.json'))],
  }),
);
await cp(nativeLoaderDirectory, 'out/node_modules/node-gyp-build', {
  recursive: true,
  dereference: true,
});

/* The worker bundles its TypeScript dependencies. PackageDesktop.ts adds a
 * verified Cua Driver release as an executable resource outside ASAR. The app
 * package includes only the native shortcut addon and its loader. */
await writeFile(
  'out/package.json',
  JSON.stringify(
    {
      ...packageMetadata,
      type: 'module',
      main: 'main/Main.js',
      description: 'Tro desktop workspace',
      dependencies: { 'uiohook-napi': '1.5.5', 'node-gyp-build': '4.8.4' },
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
