import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  createDevelopmentProcessGroup,
  parseDevelopmentProcesses,
  selectDevelopmentProcesses,
  type DevelopmentProcess,
} from '../../scripts/DevelopmentProcesses.js';

const executeFile = promisify(execFile);
const fixtureTimeoutMs = 5_000;

function createProcess(
  pid: number,
  parentId: number,
  command = `/workspace/Tro/Fixture-${String(pid)}.cjs`,
): DevelopmentProcess {
  return {
    pid,
    parentId,
    groupId: pid,
    startedAt: 'Mon Oct 12 10:00:00 2026',
    command,
    executable: '/usr/local/bin/node',
  };
}

it('preserves POSIX start times, command arguments and executable paths containing spaces', () => {
  const processes = parseDevelopmentProcesses(
    [
      '  123 1 123 Mon Oct 12 10:00:00 2026 /usr/local/bin/node --watch /workspace/Tro/src/server/StartApi.ts',
      '  124 123 123 S+ Mon Oct 12 10:00:01 2026 /Applications/Tro Desktop.app/Contents/MacOS/Tro --development',
    ].join('\n'),
    ['123 /usr/local/bin/node', '124 /Applications/Tro Desktop.app/Contents/MacOS/Tro'].join('\n'),
  );

  expect(processes).toEqual([
    {
      pid: 123,
      parentId: 1,
      groupId: 123,
      startedAt: 'Mon Oct 12 10:00:00 2026',
      command: '/usr/local/bin/node --watch /workspace/Tro/src/server/StartApi.ts',
      executable: '/usr/local/bin/node',
    },
    {
      pid: 124,
      parentId: 123,
      groupId: 123,
      startedAt: 'Mon Oct 12 10:00:01 2026',
      command: '/Applications/Tro Desktop.app/Contents/MacOS/Tro --development',
      executable: '/Applications/Tro Desktop.app/Contents/MacOS/Tro',
    },
  ]);
});

it('fails closed for malformed process identities, start times and executable metadata', () => {
  const valid = '123 1 123 Mon Oct 12 10:00:00 2026 /usr/local/bin/node Fixture.cjs';
  for (const fixture of [
    { output: 'not a process record', executables: '123 /usr/local/bin/node' },
    { output: valid.replace('10:00:00', 'unknown-time'), executables: '123 /usr/local/bin/node' },
    { output: valid.replace('123 1 123', '0 1 123'), executables: '0 /usr/local/bin/node' },
    { output: valid, executables: 'missing executable identity' },
  ]) {
    expect(() => parseDevelopmentProcesses(fixture.output, fixture.executables)).toThrow();
  }
});

it('ignores exited processes, zombies and kernel tasks without a process group', () => {
  const processes = parseDevelopmentProcesses(
    [
      '123 1 123 S Mon Oct 12 10:00:00 2026 node Fixture.cjs',
      '124 1 124 S Mon Oct 12 10:00:00 2026 node Exited.cjs',
      '125 1 125 Z Mon Oct 12 10:00:00 2026 node Zombie.cjs',
      '126 0 0 S Mon Oct 12 10:00:00 2026 KernelTask',
    ].join('\n'),
    ['123 /usr/local/bin/node', '125 /usr/local/bin/node', '126 KernelTask'].join('\n'),
  );

  expect(processes.map((entry) => entry.pid)).toEqual([123]);
});

it('selects orphaned owned roots and unsorted descendants without selecting the launcher tree or foreign workspace', () => {
  const grandchild = createProcess(220, 210);
  const processes = [
    grandchild,
    createProcess(90, 80),
    createProcess(120, 110),
    createProcess(300, 1, '/workspace/Other/src/server/StartApi.ts'),
    createProcess(200, 1),
    createProcess(110, 100),
    createProcess(210, 200),
    createProcess(80, 1),
    createProcess(100, 90),
    createProcess(301, 300, '/workspace/Other/Child.cjs'),
    grandchild,
  ];

  const selected = selectDevelopmentProcesses(processes, 100, new Set([90, 110, 200, 999]));

  expect(selected.map((entry) => entry.pid).sort((left, right) => left - right)).toEqual([
    200, 210, 220,
  ]);
  expect(new Set(selected.map((entry) => entry.pid)).size).toBe(selected.length);
});

it('refuses process selection when the current launcher identity is missing', () => {
  expect(() => selectDevelopmentProcesses([createProcess(200, 1)], 100, new Set([200]))).toThrow();
});

