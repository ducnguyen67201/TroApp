import { execFile } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Configuration } from 'electron-builder';
import { z } from 'zod';
import { readWindowsSigningEnv, type WindowsSigningEnv } from './Env.js';

const executeFile = promisify(execFile);

/** Only the packaging process receives signing options; never serialize these into the app. */
export function createWindowsSigningConfig(settings: WindowsSigningEnv): Configuration {
  if (!settings.enabled) {
    return {};
  }
  return {
    forceCodeSigning: true,
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      artifactName: 'Tro-${version}-windows-${arch}-setup.${ext}',
      azureSignOptions: {
        endpoint: settings.endpoint,
        codeSigningAccountName: settings.account,
        certificateProfileName: settings.profile,
        publisherName: settings.publisher,
        fileDigest: 'SHA256',
        timestampDigest: 'SHA256',
        timestampRfc3161: 'http://timestamp.acs.microsoft.com',
      },
    },
  };
}

/** Enumerate only unsigned PE resources; existing valid vendor signatures are retained. */
async function readUnsignedWindowsResources(appDirectory: string): Promise<readonly string[]> {
  const result = await executeFile('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    fileURLToPath(new URL('./VerifyWindowsRelease.ps1', import.meta.url)),
    '-Mode',
    'UnsignedResources',
    '-Directory',
    appDirectory,
  ]);
  const raw: unknown = JSON.parse(result.stdout);
  return z.array(z.string().min(1)).parse(raw);
}

/** Verify each builder signing result, including the temporary NSIS uninstaller before deletion. */
export async function signAndVerifyWindowsFile(
  path: string,
  signFile: (path: string) => Promise<boolean>,
  verifyFile: (path: string) => Promise<void> = verifySignedWindowsFile,
): Promise<boolean> {
  if (!(await signFile(path))) {
    throw new Error('Windows file signing did not complete.');
  }
  await verifyFile(path);
  return true;
}

async function verifySignedWindowsFile(path: string): Promise<void> {
  await executeFile('pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    fileURLToPath(new URL('./VerifyWindowsRelease.ps1', import.meta.url)),
    '-Mode',
    'SignedFile',
    '-Directory',
    path,
  ]);
}

/** Complete extra-resource signing before NSIS compression and update metadata hashing. */
export async function signWindowsResources(
  appDirectory: string,
  signFile: (path: string) => Promise<boolean>,
  readUnsignedFiles: (
    directory: string,
  ) => Promise<readonly string[]> = readUnsignedWindowsResources,
): Promise<void> {
  const paths = await readUnsignedFiles(appDirectory);
  for (const path of paths) {
    const absolutePath = resolve(appDirectory, path);
    const relativePath = relative(resolve(appDirectory), absolutePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('Windows resource inventory escaped the package directory.');
    }
    if (!(await signFile(absolutePath))) {
      throw new Error('Windows resource signing did not complete.');
    }
  }
}

if (process.argv.includes('--check-windows-release')) {
  if (!readWindowsSigningEnv(process.env, process.platform, process.arch).enabled) {
    throw new Error('Windows release signing must be enabled.');
  }
  console.info('Windows release configuration passed.');
}
