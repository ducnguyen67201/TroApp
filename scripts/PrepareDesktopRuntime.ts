import { access, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

interface DesktopRuntimeSources {
  shortcuts: string;
  nativeLoader: string;
}

/** Replace only the generated app dependency tree. The Cua SDK has its own
 * physical resource directory and must not also survive here from older builds. */
export async function prepareDesktopRuntime(
  destination: string,
  sources: DesktopRuntimeSources,
): Promise<void> {
  await access(join(sources.shortcuts, 'package.json'));
  await access(join(sources.nativeLoader, 'package.json'));
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(sources.shortcuts, join(destination, 'uiohook-napi'), {
    recursive: true,
    dereference: true,
  });
  await cp(sources.nativeLoader, join(destination, 'node-gyp-build'), {
    recursive: true,
    dereference: true,
  });
}
