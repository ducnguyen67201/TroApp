import { open } from 'node:fs/promises';
import { EvaluationPriceCardSchema, type EvaluationPriceCard } from './EvaluationUsage.js';

const maximumPriceCardBytes = 64 * 1024;

/** Read only a bounded local rate snapshot. Sources are provenance, never URLs to fetch. */
export async function readEvaluationPriceCard(path: string): Promise<EvaluationPriceCard> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(maximumPriceCardBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximumPriceCardBytes) {
      throw new Error('Evaluation price card is oversized.');
    }
    const raw: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    return EvaluationPriceCardSchema.parse(raw);
  } finally {
    await file.close();
  }
}
