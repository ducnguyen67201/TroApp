import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Configuration } from 'electron-builder';
import { z } from 'zod';
import { MacNotarizationMethod, readMacSigningEnv, type MacSigningEnv } from './Env.js';

export type MacReleaseSettings = Extract<MacSigningEnv, { enabled: true }>;

export type MacCommand = (
  executable: string,
  arguments_: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const executeFile = promisify(execFile);

const MacCommandFailureReason = {
  UNKNOWN: 'unknown',
  EXECUTABLE_NOT_FOUND: 'executable-not-found',
  TERMINATED: 'terminated',
  TICKET_NOT_FOUND: 'ticket-not-found',
  TICKET_VALIDATION_FAILED: 'ticket-validation-failed',
  TICKET_NOT_STAPLED: 'ticket-not-stapled',
  NETWORK_ERROR: 'network-error',
} as const;

const CommandFailureSchema = z.object({
  code: z.unknown().optional(),
  signal: z.unknown().optional(),
  killed: z.unknown().optional(),
  stdout: z.unknown().optional(),
  stderr: z.unknown().optional(),
});

function readMacCommandOperation(tool: string, arguments_: readonly string[]): string {
  if (tool === 'xcrun') {
    const [command, action] = arguments_;
    if (!command || !action) {
      return 'other';
    }
    const operation = `${command}.${action}`;
    if (
      [
        'stapler.validate',
        'stapler.staple',
        'notarytool.submit',
        'notarytool.info',
        'notarytool.log',
      ].includes(operation)
    ) {
      return operation;
    }
  }
  const flags = {
    codesign: [
      ['--verify', 'verify'],
      ['--display', 'display'],
      ['-d', 'display'],
      ['--sign', 'sign'],
    ],
    security: [['find-identity', 'find-identity']],
    plutil: [['-extract', 'extract']],
    lipo: [['-archs', 'archs']],
    spctl: [['--assess', 'assess']],
  } satisfies Record<string, readonly (readonly [string, string])[]>;
  for (const [name, operations] of Object.entries(flags)) {
    if (tool === name) {
      for (const [flag, operation] of operations) {
        if (arguments_.includes(flag)) {
          return `${name}.${operation}`;
        }
      }
    }
  }
  return 'other';
}

/** Classify only known phrases; never return tool output, paths, URLs or command arguments. */
function readMacCommandFailureReason(
  operation: string,
  failure: z.infer<typeof CommandFailureSchema> | undefined,
): (typeof MacCommandFailureReason)[keyof typeof MacCommandFailureReason] {
  if (failure?.code === 'ENOENT') {
    return MacCommandFailureReason.EXECUTABLE_NOT_FOUND;
  }
  if (failure?.killed === true) {
    return MacCommandFailureReason.TERMINATED;
  }
  if (operation === 'stapler.validate' || operation === 'stapler.staple') {
    const output = [failure?.stdout, failure?.stderr]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.slice(0, 16_384))
      .join('\n');
    for (const [phrase, reason] of [
      ['Record not found', MacCommandFailureReason.TICKET_NOT_FOUND],
      ['does not have a ticket stapled', MacCommandFailureReason.TICKET_NOT_STAPLED],
      ['NSURLErrorDomain', MacCommandFailureReason.NETWORK_ERROR],
      ['Could not validate ticket', MacCommandFailureReason.TICKET_VALIDATION_FAILED],
    ] as const) {
      if (output.includes(phrase)) {
        return reason;
      }
    }
  }
  return MacCommandFailureReason.UNKNOWN;
}

/** Error 68 also covers missing tickets; require the network marker and no rejection. */
function canRetryMacTicketValidation(
  executable: string,
  arguments_: readonly string[],
  error: unknown,
): boolean {
  if (readMacCommandOperation(basename(executable), arguments_) !== 'stapler.validate') {
    return false;
  }
  const parsedFailure = CommandFailureSchema.safeParse(error);
  if (!parsedFailure.success) {
    return false;
  }
  const failure = parsedFailure.data;
  return (
    failure.code === 68 &&
    failure.killed !== true &&
    (failure.signal === undefined || failure.signal === null) &&
    readMacCommandFailureReason('stapler.validate', failure) ===
      MacCommandFailureReason.NETWORK_ERROR
  );
}

