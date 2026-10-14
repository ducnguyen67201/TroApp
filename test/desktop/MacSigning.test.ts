import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMacSigningEnv } from '../../scripts/Env.js';
import {
  checkMacReleaseSettings,
  createMacSigningConfig,
  isMachO,
  readMacNativeFiles,
  readMacFileDigest,
  runMacCommand,
  signMacResources,
  verifyMacApp,
  verifyMacArchitecture,
  verifyMacSignature,
  type MacCommand,
} from '../../scripts/MacSigning.js';
import {
  createMacFixture,
  macCommand,
  macProfileSettings,
  macSettings,
  macSignature,
} from '../scripts/MacReleaseFixtures.js';

const environment = {
  TRO_SIGN_MACOS: 'true',
  MACOS_SIGNING_IDENTITY_SHA1: macSettings.identity,
  APPLE_TEAM_ID: macSettings.teamId,
  CSC_KEYCHAIN: macSettings.keychain,
  APPLE_API_KEY: macSettings.apiKey,
  APPLE_API_KEY_ID: macSettings.apiKeyId,
  APPLE_API_ISSUER: macSettings.apiIssuer,
  MAIN_VITE_API_BASE_URL: 'https://api.example.test',
  MAIN_VITE_APP_ENV: 'prod',
} satisfies NodeJS.ProcessEnv;
const profileEnvironment = {
  ...environment,
  APPLE_API_KEY: undefined,
  APPLE_API_KEY_ID: undefined,
  APPLE_API_ISSUER: undefined,
  APPLE_KEYCHAIN: macProfileSettings.keychain,
  APPLE_KEYCHAIN_PROFILE: macProfileSettings.keychainProfile,
} satisfies NodeJS.ProcessEnv;
const entitlementsPath = '/temporary/staged-app/DesktopEntitlements.plist';
const temporary: string[] = [];

async function createTemporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tro-mac-test-'));
  temporary.push(directory);
  return realpath(directory);
}

