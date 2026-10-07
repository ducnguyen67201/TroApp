import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { MaterialSourceSchema } from '#contracts/ClassroomMaterials.js';
import { ExtractMaterial } from './ExtractMaterial.js';

const raw: unknown = workerData;
const { input } = z
  .object({
    input: z.strictObject({
      source: MaterialSourceSchema,
      file: z
        .strictObject({
          id: z.uuid(),
          classId: z.uuid(),
          name: z.string(),
          bytes: z.instanceof(Uint8Array),
        })
        .nullable(),
    }),
  })
  .parse(raw);
const pages = await new ExtractMaterial().extract(input.source, input.file);
parentPort?.postMessage(pages);
