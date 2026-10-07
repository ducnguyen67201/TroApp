import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { MaterialPageSchema, type MaterialSource } from '#contracts/ClassroomMaterials.js';
import type { MaterialExtractor, MaterialFile } from '../application/MaterialPreparation.js';

/** Untrusted document parsing is isolated from the API event loop with memory/time bounds. */
export class MaterialExtractorWorker implements MaterialExtractor {
  readonly version = 'source-units-v2';
  async extract(source: MaterialSource, file: MaterialFile | null) {
    const development = import.meta.url.endsWith('.ts');
    const entry = new URL(`./ExtractMaterialWorker.${development ? 'ts' : 'js'}`, import.meta.url);
    const input = { source, file };
    const worker = development
      ? new Worker(
          "import('tsx/esm/api').then(({tsImport}) => tsImport(require('node:worker_threads').workerData.entry, require('node:worker_threads').workerData.entry));",
          {
            eval: true,
            workerData: { entry: entry.href, input },
            resourceLimits: { maxOldGenerationSizeMb: 256 },
            execArgv: ['--conditions=development'],
          },
        )
      : new Worker(entry, {
          workerData: { input },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
    try {
      return await new Promise<z.infer<typeof MaterialPageSchema>[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Material extraction timed out.'));
        }, 30_000);
        worker.once('message', (raw: unknown) => {
          clearTimeout(timer);
          const result = z.array(MaterialPageSchema).max(120).safeParse(raw);
          if (result.success) {
            resolve(result.data);
          } else {
            reject(new Error('Material extraction failed.'));
          }
        });
        worker.once('error', () => {
          clearTimeout(timer);
          reject(new Error('Material extraction failed.'));
        });
        worker.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Material extraction stopped.'));
        });
      });
    } finally {
      await worker.terminate();
    }
  }
}