it.skipIf(process.platform === 'win32')(
  'stops a previous workspace watcher and its child while keeping a foreign node process alive',
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'tro-development test-'));
    const workspace = join(temporary, 'Owned');
    const foreignWorkspace = join(temporary, 'Foreign');
    let launcher: ChildProcess | null = null;
    let orphanPids: number[] = [];
    let fixturePids: number[] = [];
    let group: Awaited<ReturnType<typeof createDevelopmentProcessGroup>> | null = null;
    try {
      const fixture = await writeProcessTree(workspace, 'src/server/StartApi.ts');
      const processes = await createDevelopmentProcessGroup(workspace);
      group = processes;
      const foreignEntry = join(foreignWorkspace, 'src/server/StartApi.ts');
      await mkdir(dirname(foreignEntry), { recursive: true });
      await writeFile(foreignEntry, 'setInterval(() => {}, 1_000);\n');
      const orphanLauncher = await writeOrphanLauncher(temporary);
      launcher = spawn(
        process.execPath,
        [
          orphanLauncher.entry,
          fixture.entry,
          fixture.pidsPath,
          workspace,
          foreignEntry,
          foreignWorkspace,
          orphanLauncher.pidsPath,
        ],
        { cwd: temporary, env: {}, detached: true, stdio: 'ignore' },
      );
      const launcherPid = await waitForChildSpawn(launcher);
      orphanPids = await waitForFixturePids(orphanLauncher.pidsPath, 2);
      const [previousPid, foreignPid] = orphanPids;
      if (previousPid === undefined || foreignPid === undefined) {
        throw new Error('Orphan launcher did not report both fixture roots.');
      }
      // Both roots must escape the current launcher's protected tree before ownership is tested.
      await waitForFixtureExit([launcherPid]);
      await waitForFixtureReparenting(orphanPids, launcherPid);
      fixturePids = await waitForFixturePids(fixture.pidsPath);
      expect(fixturePids[0]).toBe(previousPid);

      await processes.stopPrevious();

      await waitForFixtureExit(fixturePids);
      expect(await isProcessRunning(foreignPid)).toBe(true);
    } finally {
      try {
        await group?.close();
      } finally {
        try {
          await cleanFixtureProcesses([launcher], [...fixturePids, ...orphanPids]);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    }
  },
  15_000,
);

it.skipIf(process.platform === 'win32')(
  'closes a managed process group including grandchildren and refuses to spawn after close',
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'tro-managed-process test-'));
    let root: ChildProcess | null = null;
    let fixturePids: number[] = [];
    let group: Awaited<ReturnType<typeof createDevelopmentProcessGroup>> | null = null;
    try {
      const fixture = await writeProcessTree(temporary, 'FixtureRoot.cjs');
      const processes = await createDevelopmentProcessGroup(temporary);
      group = processes;
      root = processes.spawn(process.execPath, [fixture.entry, fixture.pidsPath], {});
      const rootPid = await waitForChildSpawn(root);
      fixturePids = await waitForFixturePids(fixture.pidsPath);
      expect(fixturePids[0]).toBe(rootPid);
      expect(fixturePids).toHaveLength(3);

      await processes.close();

      await waitForFixtureExit(fixturePids);
      await expect(processes.close()).resolves.toBeUndefined();
      expect(() => processes.spawn(process.execPath, ['-e', 'process.exit(0)'], {})).toThrow();
    } finally {
      try {
        await group?.close();
      } finally {
        try {
          await cleanFixtureProcesses([root], fixturePids);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    }
  },
  15_000,
);

/** Fixtures have no Tro imports, network access or credentials; their only output is a PID file. */
async function writeProcessTree(
  workspace: string,
  entryName: string,
): Promise<{ entry: string; pidsPath: string }> {
  const entry = join(workspace, entryName);
  const branch = join(workspace, 'FixtureBranch.cjs');
  const pidsPath = join(workspace, 'FixturePids.txt');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(
    entry,
    [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, [${JSON.stringify(branch)}, process.argv[2]], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1_000);',
    ].join('\n'),
  );
  await writeFile(
    branch,
    [
      "const { spawn } = require('node:child_process');",
      "const { renameSync, writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
      "child.once('spawn', () => { writeFileSync(`${process.argv[2]}.tmp`, [process.ppid, process.pid, child.pid].join('\\n')); renameSync(`${process.argv[2]}.tmp`, process.argv[2]); });",
      'setInterval(() => {}, 1_000);',
    ].join('\n'),
  );
  return { entry, pidsPath };
}

