import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);
const HeaderArchitecture = { ARM64: 'arm64', X64: 'x64' } as const;
const HeaderSettingsSchema = z.strictObject({
  electronVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  architecture: z.enum(HeaderArchitecture),
});
const TransientDownloadCode = {
  CONNECT_TIMEOUT: 'UND_ERR_CONNECT_TIMEOUT',
  HEADERS_TIMEOUT: 'UND_ERR_HEADERS_TIMEOUT',
  BODY_TIMEOUT: 'UND_ERR_BODY_TIMEOUT',
  CONNECTION_RESET: 'ECONNRESET',
  TIMEOUT: 'ETIMEDOUT',
  DNS_RETRY: 'EAI_AGAIN',
} as const;
const maximumAttempts = 3;

export interface ElectronHeaderPorts {
  installHeaders: (arguments_: string[]) => Promise<void>;
  wait: (delayMs: number) => Promise<void>;
  log: (event: Readonly<Record<string, string | number>>) => void;
}

const defaultPorts: ElectronHeaderPorts = {
  installHeaders: async (arguments_) => {
    await executeFile(
      process.execPath,
      [require.resolve('node-gyp/bin/node-gyp.js'), ...arguments_],
      {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );
  },
  wait: async (delayMs) => {
    await setTimeout(delayMs);
  },
  log: (event) => {
    console.log(JSON.stringify(event));
  },
};

function readTransientDownloadCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return undefined;
  }
  if (typeof error.stderr !== 'string') {
    return undefined;
  }
  const stderr = error.stderr;
  return Object.values(TransientDownloadCode).find((code) =>
    new RegExp(`\\b${code}\\b`).test(stderr),
  );
}

/** Warm the sequential Electron rebuild cache before signing credentials exist.
 * node-gyp owns archive checksum verification, incomplete-install rollback and
 * the version marker. Native compilation and distribution checks still run later.
 */
export async function prepareElectronHeaders(
  settings: { electronVersion: string; architecture: string },
  ports: ElectronHeaderPorts = defaultPorts,
): Promise<void> {
  const validated = HeaderSettingsSchema.parse(settings);
  const arguments_ = [
    'install',
    '--ensure',
    `--target=${validated.electronVersion}`,
    `--arch=${validated.architecture}`,
    '--dist-url=https://www.electronjs.org/headers',
    `--devdir=${join(homedir(), '.electron-gyp')}`,
  ];
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const context = { ...validated, attempt };
    ports.log({ event: 'desktop.headers.prepare.started', ...context });
    try {
      await ports.installHeaders(arguments_);
      ports.log({ event: 'desktop.headers.prepare.completed', ...context });
      return;
    } catch (error) {
      const failureCode = readTransientDownloadCode(error);
      if (failureCode === undefined || attempt === maximumAttempts) {
        ports.log({
          event: 'desktop.headers.prepare.failed',
          ...context,
          failureCode: failureCode ?? 'INSTALL_FAILED',
        });
        throw new Error('Electron header preparation failed; inspect desktop.headers events.', {
          cause: error,
        });
      }
      const delayMs = attempt * 1000;
      ports.log({ event: 'desktop.headers.prepare.retry', ...context, failureCode, delayMs });
      await ports.wait(delayMs);
    }
  }
}
