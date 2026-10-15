import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { validateCuaCompanion } from './PrepareCuaCompanion.js';

/** Include build/test policy and validation code, not the desktop release version. */
export const nativeCompanionCacheInputs = [
  '.github/workflows/MacRelease.yml',
  '.github/workflows/WindowsRelease.yml',
  'driver-patches/CursorCompanion.patch',
  'src/contracts/CuaCompanionBuild.ts',
  'scripts/BuildCuaCompanion.ts',
  'scripts/PrepareCuaDriver.ts',
  'scripts/PrepareCuaCompanion.ts',
  'scripts/WindowsCompanionExecutable.ts',
  'scripts/InstallWindowsBuildTools.ps1',
  'scripts/NativeCompanionCache.ts',
  'scripts/CheckNativeCompanionCache.ts',
  'scripts/Env.ts',
  'pnpm-lock.yaml',
] as const;

const NativeCachePlatform = { MACOS: 'darwin', WINDOWS: 'win32' } as const;
const NativeCacheArchitecture = { ARM64: 'arm64', X64: 'x64' } as const;
export const NativeCompanionCacheSettingsSchema = z.strictObject({
  platform: z.enum(NativeCachePlatform),
  architecture: z.enum(NativeCacheArchitecture),
  runnerImage: z.string().min(1),
  runnerLabel: z.string().min(1),
  rustToolchain: z.string().min(1),
  deploymentTarget: z.string(),
});

export type NativeCompanionCacheSettings = z.infer<typeof NativeCompanionCacheSettingsSchema>;

export const NativeCompanionCacheState = {
  REUSED: 'reused',
  MISSING: 'missing',
  INVALID: 'invalid',
} as const;

const receiptName = 'CompanionCache.json';
const FileDigestSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ReceiptSchema = z.strictObject({
  version: z.literal(1),
  key: z.string().min(1),
  files: z.array(FileDigestSchema).min(1).max(10_000),
});

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Exact keys isolate architecture, compiler image, toolchain and every owned build input. */
export async function createNativeCompanionCacheKey(
  root: string,
  settings: NativeCompanionCacheSettings,
): Promise<string> {
  const validated = NativeCompanionCacheSettingsSchema.parse(settings);
  const inputs = await Promise.all(
    nativeCompanionCacheInputs.map(async (path) => ({
      path,
      sha256: hashBytes(await readFile(join(root, path))),
    })),
  );
  const digest = hashBytes(Buffer.from(JSON.stringify({ settings: validated, inputs })));
  return `tro-native-output-v1-${validated.platform}-${validated.architecture}-${digest}`;
}

/** Enumerate the actual tree; never follow a path supplied by the cached receipt. */
async function readCompanionFileDigests(
  directory: string,
): Promise<z.infer<typeof FileDigestSchema>[]> {
  const files: z.infer<typeof FileDigestSchema>[] = [];

  async function readDirectory(relativePath: string): Promise<void> {
    for (const entry of await readdir(join(directory, relativePath), { withFileTypes: true })) {
      const path = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) {
        await readDirectory(path);
      } else if (entry.isFile()) {
        if (path !== receiptName) {
          files.push({ path, sha256: hashBytes(await readFile(join(directory, path))) });
        }
      } else {
        throw new Error('Native companion cache cannot contain links or special files.');
      }
    }
  }

  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory()) {
    throw new Error('Native companion cache must be a directory.');
  }
  await readDirectory('');
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function validateCompanionBuild(
  directory: string,
  root: string,
  settings: NativeCompanionCacheSettings,
): Promise<void> {
  await validateCuaCompanion(directory, {
    platform: settings.platform,
    architecture: settings.architecture,
    patch: await readFile(join(root, 'driver-patches/CursorCompanion.patch')),
  });
}

/** Called only after the native regression suite and build succeed, before release signing. */
export async function recordNativeCompanionCache(
  directory: string,
  root: string,
  settings: NativeCompanionCacheSettings,
): Promise<void> {
  // Reject links before reading provenance, including an existing receipt symlink.
  const files = await readCompanionFileDigests(directory);
  await validateCompanionBuild(directory, root, settings);
  const receipt = ReceiptSchema.parse({
    version: 1,
    key: await createNativeCompanionCacheKey(root, settings),
    files,
  });
  await writeFile(join(directory, receiptName), JSON.stringify(receipt) + '\n');
}

/** Missing/corrupt/stale outputs trigger a rebuild; no cached executable is run here. */
export async function checkNativeCompanionCache(
  directory: string,
  root: string,
  settings: NativeCompanionCacheSettings,
): Promise<(typeof NativeCompanionCacheState)[keyof typeof NativeCompanionCacheState]> {
  const key = await createNativeCompanionCacheKey(root, settings);
  try {
    await lstat(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return NativeCompanionCacheState.MISSING;
    }
    return NativeCompanionCacheState.INVALID;
  }
  try {
    const files = await readCompanionFileDigests(directory);
    const raw: unknown = JSON.parse(await readFile(join(directory, receiptName), 'utf8'));
    const receipt = ReceiptSchema.parse(raw);
    if (receipt.key !== key || JSON.stringify(receipt.files) !== JSON.stringify(files)) {
      return NativeCompanionCacheState.INVALID;
    }
    await validateCompanionBuild(directory, root, settings);
    return NativeCompanionCacheState.REUSED;
  } catch {
    return NativeCompanionCacheState.INVALID;
  }
}
