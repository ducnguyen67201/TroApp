import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import electron from 'electron';
import { resolveConfig } from 'electron-vite';
import { build } from 'vite';

const executeFile = promisify(execFile);
const electronExecutable: unknown = electron;

if (typeof electronExecutable !== 'string') {
  throw new Error('Run this check with Node, not inside Electron.');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'tro-worker-smoke-'));

/* Generated smoke-only Electron entry. No window, credentials, driver or model
   request: a stop command exercises module loading and the real utility port. */
const probeSource = `
const { app, utilityProcess } = require('electron');
const requestId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
let child;
let finished = false;
const timeout = setTimeout(() => finish(1, 'Worker startup timed out.'), 10000);
function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  console.log(message);
  if (child) child.kill();
  app.exit(code);
}
app.whenReady().then(() => {
  child = utilityProcess.fork(process.argv[2], [], { stdio: 'pipe' });
  child.stderr.on('data', (data) => process.stderr.write(data));
  child.once('spawn', () => {
    child.postMessage({ requestId, command: { kind: 'stop', sessionId } });
  });
  child.on('message', (message) => {
    if (message.requestId === requestId && message.result?.kind === 'stopped') {
      finish(0, 'Worker loaded and answered stop without starting an agent.');
    } else {
      finish(1, 'Unexpected worker response.');
    }
  });
  child.once('exit', () => finish(1, 'Worker exited before responding.'));
}).catch(() => finish(1, 'Could not start the Electron probe.'));
`;

try {
  const probePath = join(temporaryRoot, 'WorkerProbe.cjs');
  await writeFile(probePath, probeSource);
  /* Use an ESM package boundary for the generated worker's .js chunks. */
  await writeFile(join(temporaryRoot, 'package.json'), '{"type":"module"}');

  for (const mode of ['development', 'production'] as const) {
    const resolved = await resolveConfig(
      { envFile: false, mode, logLevel: 'warn' },
      mode === 'development' ? 'serve' : 'build',
      mode,
    );
    const main = resolved.config?.main;
    if (!main) {
      throw new Error('The Electron main build configuration is missing.');
    }

    const outputDirectory = join(temporaryRoot, mode);
    await build({
      ...main,
      envFile: false,
      build: { ...main.build, outDir: outputDirectory, watch: null },
    });

    /* The probe needs no Doppler configuration. Only OS/runtime lookup settings
       are forwarded, never API keys, database URLs or auth credentials. */
    const environment: NodeJS.ProcessEnv = { NODE_ENV: mode };
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP']) {
      const value = process.env[name];
      if (value !== undefined) {
        environment[name] = value;
      }
    }
    const result = await executeFile(
      electronExecutable,
      [probePath, join(outputDirectory, 'StartAgentWorker.js')],
      { env: environment, timeout: 15000 },
    );
    console.info(`${mode}: ${result.stdout.trim()}`);
  }
} finally {
  /* Remove only the unique temporary build directory owned by this check. */
  await rm(temporaryRoot, { recursive: true, force: true });
}
