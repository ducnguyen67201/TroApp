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

/* The scripted MCP peer exercises preparation and task rebinding without desktop
   access or model requests. Durations are fixture measurements, not native readiness. */
const fixtureSource = `
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'Tro readiness fixture', version: '1' }
  };
  if (request.method === 'tools/list') result = { tools: [{
    name: 'get_desktop_info', description: 'Fixture only', inputSchema: { type: 'object', properties: {} }
  }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

const probeSource = `
const { app, utilityProcess } = require('electron');
const { randomUUID } = require('node:crypto');
let child;
let finished = false;
let requestId;
let sessionId = randomUUID();
let stage = 'prepare';
let tasks = 0;
let startedAt;
let readyMs;
let boundAt;
const bindingMs = [];
const timeout = setTimeout(() => finish(1, 'Worker lifecycle timed out.'), 10000);
function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  console.log(message);
  if (child) child.kill();
  app.exit(code);
}
const driver = { command: process.execPath, args: [process.argv[3]], env: { ELECTRON_RUN_AS_NODE: '1' } };
function send(command) {
  requestId = randomUUID();
  child.postMessage({ requestId, command });
}
function begin() {
  stage = 'start';
  sessionId = randomUUID();
  boundAt = performance.now();
  send({ kind: 'start', sessionId, debugEnabled: false, desktopDriver: driver,
    gatewayToken: 'fixture-never-sent', gatewayBaseUrl: 'http://127.0.0.1:1' });
}
app.whenReady().then(() => {
  startedAt = performance.now();
  child = utilityProcess.fork(process.argv[2], [], { stdio: 'pipe' });
  child.stderr.on('data', data => process.stderr.write(data));
  child.once('spawn', () => send({ kind: 'prepare', sessionId, debugEnabled: false, desktopDriver: driver }));
  child.on('message', message => {
    if (message.requestId !== requestId || !message.result) return finish(1, 'Unexpected worker response.');
    if (stage === 'prepare' && message.result.kind === 'started') {
      readyMs = performance.now() - startedAt;
      return begin();
    }
    if (stage === 'start' && message.result.kind === 'started') {
      bindingMs.push(performance.now() - boundAt);
      stage = 'finish';
      return send({ kind: 'finish', sessionId });
    }
    if (stage === 'finish' && message.result.kind === 'stopped') {
      if (++tasks < 2) return begin();
      return finish(0, JSON.stringify({ fixture: 'scripted-mcp-no-model', readyMs, bindingMs, tasks, pid: child.pid }));
    }
    finish(1, 'Worker lifecycle command failed.');
  });
  child.once('exit', () => finish(1, 'Worker exited before responding.'));
}).catch(() => finish(1, 'Could not start the Electron probe.'));
`;

try {
  const probePath = join(temporaryRoot, 'WorkerProbe.cjs');
  await writeFile(probePath, probeSource);
  const fixturePath = join(temporaryRoot, 'McpFixture.cjs');
  await writeFile(fixturePath, fixtureSource);
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
      plugins: [
        ...(main.plugins ?? []),
        {
          name: 'check-idle-presentation-bundle',
          generateBundle(_options, bundle) {
            const visited = new Set<string>();
            const inspect = (name: string): void => {
              if (visited.has(name)) {
                return;
              }
              visited.add(name);
              const chunk = bundle[name];
              if (!chunk || chunk.type !== 'chunk') {
                return;
              }
              for (const moduleId of Object.keys(chunk.modules)) {
                if (
                  /src\/desktop\/worker\/(?:agent|execution|teaching|cua|observation)\//.test(
                    moduleId.replaceAll('\\', '/'),
                  )
                ) {
                  throw new Error('Idle presentation imports task orchestration: ' + moduleId);
                }
              }
              for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
                inspect(dependency);
              }
            };
            inspect('StartCompanionHudWorker.js');
          },
        },
      ],
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
      [probePath, join(outputDirectory, 'StartAgentWorker.js'), fixturePath],
      { env: environment, timeout: 15000 },
    );
    console.info(`${mode}: ${result.stdout.trim()}`);
  }
} finally {
  /* Remove only the unique temporary build directory owned by this check. */
  await rm(temporaryRoot, { recursive: true, force: true });
}
