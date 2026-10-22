import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readEvaluationPriceCard } from './ReadEvaluationPriceCard.js';

it('loads a bounded versioned local price card without contacting its provenance source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'TroPriceCard-'));
  try {
    const path = join(directory, 'Pricing.json');
    const card = {
      schemaVersion: 1,
      currency: 'USD',
      id: 'SyntheticPrices',
      source: 'https://unreachable.example.test/synthetic-price-fixture',
      effectiveAt: '2026-10-21T00:00:00.000Z',
      models: [
        {
          model: 'example-model',
          missingCacheWriteTokens: 'unknown',
          tiers: [
            {
              maximumInputTokens: null,
              inputUsdPerMillion: 2,
              cachedInputUsdPerMillion: 0.2,
              cacheWriteInputUsdPerMillion: null,
              outputUsdPerMillion: 8,
            },
          ],
        },
      ],
    };
    await writeFile(path, JSON.stringify(card));
    expect(await readEvaluationPriceCard(path)).toEqual(card);
    await writeFile(path, JSON.stringify({ ...card, models: [] }));
    await expect(readEvaluationPriceCard(path)).rejects.toThrow();
    await writeFile(path, '{invalid');
    await expect(readEvaluationPriceCard(path)).rejects.toThrow();
    await writeFile(path, ' '.repeat(64 * 1024 + 1));
    await expect(readEvaluationPriceCard(path)).rejects.toThrow('oversized');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