/** Use the dependency's shipped names without loading or executing its native addon. */
async function copyShortcutPrebuildsToApp(app: string): Promise<string> {
  const packageDirectory = dirname(
    createRequire(import.meta.url).resolve('uiohook-napi/package.json'),
  );
  const prebuilds = join(
    app,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'uiohook-napi',
    'prebuilds',
  );
  await cp(join(packageDirectory, 'prebuilds'), prebuilds, { recursive: true });
  return prebuilds;
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Mac release configuration', () => {
  it('keeps local builds credential-free and selects pinned builder options', () => {
    expect(readMacSigningEnv({}, 'linux', 'x64')).toEqual({ enabled: false });
    expect(readMacSigningEnv({ TRO_SIGN_MACOS: 'false' }, 'darwin', 'arm64')).toEqual({
      enabled: false,
    });
    expect(createMacSigningConfig({ enabled: false }, entitlementsPath)).toEqual({});
    const settings = readMacSigningEnv(environment, 'darwin', 'arm64');
    expect(settings).toEqual(macSettings);
    const config = createMacSigningConfig(settings, entitlementsPath);
    expect(config).toMatchObject({
      forceCodeSigning: true,
      mac: {
        type: 'distribution',
        identity: macSettings.identity,
        hardenedRuntime: true,
        notarize: true,
        strictVerify: true,
        entitlements: entitlementsPath,
        entitlementsInherit: entitlementsPath,
      },
      dmg: { sign: true },
    });
    expect(config.mac?.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ]);
    expect(config).not.toHaveProperty('publish');
    expect(JSON.stringify(config)).not.toContain(macSettings.apiKey);
    expect(
      createMacSigningConfig(readMacSigningEnv(environment, 'darwin', 'x64'), entitlementsPath).mac
        ?.target,
    ).toContainEqual({ target: 'dmg', arch: ['x64'] });
  });

  it('requires an absolute staged entitlement path before passing options to codesign', () => {
    expect(() => createMacSigningConfig(macSettings, 'DesktopEntitlements.plist')).toThrow(
      'absolute staged entitlements path',
    );
  });

  it('accepts notarization credentials saved in the isolated signing keychain', () => {
    const settings = readMacSigningEnv(profileEnvironment, 'darwin', 'arm64');
    expect(settings).toEqual(macProfileSettings);
    expect(settings).not.toHaveProperty('apiKey');
    expect(settings).not.toHaveProperty('password');
    expect(JSON.stringify(createMacSigningConfig(settings, entitlementsPath))).not.toContain(
      macProfileSettings.keychainProfile,
    );
  });

  it.each([
    { APPLE_KEYCHAIN: '' },
    { APPLE_KEYCHAIN: 'relative' },
    { APPLE_KEYCHAIN: '/temporary/different.keychain-db' },
    { APPLE_KEYCHAIN_PROFILE: '' },
    { APPLE_KEYCHAIN_PROFILE: '  ' },
    { APPLE_API_KEY: macSettings.apiKey },
    { APPLE_API_KEY_ID: macSettings.apiKeyId },
    { APPLE_API_ISSUER: macSettings.apiIssuer },
    { APPLE_ID: 'private@example.test' },
    { APPLE_APP_SPECIFIC_PASSWORD: 'private-password' },
    { APPLE_ID: ' ' },
    { APPLE_APP_SPECIFIC_PASSWORD: ' ' },
  ])('rejects incomplete or mixed keychain credentials: %j', (overrides) => {
    expect(() =>
      readMacSigningEnv({ ...profileEnvironment, ...overrides }, 'darwin', 'arm64'),
    ).toThrow(/^macOS release configuration is invalid\.$/);
  });

  it('rejects a keychain selector mixed into API authentication', () => {
    expect(() =>
      readMacSigningEnv(
        { ...environment, APPLE_KEYCHAIN: macSettings.keychain },
        'darwin',
        'arm64',
      ),
    ).toThrow(/^macOS release configuration is invalid\.$/);
  });

  it.each(Object.keys(environment).filter((name) => name !== 'TRO_SIGN_MACOS'))(
    'rejects missing required release setting %s',
    (name) => {
      expect(() => readMacSigningEnv({ ...environment, [name]: '' }, 'darwin', 'arm64')).toThrow(
        /^macOS release configuration is invalid\.$/,
      );
    },
  );

  it.each([
    { TRO_SIGN_MACOS: 'yes' },
    { TRO_SIGN_WINDOWS: 'true' },
    { MAIN_VITE_APP_ENV: 'dev' },
    { MAIN_VITE_API_BASE_URL: 'https://localhost/' },
    { MAIN_VITE_API_BASE_URL: 'http://example.test' },
    { MAIN_VITE_API_BASE_URL: 'https://user:secret@example.test' },
    { CSC_KEYCHAIN: 'relative' },
    { APPLE_API_KEY: '' },
    { MACOS_SIGNING_IDENTITY_SHA1: '-' },
    { APPLE_API_ISSUER: 'secret' },
    { APPLE_ID: 'secret@example.test' },
    { APPLE_KEYCHAIN_PROFILE: 'other' },
    { CSC_LINK: 'secret' },
    { MAIN_VITE_UPDATE_FEED_URL: 'https://example.test/feed/' },
  ])('fails closed without leaking configuration: %j', (overrides) => {
    expect(() => readMacSigningEnv({ ...environment, ...overrides }, 'darwin', 'arm64')).toThrow(
      /^macOS release configuration is invalid\.$/,
    );
  });

  it.each([
    ['linux', 'arm64'],
    ['darwin', 'ia32'],
    ['win32', 'x64'],
  ] as const)('rejects %s/%s', (platform, architecture) => {
    expect(() => readMacSigningEnv(environment, platform, architecture)).toThrow();
  });

  it('requires a usable Developer ID private key from the expected team', async () => {
    const directory = await createTemporary();
    const settings = {
      ...macSettings,
      apiKey: join(directory, 'key'),
      keychain: join(directory, 'keychain'),
    };
    await writeFile(settings.apiKey, 'fixture');
    await writeFile(settings.keychain, 'fixture');
    const run = vi.fn<MacCommand>().mockResolvedValue({
      stdout: `1) ${settings.identity} "Developer ID Application: Example (${settings.teamId})"`,
      stderr: '',
    });
    await checkMacReleaseSettings(settings, run);
    run.mockResolvedValue({
      stdout: `${settings.identity} "Apple Development: Example (${settings.teamId})"`,
      stderr: '',
    });
    await expect(checkMacReleaseSettings(settings, run)).rejects.toThrow('private key');
  });

  it('checks the keychain for profile authentication without requiring an API file', async () => {
    const directory = await createTemporary();
    const settings = { ...macProfileSettings, keychain: join(directory, 'keychain') };
    await writeFile(settings.keychain, 'fixture');
    const run = vi.fn<MacCommand>().mockResolvedValue({
      stdout: `1) ${settings.identity} "Developer ID Application: Example (${settings.teamId})"`,
      stderr: '',
    });
    await checkMacReleaseSettings(settings, run);
    expect(run).toHaveBeenCalledWith('/usr/bin/security', [
      'find-identity',
      '-v',
      '-p',
      'codesigning',
      settings.keychain,
    ]);
    await rm(settings.keychain);
    await expect(checkMacReleaseSettings(settings, run)).rejects.toThrow();
  });
});