/** Discard the raw cause deliberately: Node's command error can contain credentials. */
function reportMacCommandFailure(
  executable: string,
  arguments_: readonly string[],
  error: unknown,
  durationMs: number,
): Error {
  const toolName = basename(executable);
  const tool = [
    'xcrun',
    'codesign',
    'security',
    'spctl',
    'plutil',
    'lipo',
    'otool',
    'ditto',
    'hdiutil',
    'node',
  ].includes(toolName)
    ? toolName
    : 'other';
  const operation = readMacCommandOperation(tool, arguments_);
  const parsedFailure = CommandFailureSchema.safeParse(error);
  const failure = parsedFailure.success ? parsedFailure.data : undefined;
  const exitCode =
    typeof failure?.code === 'number' && Number.isSafeInteger(failure.code) ? failure.code : null;
  const signal =
    typeof failure?.signal === 'string' &&
    ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGPIPE'].includes(failure.signal)
      ? failure.signal
      : null;
  console.error(
    JSON.stringify({
      event: 'mac.release.command.failed',
      tool,
      operation,
      exitCode,
      signal,
      durationMs,
      reason: readMacCommandFailureReason(operation, failure),
    }),
  );
  return new Error(`macOS release command failed: ${tool}.`);
}

/** Retry only ticket-validation network failures; every release still requires exit zero. */
export const runMacCommand: MacCommand = async (executable, arguments_) => {
  const retryDelaysMs = [5_000, 10_000] as const;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = performance.now();
    try {
      return await executeFile(executable, [...arguments_], {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const delayMs = retryDelaysMs[attempt - 1];
      if (delayMs !== undefined && canRetryMacTicketValidation(executable, arguments_, error)) {
        console.warn(
          JSON.stringify({
            event: 'mac.release.command.retry',
            tool: 'xcrun',
            operation: 'stapler.validate',
            exitCode: 68,
            reason: MacCommandFailureReason.NETWORK_ERROR,
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts: retryDelaysMs.length + 1,
            delayMs,
          }),
        );
        await setTimeout(delayMs);
        continue;
      }
      throw reportMacCommandFailure(
        executable,
        arguments_,
        error,
        Math.round(performance.now() - startedAt),
      );
    }
  }
};

/** v26 options stay in memory; the builder owns the outer bundle and app notarization. */
export function createMacSigningConfig(
  settings: MacSigningEnv,
  absoluteEntitlementsPath: string,
): Configuration {
  if (!settings.enabled) {
    return {};
  }
  if (!isAbsolute(absoluteEntitlementsPath)) {
    throw new Error('macOS signing requires an absolute staged entitlements path.');
  }
  return {
    forceCodeSigning: true,
    mac: {
      type: 'distribution',
      identity: settings.identity,
      hardenedRuntime: true,
      notarize: true,
      strictVerify: true,
      target: [
        { target: 'dmg', arch: [settings.architecture] },
        { target: 'zip', arch: [settings.architecture] },
      ],
      artifactName: 'Tro-${version}-macos-${arch}.${ext}',
      entitlements: absoluteEntitlementsPath,
      entitlementsInherit: absoluteEntitlementsPath,
    },
    dmg: { sign: true },
  };
}

/** Verify that the selected identity has a usable private key on the intended team. */
export async function checkMacReleaseSettings(
  settings: MacReleaseSettings,
  run: MacCommand = runMacCommand,
): Promise<void> {
  if (settings.notarizationMethod === MacNotarizationMethod.API_KEY) {
    await access(settings.apiKey);
  }
  await access(settings.keychain);
  const identities = await run('/usr/bin/security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
    settings.keychain,
  ]);
  const identity = identities.stdout.split('\n').find((line) => line.includes(settings.identity));
  if (
    !identity?.includes('Developer ID Application:') ||
    !identity.includes(`(${settings.teamId})`)
  ) {
    throw new Error('Expected Developer ID Application private key is unavailable.');
  }
  console.info('macOS release configuration passed.');
}

/** Test binary magic instead of suffixes: native resources include extensionless helpers. */
export function isMachO(header: Uint8Array): boolean {
  if (header.length < 4) {
    return false;
  }
  const magic = Buffer.from(header.subarray(0, 4)).toString('hex');
  return [
    'feedface',
    'cefaedfe',
    'feedfacf',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
  ].includes(magic);
}

/** Resolve every symlink within the package; never sign a file outside the owned app. */
export async function readMacNativeFiles(directory: string): Promise<readonly string[]> {
  const root = await realpath(directory);
  const visited = new Set<string>();
  const files: string[] = [];

  async function visit(path: string): Promise<void> {
    const actual = await realpath(path);
    const child = relative(root, actual);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error('macOS resource escaped the package directory.');
    }
    if (visited.has(actual)) {
      return;
    }
    visited.add(actual);
    const info = await stat(actual);
    if (info.isDirectory()) {
      for (const entry of await readdir(actual)) {
        await visit(join(actual, entry));
      }
    } else if (info.isFile()) {
      const file = await open(actual, 'r');
      try {
        const header = Buffer.alloc(4);
        const { bytesRead } = await file.read(header, 0, 4, 0);
        if (isMachO(header.subarray(0, bytesRead))) {
          files.push(actual);
        }
      } finally {
        await file.close();
      }
    }
  }

  await visit(root);
  return files.sort(
    (left, right) => right.split(sep).length - left.split(sep).length || left.localeCompare(right),
  );
}

