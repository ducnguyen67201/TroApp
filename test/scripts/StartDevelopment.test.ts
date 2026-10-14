import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

const startupScript = fileURLToPath(new URL('../../scripts/StartDevelopment.ts', import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
const syntheticSecret = 'synthetic-startup-secret-never-emit-this';
const genericFailure =
  'Development startup failed. Check local configuration and host prerequisites.';
const startupFailureSchema = z.strictObject({
  event: z.literal('development.startup.failed'),
  stage: z.enum(['previous-process-cleanup', 'desktop-environment']),
  reason: z.string().min(1),
  processMetadata: z
    .strictObject({
      source: z.enum(['processes', 'executables']),
      recordNumber: z.number().int().positive(),
      recordLength: z.number().int().nonnegative(),
      pid: z.number().int().positive().nullable(),
      hasStartTime: z.boolean(),
    })
    .optional(),
});

interface StartupResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

it.skipIf(process.platform === 'win32')(
  'reports a missing process-list tool with a safe OS reason instead of environment values',
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'tro-startup-missing-tool-'));
    try {
      const bin = await createIsolatedBin(temporary);
      const result = await runStartup(temporary, {
        PATH: bin,
        HOME: temporary,
        TMPDIR: temporary,
        OPENAI_API_KEY: syntheticSecret,
      });

      expectStartupFailure(result, {
        stage: 'previous-process-cleanup',
        reason: 'Host operation failed (ENOENT).',
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  15_000,
);

it.skipIf(process.platform === 'win32').each([
  { exitCode: 0, reason: 'Development process metadata is unavailable.' },
  { exitCode: 1, reason: 'Unexpected startup failure.' },
])(
  'reports process-tool failure safely when the tool exits with $exitCode',
  async ({ exitCode, reason }) => {
    const temporary = await mkdtemp(join(tmpdir(), 'tro-startup-malformed-processes-'));
    try {
      const bin = await createIsolatedBin(temporary);
      await writeFile(
        join(bin, 'ps'),
        [
          '#!/bin/sh',
          "printf '%s\\n' 'malformed process metadata'",
          'printf \'%s\\n\' "$OPENAI_API_KEY" >&2',
          `exit ${String(exitCode)}`,
        ].join('\n'),
        { mode: 0o700 },
      );
      const result = await runStartup(temporary, {
        PATH: bin,
        HOME: temporary,
        TMPDIR: temporary,
        OPENAI_API_KEY: syntheticSecret,
      });

      expectStartupFailure(result, {
        stage: 'previous-process-cleanup',
        reason,
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  15_000,
);

it.skipIf(process.platform === 'win32').each(['C', 'en_CA.UTF-8', 'en_GB.UTF-8', 'fr_CA.UTF-8'])(
  'passes process cleanup under locale %s before reporting a missing desktop home directory',
  async (locale) => {
    const temporary = await mkdtemp(join(tmpdir(), 'tro-startup-invalid-environment-'));
    try {
      const bin = await createIsolatedBin(temporary);
      const ps = await findHostExecutable(['/bin/ps', '/usr/bin/ps']);
      if (ps === null) {
        throw new Error('The POSIX startup fixture requires the system process-list tool.');
      }
      await symlink(ps, join(bin, 'ps'));
      const lsof = await findHostExecutable([
        '/usr/sbin/lsof',
        '/usr/bin/lsof',
        '/bin/lsof',
        '/usr/local/bin/lsof',
        '/opt/homebrew/bin/lsof',
      ]);
      if (lsof !== null) {
        await symlink(lsof, join(bin, 'lsof'));
      } else if (process.platform === 'darwin') {
        throw new Error('The macOS startup fixture requires the system directory-list tool.');
      }
      const result = await runStartup(temporary, {
        PATH: bin,
        TMPDIR: temporary,
        LANG: locale,
        LC_TIME: locale,
        LC_ALL: locale,
        OPENAI_API_KEY: syntheticSecret,
      });

      expectStartupFailure(result, {
        stage: 'desktop-environment',
        reason: 'Desktop host environment is invalid.',
      });
      expect(result.stdout).not.toContain('Stopped');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  15_000,
);

/** Only explicitly linked host tools are reachable; Docker and native service launchers are absent. */
async function createIsolatedBin(workspace: string): Promise<string> {
  const bin = join(workspace, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  return bin;
}

async function findHostExecutable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Host locations differ between macOS and Linux; no shell lookup is needed.
    }
  }
  return null;
}

/** Execute the original entry point with a fresh CWD and a supplied environment, never a real dev stack. */
function runStartup(workspace: string, environment: NodeJS.ProcessEnv): Promise<StartupResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--conditions=development', '--import', tsxLoader, startupScript],
      {
        cwd: workspace,
        env: environment,
        encoding: 'utf8',
        timeout: 8_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : error.code;
        if (typeof exitCode !== 'number' || error?.killed || error?.signal) {
          reject(
            new Error('The isolated startup fixture did not exit normally within its deadline.'),
          );
          return;
        }
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

function expectStartupFailure(
  result: StartupResult,
  expected: { stage: 'previous-process-cleanup' | 'desktop-environment'; reason: string },
): void {
  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(syntheticSecret);
  const lines = result.stderr.trim().split(/\r?\n/);
  expect(lines).toHaveLength(2);
  const diagnostic: unknown = JSON.parse(lines[0] ?? '');
  const parsed = startupFailureSchema.parse(diagnostic);
  expect(parsed).toEqual({
    event: 'development.startup.failed',
    ...expected,
    ...(expected.reason === 'Development process metadata is unavailable.'
      ? {
          processMetadata: {
            source: process.platform === 'darwin' ? 'executables' : 'processes',
            recordNumber: 1,
            recordLength: 'malformed process metadata'.length,
            pid: null,
            hasStartTime: false,
          },
        }
      : {}),
  });
  expect(lines[1]).toBe(genericFailure);
}
