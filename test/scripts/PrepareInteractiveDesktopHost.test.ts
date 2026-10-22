import { expect, it } from 'vitest';
import {
  createInteractiveDesktopHostLayout,
  runWithPhysicalArchiveFiles,
  type ArchiveFileSystemRuntime,
} from '../../scripts/PrepareInteractiveDesktopHost.js';
import {
  createDevelopmentBundleId,
  selectDesktopHostBundleId,
} from '../../src/desktop/DesktopIdentity.js';

it.skipIf(process.platform === 'win32')(
  'keeps native driver attribution equal to the stable evaluation bundle identity',
  () => {
    const layout = createInteractiveDesktopHostLayout('/repo');
    expect(layout.executable).toBe(
      '/repo/.tro-development/InteractiveHost/.tro-development/tro-dev.app/Contents/MacOS/Electron',
    );
    expect(layout.bundleId).toBe(createDevelopmentBundleId(layout.evaluationDirectory));
    expect(selectDesktopHostBundleId(false, layout.executable)).toBe(layout.bundleId);
    expect(selectDesktopHostBundleId(true, layout.executable)).toBe(layout.bundleId);
    expect(layout.bundleId).not.toBe(createDevelopmentBundleId('/repo'));
  },
);

it('reuses one evaluation identity across runs but separates different checkouts', () => {
  expect(createInteractiveDesktopHostLayout('/repo')).toEqual(
    createInteractiveDesktopHostLayout('/repo'),
  );
  expect(createInteractiveDesktopHostLayout('/other/repo').bundleId).not.toBe(
    createInteractiveDesktopHostLayout('/repo').bundleId,
  );
});

it.each([false, true, undefined])(
  'keeps Electron bundle copy and asynchronous staging cleanup in physical ASAR mode, restoring %s',
  async (previous) => {
    const runtime: ArchiveFileSystemRuntime = {
      versions: { electron: 'test-runtime' },
      noAsar: previous,
    };
    const stages: string[] = [];
    const result = await runWithPhysicalArchiveFiles(async () => {
      try {
        expect(runtime.noAsar).toBe(true);
        stages.push('copy');
        await Promise.resolve();
        return 'prepared';
      } finally {
        await Promise.resolve();
        expect(runtime.noAsar).toBe(true);
        stages.push('cleanup');
      }
    }, runtime);
    expect(result).toBe('prepared');
    expect(stages).toEqual(['copy', 'cleanup']);
    expect(runtime.noAsar).toBe(previous);
    expect(Object.hasOwn(runtime, 'noAsar')).toBe(true);
  },
);

it('restores an absent Electron setting after a failed operation and leaves ordinary Node untouched', async () => {
  const electron: ArchiveFileSystemRuntime = { versions: { electron: 'test-runtime' } };
  const node: ArchiveFileSystemRuntime = { versions: {} };
  const failure = new Error('Synthetic copy failure.');
  await expect(
    runWithPhysicalArchiveFiles(async () => {
      expect(electron.noAsar).toBe(true);
      await Promise.resolve();
      throw failure;
    }, electron),
  ).rejects.toBe(failure);
  expect(Object.hasOwn(electron, 'noAsar')).toBe(false);
  await runWithPhysicalArchiveFiles(async () => {
    expect(Object.hasOwn(node, 'noAsar')).toBe(false);
    await Promise.resolve();
  }, node);
  expect(Object.hasOwn(node, 'noAsar')).toBe(false);
});
