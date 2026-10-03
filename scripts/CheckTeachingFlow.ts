import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveConfig } from 'electron-vite';
import electron from 'electron';
import { build } from 'vite';
import { prepareDesktopDevelopmentHost } from './PrepareDesktopDevelopmentHost.js';

const executeFile = promisify(execFile);
const wantsNative = process.argv.includes('--native');
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'TroTeachingContract-')));

/** Build the production worker and preload with their normal Vite settings.
 * The isolated composition replaces only auth, model service, and desktop peer.
 * The optional native check uses the real main-owned host before that flow. */
async function checkTeachingFlow(): Promise<void> {
  const executable: unknown = wantsNative ? await prepareDesktopDevelopmentHost() : electron;
  if (typeof executable !== 'string') {
    throw new Error('Launch the contract from Node.');
  }
  await writeFile(join(temporaryRoot, 'package.json'), '{"type":"module"}');
  await symlink(resolve('node_modules'), join(temporaryRoot, 'node_modules'), 'junction');
  const rendererSource = relative(
    temporaryRoot,
    resolve('test/desktop/worker/teaching/flow/TeachingFlowRenderer.tsx'),
  )
    .split('\\')
    .join('/');
  await writeFile(
    join(temporaryRoot, 'index.html'),
    `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="${rendererSource}"></script></body></html>`,
  );
  const resolved = await resolveConfig(
    { envFile: false, mode: 'production', logLevel: 'warn' },
    'build',
    'production',
  );
  const { main, preload, renderer } = resolved.config ?? {};
  if (!main || !preload || !renderer) {
    throw new Error('Desktop build configuration is missing.');
  }
  await build({
    ...main,
    configFile: false,
    envFile: false,
    build: {
      ...main.build,
      outDir: join(temporaryRoot, 'main'),
      emptyOutDir: false,
      watch: null,
      lib: {
        entry: {
          TeachingFlowApp: resolve('test/desktop/worker/teaching/flow/TeachingFlowApp.ts'),
          TeachingMcpFixture: resolve('test/desktop/worker/teaching/flow/TeachingMcpFixture.ts'),
          StartAgentWorker: resolve('src/desktop/worker/StartAgentWorker.ts'),
        },
        formats: ['es'],
        fileName: (_format, name) => `${name}.js`,
      },
    },
  });
  await build({
    ...preload,
    configFile: false,
    envFile: false,
    build: {
      ...preload.build,
      outDir: join(temporaryRoot, 'preload'),
      emptyOutDir: false,
      watch: null,
    },
  });
  await build({
    ...renderer,
    configFile: false,
    envFile: false,
    root: temporaryRoot,
    base: './',
    build: {
      ...renderer.build,
      outDir: join(temporaryRoot, 'renderer'),
      watch: null,
      rollupOptions: { ...renderer.build?.rollupOptions, input: join(temporaryRoot, 'index.html') },
    },
  });
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  try {
    const result = await executeFile(
      executable,
      [
        join(temporaryRoot, 'main', 'TeachingFlowApp.js'),
        temporaryRoot,
        process.execPath,
        ...(wantsNative ? ['--native'] : []),
      ],
      { env: environment, timeout: 150000, maxBuffer: 1_000_000 },
    );
    console.info(result.stdout.trim());
  } catch (error) {
    // Child output contains only contract stages and the production redacted logger.
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
      console.error(error.stdout.trim());
    }
    throw new Error('Teaching flow contract failed. See the failing stage above.', {
      cause: error,
    });
  }
}

try {
  await checkTeachingFlow();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
