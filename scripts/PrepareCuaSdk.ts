import { access, cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const dependencySchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
});

async function findInstalledPackage(name: string, fromDirectory: string): Promise<string | null> {
  let directory = fromDirectory;
  for (;;) {
    const candidate = join(directory, 'node_modules', name);
    try {
      await access(join(candidate, 'package.json'));
      return await realpath(candidate);
    } catch {
      const parent = dirname(directory);
      if (parent === directory) {
        return null;
      }
      directory = parent;
    }
  }
}

/** Stage the pinned SDK and installed native dependencies in one physical
 * resource tree. This avoids dlopen against Electron's virtual ASAR paths. */
export async function prepareCuaSdk(destination: string): Promise<void> {
  const copied = new Set<string>();

  async function copyPackage(name: string, fromDirectory: string, optional = false): Promise<void> {
    if (copied.has(name)) {
      return;
    }
    const source = await findInstalledPackage(name, fromDirectory);
    if (!source) {
      if (optional) {
        return;
      }
      throw new Error(`The desktop SDK dependency ${name} is missing.`);
    }
    copied.add(name);
    const rawMetadata: unknown = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const metadata = dependencySchema.parse(rawMetadata);
    const target = join(destination, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: true });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      await copyPackage(dependency, source);
    }
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
      await copyPackage(dependency, source, true);
    }
  }

  await copyPackage('@trycua/cua-driver', process.cwd());
}
