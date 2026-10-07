import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

const runFile = promisify(execFile);
let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

it('loads the checkout without a CLI app argument and forwards early callbacks exactly once', async () => {
  directory = await mkdtemp(join(tmpdir(), 'TroDevelopmentEntry-'));
  const mainDirectory = join(directory, 'out/main');
  await mkdir(mainDirectory, { recursive: true });
  const source = await readFile('src/desktop/main/StartDevelopmentHost.ts', 'utf8');
  const compiled = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ES2022, target: ScriptTarget.ES2022 },
  }).outputText;
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    join(directory, 'StartDevelopmentHost.js'),
    compiled.replace("from 'electron'", "from './ElectronFixture.js'"),
  );
  await writeFile(
    join(directory, 'HostConfig.json'),
    JSON.stringify({ projectDirectory: directory, appName: 'tro' }),
  );
  /* A standalone fixture exercises Node's real ESM loader and early event timing.
     It never launches Electron, registers an OS handler or accesses user data. */
  await writeFile(
    join(directory, 'ElectronFixture.js'),
    `
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
export class Host extends EventEmitter {
  appName = '';
  userData = '';
  /** @param {string} name */
  setName(name) { this.appName = name; }
  /** @param {string} key @param {string} path */
  setPath(key, path) { if (key === 'userData') this.userData = path; }
  /** @param {string} key */
  getPath(key) { if (key !== 'appData') throw new Error('Unexpected path'); return tmpdir(); }
}
export const app = new Host();
setTimeout(() => app.emit('open-url', { preventDefault() {} }, 'app.tro.desktop://auth/callback#token=synthetic'), 0);
`,
  );
  await writeFile(
    join(mainDirectory, 'Main.js'),
    `
import { app } from '../../ElectronFixture.js';
await new Promise((resolve) => setTimeout(resolve, 25));
let callbacks = 0;
app.on('open-url', () => { callbacks += 1; });
process.on('beforeExit', () => console.log(JSON.stringify({
  callbacks, appName: app.appName,
  userData: app.userData, workingDirectory: process.cwd(),
})));
`,
  );
  const { stdout } = await runFile(process.execPath, [join(directory, 'StartDevelopmentHost.js')], {
    timeout: 5000,
  });
  const body: unknown = JSON.parse(stdout);
  const result = z
    .strictObject({
      callbacks: z.number(),
      appName: z.string(),
      userData: z.string(),
      workingDirectory: z.string(),
    })
    .parse(body);
  expect(result).toEqual({
    callbacks: 1,
    appName: 'tro',
    userData: join(tmpdir(), 'tro'),
    workingDirectory: await realpath(directory),
  });
});