describe('Mac native signatures', () => {
  it.each([
    'feedface',
    'cefaedfe',
    'feedfacf',
    'cffaedfe',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
  ])('recognizes %s magic', (hex) => {
    expect(isMachO(Buffer.from(hex, 'hex'))).toBe(true);
  });

  it('rejects short, Windows and Linux files', () => {
    expect(isMachO(Buffer.alloc(0))).toBe(false);
    expect(isMachO(Buffer.from('4d5a0000', 'hex'))).toBe(false);
    expect(isMachO(Buffer.from('7f454c46', 'hex'))).toBe(false);
  });

  it('deduplicates internal symlinks and rejects external ones', async () => {
    const directory = await createTemporary();
    const app = join(directory, 'app');
    await mkdir(app);
    await writeFile(join(app, 'driver'), Buffer.from('cffaedfe', 'hex'));
    await writeFile(join(app, 'text'), 'not executable');
    await symlink('driver', join(app, 'alias'));
    expect(await readMacNativeFiles(app)).toEqual([join(app, 'driver')]);
    await writeFile(join(directory, 'outside'), Buffer.from('cffaedfe', 'hex'));
    await symlink('../outside', join(app, 'escape'));
    await expect(readMacNativeFiles(app)).rejects.toThrow('escaped');
  });

  it('verifies trust metadata, timestamp and runtime after cryptographic verification', async () => {
    await verifyMacSignature('/app', macSettings.teamId, macCommand);
    for (const details of [
      macSignature.replace('TESTTEAM12', 'WRONGTEAM1'),
      macSignature.replace('Timestamp=', 'Missing='),
      macSignature.replace('runtime', 'none'),
      macSignature + 'Signature=adhoc',
    ]) {
      await expect(
        verifyMacSignature('/app', macSettings.teamId, () =>
          Promise.resolve({ stdout: '', stderr: details }),
        ),
      ).rejects.toThrow('invalid');
    }
    await expect(
      verifyMacSignature('/app', macSettings.teamId, () =>
        Promise.reject(new Error('verification failed')),
      ),
    ).rejects.toThrow('verification failed');
  });

  it('requires matching CPU slices', async () => {
    expect(await verifyMacArchitecture('/app', 'x64', macCommand)).toContain('x86_64');
    await expect(
      verifyMacArchitecture('/app', 'arm64', () =>
        Promise.resolve({ stdout: 'x86_64', stderr: '' }),
      ),
    ).rejects.toThrow('architecture');
  });

  it.each(['arm64', 'x64'] as const)(
    'signs the shipped %s shortcut prebuild and removes irrelevant platforms',
    async (architecture) => {
      const directory = await createTemporary();
      const app = join(directory, 'Tro.app');
      await createMacFixture(app);
      const prebuilds = await copyShortcutPrebuildsToApp(app);
      const nativePath = join(prebuilds, `darwin-${architecture}`, 'uiohook-napi.node');
      const settings = { ...macSettings, architecture };
      const run = vi.fn<MacCommand>((executable, arguments_) =>
        executable.endsWith('/lipo')
          ? Promise.resolve({ stdout: architecture === 'x64' ? 'x86_64' : 'arm64', stderr: '' })
          : macCommand(executable, arguments_),
      );
      await signMacResources(app, settings, run);
      const signCalls = run.mock.calls.filter(([, args]) => args.includes('--sign'));
      expect(signCalls).toHaveLength(2);
      expect(
        signCalls.every(
          ([, args]) => args.includes(settings.identity) && args.includes('--timestamp'),
        ),
      ).toBe(true);
      expect(signCalls.some(([, args]) => args.at(-1) === nativePath)).toBe(true);
      expect(isMachO(await readFile(nativePath))).toBe(true);
      expect(await readdir(prebuilds)).toEqual([`darwin-${architecture}`]);
      await verifyMacApp(app, settings, run);
      expect(run.mock.calls.some(([, args]) => args.includes('stapler'))).toBe(true);
      expect(run.mock.calls.some(([, args]) => args.includes('--assess'))).toBe(true);
      const digest = await readMacFileDigest(
        join(app, 'Contents', 'Resources', 'cua-driver', 'cua-driver'),
      );
      expect(digest.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(digest.size).toBe(8);
    },
  );

  it('rejects a missing matching shortcut prebuild before signing or removing other platforms', async () => {
    const app = join(await createTemporary(), 'Tro.app');
    await createMacFixture(app);
    const prebuilds = await copyShortcutPrebuildsToApp(app);
    await rm(join(prebuilds, 'darwin-arm64'), { recursive: true });
    const remainingPlatforms = await readdir(prebuilds);
    const run = vi.fn<MacCommand>(macCommand);
    await expect(signMacResources(app, macSettings, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(prebuilds)).toEqual(remainingPlatforms);
  });

  it('blocks a missing staple and unapproved entitlement', async () => {
    const app = join(await createTemporary(), 'Tro.app');
    await createMacFixture(app);
    await expect(
      verifyMacApp(app, macSettings, (exe, args) => {
        if (args.includes('stapler')) {
          return Promise.reject(new Error('missing ticket'));
        }
        return macCommand(exe, args);
      }),
    ).rejects.toThrow('missing ticket');
    await expect(
      verifyMacApp(app, macSettings, async (exe, args) => {
        const result = await macCommand(exe, args);
        return args.includes('--entitlements')
          ? { ...result, stdout: result.stdout + 'get-task-allow' }
          : result;
      }),
    ).rejects.toThrow('unapproved');
  });

  it('bounds real command execution and strips raw command errors', async () => {
    expect(
      (await runMacCommand(process.execPath, ['-e', 'process.stdout.write("ok")'])).stdout,
    ).toBe('ok');
    await expect(
      runMacCommand(process.execPath, ['-e', 'throw new Error("secret-input")']),
    ).rejects.toThrow(/^macOS release command failed: node\.$/);
  });
});
