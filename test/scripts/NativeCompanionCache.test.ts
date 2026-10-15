import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CuaCompanionBuild } from '../../src/contracts/CuaCompanionBuild.js';
import { readNativeCompanionCacheEnv } from '../../scripts/Env.js';
import {
  checkNativeCompanionCache,
  createNativeCompanionCacheKey,
  nativeCompanionCacheInputs,
  recordNativeCompanionCache,
  type NativeCompanionCacheSettings,
} from '../../scripts/NativeCompanionCache.js';

const temporaryDirectories: string[] = [];
const settings = {
  platform: 'darwin',
  architecture: 'arm64',
  runnerImage: '20261015.1',
  runnerLabel: 'macos-15',
  rustToolchain: '1.95.0',
  deploymentTarget: '13.0',
} satisfies NativeCompanionCacheSettings;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createFixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'tro-native-cache-test-'));
  temporaryDirectories.push(temporary);
  const root = join(temporary, 'repository');
  const directory = join(temporary, 'companion');
  for (const path of nativeCompanionCacheInputs) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `synthetic input: ${path}`);
  }
  await mkdir(join(directory, 'libraries'), { recursive: true });
  const executable = Buffer.from('synthetic native executable');
  await writeFile(join(directory, 'cua-driver'), executable);
  await writeFile(join(directory, 'libraries', 'Runtime.dylib'), 'synthetic runtime');
  await writeFile(join(directory, 'DriverVersion.txt'), CuaCompanionBuild.VERSION);
  await writeFile(join(directory, 'DriverLayout.txt'), 'embedded-v1');
  await writeFile(join(directory, 'LICENSE'), 'synthetic license');
  const metadata = {
    version: CuaCompanionBuild.VERSION,
    sourceCommit: CuaCompanionBuild.SOURCE_COMMIT,
    patchSha256: digest(await readFile(join(root, 'driver-patches/CursorCompanion.patch'))),
    executableSha256: digest(executable),
    architecture: settings.architecture,
  };
  await writeFile(join(directory, 'CompanionBuild.json'), JSON.stringify(metadata));
  return { root, directory, metadata };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('tested native companion reuse', () => {
  it('reuses a recorded build across UI changes and release version bumps', async () => {
    const { root, directory } = await createFixture();
    await recordNativeCompanionCache(directory, root, settings);
    const key = await createNativeCompanionCacheKey(root, settings);
    await writeFile(join(root, 'package.json'), '{"version":"2.0.1"}');
    await mkdir(join(root, 'src/desktop'), { recursive: true });
    await writeFile(join(root, 'src/desktop/App.tsx'), 'new UI');
    expect(await createNativeCompanionCacheKey(root, settings)).toBe(key);
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('reused');
  });

  it.each(nativeCompanionCacheInputs)('rebuilds when owned input %s changes', async (input) => {
    const { root, directory } = await createFixture();
    await recordNativeCompanionCache(directory, root, settings);
    await writeFile(join(root, input), 'changed build input');
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('invalid');
  });

  it.each([
    { platform: 'win32' },
    { architecture: 'x64' },
    { runnerImage: '20261022.1' },
    { runnerLabel: 'macos-15-intel' },
    { rustToolchain: '1.97.1' },
    { deploymentTarget: '14.0' },
  ] satisfies Partial<NativeCompanionCacheSettings>[])(
    'rebuilds for a different native environment: %j',
    async (change) => {
      const { root, directory } = await createFixture();
      await recordNativeCompanionCache(directory, root, settings);
      expect(await checkNativeCompanionCache(directory, root, { ...settings, ...change })).toBe(
        'invalid',
      );
    },
  );

  it.each(['cua-driver', 'libraries/Runtime.dylib', 'DriverVersion.txt', 'CompanionBuild.json'])(
    'rejects changed cached contents: %s',
    async (path) => {
      const { root, directory } = await createFixture();
      await recordNativeCompanionCache(directory, root, settings);
      await writeFile(join(directory, path), 'corrupt cached content');
      expect(await checkNativeCompanionCache(directory, root, settings)).toBe('invalid');
    },
  );

  it('rebuilds when runtime files are missing or unexpected files appear', async () => {
    const { root, directory } = await createFixture();
    await recordNativeCompanionCache(directory, root, settings);
    await writeFile(join(directory, 'Unexpected.dll'), 'unexpected');
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('invalid');
    await rm(join(directory, 'Unexpected.dll'));
    await rm(join(directory, 'libraries/Runtime.dylib'));
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('invalid');
  });

  it('treats missing, legacy and malformed receipts as rebuilds', async () => {
    const { root, directory } = await createFixture();
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('invalid');
    await writeFile(join(directory, 'CompanionCache.json'), '{invalid');
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('invalid');
    await rm(directory, { recursive: true });
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('missing');
  });

  it('rejects symlinks without reading or modifying their target', async () => {
    const { root, directory } = await createFixture();
    await recordNativeCompanionCache(directory, root, settings);
    const outside = join(root, 'Private.txt');
    await writeFile(outside, 'private fixture');
    await rm(join(directory, 'CompanionCache.json'));
    await symlink(outside, join(directory, 'CompanionCache.json'));
    expect(await checkNativeCompanionCache(directory, root, settings)).toBe('invalid');
    await expect(recordNativeCompanionCache(directory, root, settings)).rejects.toThrow('links');
    expect(await readFile(outside, 'utf8')).toBe('private fixture');
  });

  it.each([
    { sourceCommit: '0'.repeat(40) },
    { architecture: 'x64' },
    { patchSha256: '0'.repeat(64) },
    { executableSha256: '0'.repeat(64) },
  ])('cannot record incompatible build provenance: %j', async (change) => {
    const { root, directory, metadata } = await createFixture();
    await writeFile(
      join(directory, 'CompanionBuild.json'),
      JSON.stringify({ ...metadata, ...change }),
    );
    await expect(recordNativeCompanionCache(directory, root, settings)).rejects.toThrow();
  });

  it('validates the Windows GUI subsystem before recording or reusing an executable', async () => {
    const { root, directory, metadata } = await createFixture();
    const windowsSettings = {
      ...settings,
      platform: 'win32',
      architecture: 'x64',
      deploymentTarget: '',
    } as const;
    const executable = Buffer.alloc(512);
    executable.write('MZ');
    executable.writeUInt32LE(128, 0x3c);
    executable.write('PE\0\0', 128);
    executable.writeUInt16LE(240, 148);
    executable.writeUInt16LE(0x20b, 152);
    executable.writeUInt16LE(2, 220);
    await rm(join(directory, 'cua-driver'));
    await writeFile(join(directory, 'cua-driver.exe'), executable);
    await writeFile(
      join(directory, 'CompanionBuild.json'),
      JSON.stringify({
        ...metadata,
        architecture: 'x64',
        executableSha256: digest(executable),
      }),
    );
    await recordNativeCompanionCache(directory, root, windowsSettings);
    expect(await checkNativeCompanionCache(directory, root, windowsSettings)).toBe('reused');
    executable.writeUInt16LE(3, 220);
    await writeFile(join(directory, 'cua-driver.exe'), executable);
    await writeFile(
      join(directory, 'CompanionBuild.json'),
      JSON.stringify({
        ...metadata,
        architecture: 'x64',
        executableSha256: digest(executable),
      }),
    );
    await expect(recordNativeCompanionCache(directory, root, windowsSettings)).rejects.toThrow(
      'GUI-subsystem',
    );
  });
});