/** Verify every signature, including each architecture, before trusting its metadata. */
export async function verifyMacSignature(
  path: string,
  teamId: string,
  run: MacCommand = runMacCommand,
): Promise<void> {
  await run('/usr/bin/codesign', ['--verify', '--strict', '--all-architectures', path]);
  const signature = await run('/usr/bin/codesign', ['--display', '--verbose=4', path]);
  const details = signature.stderr;
  if (
    !details
      .split('\n')
      .some(
        (line) =>
          line.startsWith('Authority=Developer ID Application:') && line.endsWith(`(${teamId})`),
      ) ||
    !details.split('\n').includes(`TeamIdentifier=${teamId}`) ||
    !/^Timestamp=.+$/m.test(details) ||
    !/\bflags=.*\bruntime\b/m.test(details) ||
    details.includes('Signature=adhoc')
  ) {
    throw new Error('macOS signature identity, timestamp or hardened runtime is invalid.');
  }
}

/** Sign extra resources before electron-builder seals the bundle. */
export async function signMacResources(
  appPath: string,
  settings: MacReleaseSettings,
  run: MacCommand = runMacCommand,
): Promise<void> {
  const resources = join(appPath, 'Contents', 'Resources');
  await readMacNativeFiles(resources);
  const prebuilds = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    'uiohook-napi',
    'prebuilds',
  );
  // Installed Mac packages need only the matching hook; remove unused cross-platform binaries.
  const expectedPrebuild = `darwin-${settings.architecture}`;
  await access(join(prebuilds, expectedPrebuild, 'uiohook-napi.node'));
  for (const name of await readdir(prebuilds)) {
    if (name !== expectedPrebuild) {
      await rm(join(prebuilds, name), { recursive: true, force: true });
    }
  }
  for (const path of await readMacNativeFiles(resources)) {
    await verifyMacArchitecture(path, settings.architecture, run);
    await run('/usr/bin/codesign', [
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      '--sign',
      settings.identity,
      '--keychain',
      settings.keychain,
      path,
    ]);
    await verifyMacSignature(path, settings.teamId, run);
  }
}

/** No emulation or wrong-architecture executable can pass the native release gate. */
export async function verifyMacArchitecture(
  path: string,
  architecture: 'arm64' | 'x64',
  run: MacCommand = runMacCommand,
): Promise<readonly string[]> {
  const result = await run('/usr/bin/lipo', ['-archs', path]);
  const architectures = result.stdout.trim().split(/\s+/);
  if (!architectures.includes(architecture === 'x64' ? 'x86_64' : 'arm64')) {
    throw new Error('macOS native resource does not support the release architecture.');
  }
  return architectures;
}

/** Read-only gate after builder notarization and again against extracted distribution files. */
export async function verifyMacApp(
  appPath: string,
  settings: MacReleaseSettings,
  run: MacCommand = runMacCommand,
): Promise<void> {
  await verifyMacSignature(appPath, settings.teamId, run);
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--all-architectures',
    appPath,
  ]);
  await run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  const identifier = await run('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    join(appPath, 'Contents', 'Info.plist'),
  ]);
  if (identifier.stdout.trim() !== 'app.tro.desktop') {
    throw new Error('macOS bundle identity is invalid.');
  }
  await access(join(appPath, 'Contents', 'Resources', 'cua-driver', 'cua-driver'));
  const entitlements = await run('/usr/bin/codesign', [
    '-d',
    '--entitlements',
    '-',
    '--xml',
    appPath,
  ]);
  const enabledEntitlements = [
    ...entitlements.stdout.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g),
  ].map((match) => match[1]);
  for (const entitlement of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.device.audio-input',
  ]) {
    if (!enabledEntitlements.includes(entitlement)) {
      throw new Error('macOS release entitlement is missing.');
    }
  }
  if (
    ['get-task-allow', 'disable-library-validation', 'allow-unsigned-executable-memory'].some(
      (name) => entitlements.stdout.includes(name),
    )
  ) {
    throw new Error('macOS release contains an unapproved entitlement.');
  }
  const paths = await readMacNativeFiles(appPath);
  if (paths.length === 0) {
    throw new Error('macOS release contains no native executables.');
  }
  for (const path of paths) {
    await verifyMacArchitecture(path, settings.architecture, run);
    await verifyMacSignature(path, settings.teamId, run);
  }
}

/** Inventory contains final bytes, not the ad-hoc input hash in CompanionBuild.json. */
export async function readMacFileDigest(path: string): Promise<{ size: number; sha256: string }> {
  const bytes = await readFile(path);
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

if (process.argv.includes('--check-macos-release')) {
  const settings = readMacSigningEnv(process.env, process.platform, process.arch);
  if (!settings.enabled) {
    throw new Error('macOS release signing must be enabled.');
  }
  await checkMacReleaseSettings(settings);
}