/** The detached intermediary exits so both test roots resemble survivors of an older launcher. */
async function writeOrphanLauncher(
  workspace: string,
): Promise<{ entry: string; pidsPath: string }> {
  const entry = join(workspace, 'OrphanLauncher.cjs');
  const pidsPath = join(workspace, 'OrphanPids.txt');
  await writeFile(
    entry,
    [
      "const { spawn } = require('node:child_process');",
      "const { renameSync, writeFileSync } = require('node:fs');",
      'const roots = [',
      "  spawn(process.execPath, [process.argv[2], process.argv[3]], { cwd: process.argv[4], stdio: 'ignore' }),",
      "  spawn(process.execPath, [process.argv[5]], { cwd: process.argv[6], stdio: 'ignore' }),",
      '];',
      'let ready = 0;',
      'for (const child of roots) {',
      "  child.once('error', () => { for (const root of roots) { root.kill('SIGKILL'); } process.exitCode = 1; });",
      "  child.once('spawn', () => {",
      '    ready += 1;',
      '    if (ready === roots.length) {',
      "      writeFileSync(`${process.argv[7]}.tmp`, roots.map((root) => root.pid).join('\\n'));",
      '      renameSync(`${process.argv[7]}.tmp`, process.argv[7]);',
      '      for (const root of roots) { root.unref(); }',
      '    }',
      '  });',
      '}',
    ].join('\n'),
  );
  return { entry, pidsPath };
}

function waitForChildSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      if (child.pid === undefined) {
        reject(new Error('Fixture did not report a process ID.'));
        return;
      }
      resolve(child.pid);
    });
  });
}

async function waitForFixturePids(path: string, expectedCount = 3): Promise<number[]> {
  const deadline = Date.now() + fixtureTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, 'utf8');
      const entries = contents.split('\n');
      if (entries.length !== expectedCount || entries.some((entry) => !/^[1-9]\d*$/.test(entry))) {
        throw new Error('Fixture PID file is malformed.');
      }
      const pids = entries.map(Number);
      if (pids.some((pid) => !Number.isSafeInteger(pid))) {
        throw new Error('Fixture PID is outside the supported range.');
      }
      return pids;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error('Fixture did not start within the deadline.');
}

async function waitForFixtureReparenting(
  pids: readonly number[],
  previousParentId: number,
): Promise<void> {
  const deadline = Date.now() + fixtureTimeoutMs;
  while (Date.now() < deadline) {
    const parents = await Promise.all(
      pids.map(async (pid) => {
        const { stdout } = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'ppid='], {
          encoding: 'utf8',
          timeout: 1_000,
        });
        const parentId = Number(stdout.trim());
        if (!Number.isSafeInteger(parentId) || parentId < 1) {
          throw new Error('Fixture parent identity is unavailable.');
        }
        return parentId;
      }),
    );
    if (parents.every((parentId) => parentId !== previousParentId && parentId !== process.pid)) {
      return;
    }
    await delay(25);
  }
  throw new Error('Fixture roots did not leave the launcher tree within the deadline.');
}

async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    const { stdout } = await executeFile('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    return stdout.trim().length > 0 && !stdout.trim().startsWith('Z');
  } catch (error) {
    if (hasErrorCode(error, 1)) {
      return false;
    }
    throw error;
  }
}

async function waitForFixtureExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + fixtureTimeoutMs;
  while (Date.now() < deadline) {
    const running = await Promise.all(pids.map(isProcessRunning));
    if (running.every((value) => !value)) {
      return;
    }
    await delay(25);
  }
  throw new Error('Fixture process tree did not stop within the deadline.');
}

async function cleanFixtureProcesses(
  children: readonly (ChildProcess | null)[],
  pids: readonly number[],
): Promise<void> {
  const allPids = new Set(pids);
  for (const child of children) {
    if (child?.pid !== undefined) {
      allPids.add(child.pid);
      // Every fixture root owns a detached process group, including the helper's spawn.
      signalFixture(-child.pid);
      child.kill('SIGKILL');
    }
  }
  for (const pid of pids) {
    signalFixture(pid);
  }
  await waitForFixtureExit([...allPids]);
}

function signalFixture(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!hasErrorCode(error, 'ESRCH')) {
      throw error;
    }
  }
}

function hasErrorCode(error: unknown, code: string | number): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
