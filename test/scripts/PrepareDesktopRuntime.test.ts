import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareDesktopRuntime } from '../../scripts/PrepareDesktopRuntime.js';

it('replaces stale native dependencies while preserving the separate SDK resources', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tro-runtime-stage-'));
  try {
    const destination = join(temporary, 'out', 'node_modules');
    const sdk = join(temporary, 'out', 'cua-sdk');
    const shortcuts = join(temporary, 'shortcuts');
    const nativeLoader = join(temporary, 'loader');
    for (const directory of [destination, sdk, shortcuts, nativeLoader]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(join(shortcuts, 'package.json'), '{}');
    await writeFile(join(shortcuts, 'Native.node'), 'native fixture');
    await writeFile(join(nativeLoader, 'package.json'), '{}');
    await writeFile(join(nativeLoader, 'index.js'), 'loader fixture');
    await writeFile(join(destination, 'ObsoleteDriver.node'), 'duplicate');
    await writeFile(join(sdk, 'Driver.node'), 'sdk fixture');

    await prepareDesktopRuntime(destination, { shortcuts, nativeLoader });
    await prepareDesktopRuntime(destination, { shortcuts, nativeLoader });

    expect((await readdir(destination)).sort()).toEqual(['node-gyp-build', 'uiohook-napi']);
    expect(await readFile(join(destination, 'uiohook-napi', 'Native.node'), 'utf8')).toBe(
      'native fixture',
    );
    expect(await readFile(join(destination, 'node-gyp-build', 'index.js'), 'utf8')).toBe(
      'loader fixture',
    );
    expect(await readFile(join(sdk, 'Driver.node'), 'utf8')).toBe('sdk fixture');
    await expect(
      prepareDesktopRuntime(destination, { shortcuts, nativeLoader: join(temporary, 'missing') }),
    ).rejects.toThrow();
    expect((await readdir(destination)).sort()).toEqual(['node-gyp-build', 'uiohook-napi']);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