describe('native release cache environment', () => {
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_OUTPUT: join(tmpdir(), 'NativeCacheOutput'),
    ImageVersion: settings.runnerImage,
    TRO_NATIVE_RUNNER_LABEL: settings.runnerLabel,
    RUSTUP_TOOLCHAIN: settings.rustToolchain,
    MACOSX_DEPLOYMENT_TARGET: settings.deploymentTarget,
    UNRELATED_SECRET: 'private fixture',
  };

  it('retains only the native environment and output path', () => {
    expect(readNativeCompanionCacheEnv(environment, 'darwin', 'arm64')).toEqual({
      outputPath: environment.GITHUB_OUTPUT,
      settings,
    });
  });

  it.each(['ImageVersion', 'RUSTUP_TOOLCHAIN', 'TRO_NATIVE_RUNNER_LABEL', 'GITHUB_OUTPUT'])(
    'requires %s instead of silently sharing a broader cache',
    (name) => {
      expect(() =>
        readNativeCompanionCacheEnv({ ...environment, [name]: undefined }, 'darwin', 'arm64'),
      ).toThrow('main-branch hosted release environment');
    },
  );

  it('rejects a non-main release context', () => {
    expect(() =>
      readNativeCompanionCacheEnv(
        { ...environment, GITHUB_REF: 'refs/pull/1/merge' },
        'darwin',
        'arm64',
      ),
    ).toThrow('main-branch hosted release environment');
  });
});
