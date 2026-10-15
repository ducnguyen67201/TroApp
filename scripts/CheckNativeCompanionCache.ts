import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readNativeCompanionCacheEnv } from './Env.js';
import {
  checkNativeCompanionCache,
  createNativeCompanionCacheKey,
  NativeCompanionCacheState,
  recordNativeCompanionCache,
} from './NativeCompanionCache.js';

const CacheOperation = { KEY: '--key', CHECK: '--check', RECORD: '--record' } as const;
const startedAt = Date.now();

try {
  const operation = z.enum(CacheOperation).parse(process.argv[2]);
  const { outputPath, settings } = readNativeCompanionCacheEnv(
    process.env,
    process.platform,
    process.arch,
  );
  const directory = join(homedir(), '.cache', 'tro', 'cua-companion');
  const root = process.cwd();
  if (operation === CacheOperation.KEY) {
    const key = await createNativeCompanionCacheKey(root, settings);
    await appendFile(outputPath, `key=${key}\n`);
  } else if (operation === CacheOperation.RECORD) {
    await recordNativeCompanionCache(directory, root, settings);
    console.info(
      JSON.stringify({
        event: 'native.cache',
        state: 'recorded',
        elapsedMs: Date.now() - startedAt,
      }),
    );
  } else {
    const state = await checkNativeCompanionCache(directory, root, settings);
    console.info(
      JSON.stringify({ event: 'native.cache', state, elapsedMs: Date.now() - startedAt }),
    );
    await appendFile(
      outputPath,
      `reusable=${String(state === NativeCompanionCacheState.REUSED)}\n`,
    );
  }
} catch {
  console.error('Native companion cache operation failed; no release output was accepted.');
  process.exitCode = 1;
}
