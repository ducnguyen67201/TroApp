import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readWindowsSigningEnv } from '../../scripts/Env.js';
import {
  createWindowsSigningConfig,
  signAndVerifyWindowsFile,
  signWindowsResources,
} from '../../scripts/WindowsSigning.js';

const environment = {
  TRO_SIGN_WINDOWS: 'true',
  AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/',
  AZURE_SIGNING_ACCOUNT: 'tro-account',
  AZURE_CERTIFICATE_PROFILE: 'tro-release',
  AZURE_SIGNING_PUBLISHER: 'Test Publisher',
  MAIN_VITE_API_BASE_URL: 'https://api.example.test',
  MAIN_VITE_APP_ENV: 'prod',
} satisfies NodeJS.ProcessEnv;

describe('Windows release configuration', () => {
  it('leaves local builds independent of Azure', () => {
    expect(readWindowsSigningEnv({}, 'darwin', 'arm64')).toEqual({ enabled: false });
    expect(createWindowsSigningConfig({ enabled: false })).toEqual({});
    expect(readWindowsSigningEnv({ TRO_SIGN_WINDOWS: 'false' }, 'win32', 'x64')).toEqual({
      enabled: false,
    });
  });

  it('selects the v26 Azure signer and requires a signed x64 NSIS build', () => {
    const settings = readWindowsSigningEnv(environment, 'win32', 'x64');
    expect(createWindowsSigningConfig(settings)).toMatchObject({
      forceCodeSigning: true,
      win: {
        target: [{ target: 'nsis', arch: ['x64'] }],
        azureSignOptions: {
          codeSigningAccountName: 'tro-account',
          certificateProfileName: 'tro-release',
          publisherName: 'Test Publisher',
          fileDigest: 'SHA256',
          timestampDigest: 'SHA256',
        },
      },
    });
    expect(createWindowsSigningConfig(settings).win).not.toHaveProperty('signtoolOptions');
    expect(createWindowsSigningConfig(settings)).not.toHaveProperty('publish');
  });

  it.each(Object.keys(environment).filter((key) => key !== 'TRO_SIGN_WINDOWS'))(
    'rejects a missing required setting: %s',
    (key) => {
      expect(() => readWindowsSigningEnv({ ...environment, [key]: '' }, 'win32', 'x64')).toThrow(
        'Windows release configuration is invalid.',
      );
    },
  );

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
  ] as const)('rejects an unsupported platform %s/%s', (platform, architecture) => {
    expect(() => readWindowsSigningEnv(environment, platform, architecture)).toThrow();
  });

  it.each([
    { TRO_SIGN_WINDOWS: 'yes' },
    { MAIN_VITE_APP_ENV: 'dev' },
    { MAIN_VITE_API_BASE_URL: 'https://localhost/' },
    { MAIN_VITE_API_BASE_URL: 'http://api.example.test' },
    { MAIN_VITE_API_BASE_URL: 'https://user:password@api.example.test' },
    { MAIN_VITE_API_BASE_URL: 'https://api.example.test/?secret=value' },
    { AZURE_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net/#secret' },
    { AZURE_SIGNING_ACCOUNT: 'bad account' },
    { AZURE_SIGNING_PUBLISHER: '   ' },
    { MAIN_VITE_UPDATE_FEED_URL: 'http://downloads.example.test/' },
  ])('rejects unsafe or partial inputs without leaking values', (overrides) => {
    expect(() => readWindowsSigningEnv({ ...environment, ...overrides }, 'win32', 'x64')).toThrow(
      /^Windows release configuration is invalid\.$/,
    );
  });

  it('accepts an optional public update feed', () => {
    expect(
      readWindowsSigningEnv(
        { ...environment, MAIN_VITE_UPDATE_FEED_URL: 'https://downloads.example.test/' },
        'win32',
        'x64',
      ).enabled,
    ).toBe(true);
  });
});

describe('extra-resource signing', () => {
  it('verifies each newly signed output before returning it to the builder', async () => {
    const operations: string[] = [];
    await expect(
      signAndVerifyWindowsFile(
        'uninstaller.exe',
        (path) => {
          operations.push(`sign:${path}`);
          return Promise.resolve(true);
        },
        (path) => {
          operations.push(`verify:${path}`);
          return Promise.resolve();
        },
      ),
    ).resolves.toBe(true);
    expect(operations).toEqual(['sign:uninstaller.exe', 'verify:uninstaller.exe']);
  });

  it('rejects unsuccessful signing and signature verification', async () => {
    const verifyFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue();
    await expect(
      signAndVerifyWindowsFile('uninstaller.exe', () => Promise.resolve(false), verifyFile),
    ).rejects.toThrow('did not complete');
    expect(verifyFile).not.toHaveBeenCalled();
    await expect(
      signAndVerifyWindowsFile(
        'uninstaller.exe',
        () => Promise.resolve(true),
        () => Promise.reject(new Error('Invalid signature')),
      ),
    ).rejects.toThrow('Invalid signature');
  });

  it('signs only inventoried unsigned files in order', async () => {
    const signFile = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
    const inventory = vi
      .fn<(directory: string) => Promise<readonly string[]>>()
      .mockResolvedValue([
        'resources/cua-driver/cua-driver.exe',
        'resources/app.asar.unpacked/node_modules/hook.node',
      ]);
    await signWindowsResources('package', signFile, inventory);
    expect(inventory).toHaveBeenCalledWith('package');
    expect(signFile.mock.calls).toEqual([
      [resolve('package/resources/cua-driver/cua-driver.exe')],
      [resolve('package/resources/app.asar.unpacked/node_modules/hook.node')],
    ]);
  });

  it('does not sign an empty inventory or allow paths outside the app', async () => {
    const signFile = vi.fn<(path: string) => Promise<boolean>>().mockResolvedValue(true);
    await signWindowsResources('package', signFile, () => Promise.resolve([]));
    expect(signFile).not.toHaveBeenCalled();
    await expect(
      signWindowsResources('package', signFile, () => Promise.resolve(['../escaped.exe'])),
    ).rejects.toThrow('escaped the package directory');
  });

  it('fails closed if signing or inventory fails', async () => {
    await expect(
      signWindowsResources(
        'package',
        () => Promise.resolve(false),
        () => Promise.resolve(['a.exe']),
      ),
    ).rejects.toThrow('did not complete');
    await expect(
      signWindowsResources(
        'package',
        () => Promise.reject(new Error('signer failed')),
        () => Promise.resolve(['a.exe']),
      ),
    ).rejects.toThrow('signer failed');
    await expect(
      signWindowsResources(
        'package',
        () => Promise.resolve(true),
        () => Promise.reject(new Error('inventory failed')),
      ),
    ).rejects.toThrow('inventory failed');
  });
});
