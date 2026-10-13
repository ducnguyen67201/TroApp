import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Configuration } from 'electron-builder';
import { readMacSigningEnv, type MacSigningEnv } from './Env.js';

export type MacReleaseSettings = Extract<MacSigningEnv, { enabled: true }>;

export type MacCommand = (
  executable: string,
  arguments_: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const executeFile = promisify(execFile);

/** Bound tool execution and discard errors that can contain credential-bearing arguments. */
export const runMacCommand: MacCommand = async (executable, arguments_) => {
  try {
    return await executeFile(executable, [...arguments_], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    console.error(
      JSON.stringify({ event: 'mac.release.command.failed', tool: basename(executable) }),
    );
    throw new Error(`macOS release command failed: ${basename(executable)}.`);
  }
};

/** v26 options stay in memory; the builder owns the outer bundle and app notarization. */
export function createMacSigningConfig(settings: MacSigningEnv): Configuration {
  if (!settings.enabled) {
    return {};
  }
  return {
    forceCodeSigning: true,
    mac: {
      identity: settings.identity,
      hardenedRuntime: true,
      notarize: true,
      strictVerify: true,
      target: [
        { target: 'dmg', arch: [settings.architecture] },
        { target: 'zip', arch: [settings.architecture] },
      ],
      artifactName: 'Tro-${version}-macos-${arch}.${ext}',
      entitlements: 'DesktopEntitlements.plist',
      entitlementsInherit: 'DesktopEntitlements.plist',
    },
  };
}

/** Verify that the selected identity has a usable private key on the intended team. */
export async function checkMacReleaseSettings(
  settings: MacReleaseSettings,
  run: MacCommand = runMacCommand,
): Promise<void> {
  await access(settings.apiKey);
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
  await access(join(prebuilds, expectedPrebuild, 'uiohook_napi.node'));
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
