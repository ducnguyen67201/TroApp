import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { InteractiveModelRequest } from '../interactive/InteractiveAgentProtocol.js';
import {
  EvaluationCostReason,
  EvaluationPriceCardSchema,
  formatEvaluationUsage,
  summarizeEvaluationUsage,
  type EvaluationPriceCard,
} from './EvaluationUsage.js';

function createRequest(overrides: Partial<InteractiveModelRequest> = {}): InteractiveModelRequest {
  return {
    id: randomUUID(),
    status: 200,
    durationMs: 500,
    model: 'synthetic-test-model',
    inputTokens: 1000,
    cachedInputTokens: 200,
    cacheWriteInputTokens: 100,
    outputTokens: 100,
    reasoningTokens: 50,
    ...overrides,
  };
}

/** Deliberately synthetic prices, not a current provider price list. */
function createPriceCard(): EvaluationPriceCard {
  return EvaluationPriceCardSchema.parse({
    schemaVersion: 1,
    currency: 'USD',
    id: 'SyntheticFixturePrices',
    source: 'Authored accounting test fixture; not a provider quote.',
    effectiveAt: '2026-10-21T00:00:00.000Z',
    models: [
      {
        model: 'synthetic-test-model',
        missingCacheWriteTokens: 'unknown',
        tiers: [
          {
            maximumInputTokens: 1000,
            inputUsdPerMillion: 2,
            cachedInputUsdPerMillion: 0.2,
            cacheWriteInputUsdPerMillion: 3,
            outputUsdPerMillion: 8,
          },
          {
            maximumInputTokens: null,
            inputUsdPerMillion: 4,
            cachedInputUsdPerMillion: 0.4,
            cacheWriteInputUsdPerMillion: 6,
            outputUsdPerMillion: 12,
          },
        ],
      },
    ],
  });
}

function readPrice(card: EvaluationPriceCard) {
  const price = card.models[0];
  if (!price) {
    throw new Error('Missing synthetic model price.');
  }
  return price;
}

it('prices uncached input, cached input, cache writes and output once with auditable source provenance', () => {
  const request = createRequest();
  const card = createPriceCard();
  const summary = summarizeEvaluationUsage([request], card);

  expect(summary).toMatchObject({
    gatewayCalls: 1,
    requestsWithUnknownUsage: 0,
    inputTokensObserved: 1000,
    cachedInputTokensObserved: 200,
    cacheWriteInputTokensObserved: 100,
    outputTokensObserved: 100,
    reasoningTokensObserved: 50,
    estimatedCostUsd: 0.00254,
    knownEstimatedCostUsd: 0.00254,
    unpricedCalls: 0,
    providerAttemptAccountingComplete: false,
    costMeasured: false,
    priceCard: { id: card.id, source: card.source, effectiveAt: card.effectiveAt, currency: 'USD' },
  });
  expect(summary.calls[0]).toMatchObject({
    id: request.id,
    model: request.model,
    estimatedCostUsd: 0.00254,
    costReason: EvaluationCostReason.PRICED,
    pricingTierMaximumInputTokens: 1000,
    cacheWriteTokensAssumedZero: false,
  });
});

it('changes the selected tier above its inclusive input-token boundary', () => {
  const summary = summarizeEvaluationUsage(
    [createRequest({ inputTokens: 1001 })],
    createPriceCard(),
  );

  expect(summary.estimatedCostUsd).toBe(0.004684);
  expect(summary.calls[0]?.pricingTierMaximumInputTokens).toBeNull();
});

it('keeps requests beyond a finite price-card range unpriced', () => {
  const card = createPriceCard();
  readPrice(card).tiers.pop();
  const summary = summarizeEvaluationUsage([createRequest({ inputTokens: 1001 })], card);

  expect(summary.calls[0]?.costReason).toBe(EvaluationCostReason.INPUT_TIER_NOT_PRICED);
  expect(summary.estimatedCostUsd).toBeNull();
  expect(summary.unpricedCalls).toBe(1);
});

it('rounds the complete call once rather than rounding each token category independently', () => {
  const card = createPriceCard();
  const price = readPrice(card);
  price.tiers = [
    {
      maximumInputTokens: null,
      inputUsdPerMillion: 0.1,
      cachedInputUsdPerMillion: 0.1,
      cacheWriteInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.1,
    },
  ];
  const summary = summarizeEvaluationUsage(
    [
      createRequest({
        inputTokens: 2,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      }),
    ],
    card,
  );

  expect(summary.estimatedCostUsd).toBe(0.000001);
});

it('does not add reasoning tokens a second time and permits unreported reasoning details', () => {
  const first = summarizeEvaluationUsage([createRequest()], createPriceCard());
  const second = summarizeEvaluationUsage(
    [createRequest({ reasoningTokens: null })],
    createPriceCard(),
  );

  expect(second.estimatedCostUsd).toBe(first.estimatedCostUsd);
  expect(second.reasoningTokensObserved).toBeNull();
});

it('leaves missing cache-write accounting unknown unless the price card explicitly declares zero', () => {
  const request = createRequest({ cacheWriteInputTokens: null });
  const card = createPriceCard();
  const unknown = summarizeEvaluationUsage([request], card);
  expect(unknown.calls[0]?.costReason).toBe(EvaluationCostReason.CACHE_WRITE_UNKNOWN);
  expect(unknown.estimatedCostUsd).toBeNull();

  readPrice(card).missingCacheWriteTokens = 'zero';
  const assumed = summarizeEvaluationUsage([request], card);
  expect(assumed.estimatedCostUsd).toBe(0.00244);
  expect(assumed.calls[0]?.cacheWriteTokensAssumedZero).toBe(true);
  expect(assumed.cacheWriteInputTokensObserved).toBeNull();
  expect(formatEvaluationUsage(assumed)).toContain('assumed 0 by card');
});

it('does not silently price a nonzero cache write with an unsupported rate', () => {
  const card = createPriceCard();
  const tier = readPrice(card).tiers[0];
  if (!tier) {
    throw new Error('Missing synthetic input tier.');
  }
  tier.cacheWriteInputUsdPerMillion = null;
  expect(summarizeEvaluationUsage([createRequest()], card).calls[0]?.costReason).toBe(
    EvaluationCostReason.CACHE_WRITE_NOT_PRICED,
  );
  expect(
    summarizeEvaluationUsage([createRequest({ cacheWriteInputTokens: 0 })], card).estimatedCostUsd,
  ).not.toBeNull();
});

it.each([
  { overrides: { model: null }, reason: EvaluationCostReason.MODEL_UNREPORTED },
  { overrides: { model: 'different-model' }, reason: EvaluationCostReason.MODEL_NOT_PRICED },
  { overrides: { inputTokens: null }, reason: EvaluationCostReason.USAGE_UNKNOWN },
  { overrides: { cachedInputTokens: null }, reason: EvaluationCostReason.USAGE_UNKNOWN },
  { overrides: { outputTokens: null }, reason: EvaluationCostReason.USAGE_UNKNOWN },
])('does not guess missing or incompatible pricing: $reason', ({ overrides, reason }) => {
  const summary = summarizeEvaluationUsage([createRequest(overrides)], createPriceCard());

  expect(summary.calls[0]?.costReason).toBe(reason);
  expect(summary.estimatedCostUsd).toBeNull();
  expect(summary.unpricedCalls).toBe(1);
});

it('counts failed HTTP and fetch calls while retaining known usage and a partial priced subtotal', () => {
  const summary = summarizeEvaluationUsage(
    [
      createRequest({ status: 500 }),
      createRequest({
        status: null,
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
      }),
    ],
    createPriceCard(),
  );

  expect(summary).toMatchObject({
    gatewayCalls: 2,
    failedHttpCalls: 1,
    failedFetchCalls: 1,
    requestsWithUnknownUsage: 1,
    inputTokensObserved: 1000,
    knownEstimatedCostUsd: 0.00254,
    estimatedCostUsd: null,
    unpricedCalls: 1,
  });
});

it('distinguishes a measured empty run from absent accounting and missing rate cards', () => {
  expect(summarizeEvaluationUsage([], null)).toMatchObject({
    gatewayCalls: 0,
    inputTokensObserved: 0,
    cacheWriteInputTokensObserved: 0,
    estimatedCostUsd: 0,
    unpricedCalls: 0,
  });
  expect(summarizeEvaluationUsage(null)).toMatchObject({
    gatewayCalls: null,
    inputTokensObserved: null,
    estimatedCostUsd: null,
    knownEstimatedCostUsd: null,
    unpricedCalls: null,
  });
  const observed = summarizeEvaluationUsage([createRequest()]);
  expect(observed.calls[0]?.costReason).toBe(EvaluationCostReason.NO_PRICE_CARD);
  expect(observed.inputTokensObserved).toBe(1000);
  expect(observed.estimatedCostUsd).toBeNull();
});

it('deduplicates identical observations and rejects conflicting request IDs', () => {
  const request = createRequest();
  expect(summarizeEvaluationUsage([request, { ...request }], createPriceCard())).toMatchObject({
    gatewayCalls: 1,
    duplicateGatewayCalls: 1,
    estimatedCostUsd: 0.00254,
  });
  expect(() =>
    summarizeEvaluationUsage([request, { ...request, outputTokens: 101 }], createPriceCard()),
  ).toThrow('Conflicting model request identity');
});

it.each([{ inputTokens: 50 }, { reasoningTokens: 101 }])(
  'rejects impossible usage at the canonical accounting boundary: %j',
  (overrides) => {
    expect(() => summarizeEvaluationUsage([createRequest(overrides)], createPriceCard())).toThrow();
  },
);

it('rejects unsafe wire token counts at the accounting boundary', () => {
  expect(() =>
    summarizeEvaluationUsage(
      [createRequest({ inputTokens: Number.MAX_SAFE_INTEGER + 1 })],
      createPriceCard(),
    ),
  ).toThrow();
});

it('keeps an unrepresentable estimate unknown without emitting infinity or imprecise money', () => {
  const card = createPriceCard();
  const price = readPrice(card);
  price.tiers = [
    {
      maximumInputTokens: null,
      inputUsdPerMillion: 1_000_000,
      cachedInputUsdPerMillion: 1_000_000,
      cacheWriteInputUsdPerMillion: 1_000_000,
      outputUsdPerMillion: 1_000_000,
    },
  ];
  const summary = summarizeEvaluationUsage(
    [createRequest({ inputTokens: Number.MAX_SAFE_INTEGER })],
    card,
  );

  expect(summary.calls[0]?.costReason).toBe(EvaluationCostReason.COST_OVERFLOW);
  expect(summary.estimatedCostUsd).toBeNull();
  expect(JSON.stringify(summary)).not.toContain('Infinity');
});

it('validates price-card precision, model uniqueness and ordered tier coverage', () => {
  const card = createPriceCard();
  const price = readPrice(card);
  const first = price.tiers[0];
  if (!first) {
    throw new Error('Missing synthetic tier.');
  }
  expect(EvaluationPriceCardSchema.safeParse({ ...card, models: [price, price] }).success).toBe(
    false,
  );
  expect(
    EvaluationPriceCardSchema.safeParse({
      ...card,
      models: [{ ...price, tiers: [...price.tiers].reverse() }],
    }).success,
  ).toBe(false);
  expect(
    EvaluationPriceCardSchema.safeParse({
      ...card,
      models: [{ ...price, tiers: [{ ...first, inputUsdPerMillion: 0.0000001 }] }],
    }).success,
  ).toBe(false);
  expect(
    EvaluationPriceCardSchema.safeParse({
      ...card,
      models: [{ ...price, tiers: [{ ...first, inputUsdPerMillion: Number.NaN }] }],
    }).success,
  ).toBe(false);
  expect(
    EvaluationPriceCardSchema.safeParse({
      ...card,
      models: [{ ...price, tiers: [{ ...first, inputUsdPerMillion: -1 }] }],
    }).success,
  ).toBe(false);
});

it('prints every call with observed tokens, unknown coverage and reproducible pricing metadata', () => {
  const first = createRequest();
  const second = createRequest({ model: null });
  const text = formatEvaluationUsage(summarizeEvaluationUsage([first, second], createPriceCard()));

  expect(text).toContain(first.id);
  expect(text).toContain(second.id);
  expect(text).toContain('$0.002540');
  expect(text).toContain('Unpriced calls: 1');
  expect(text).toContain('model_unreported');
  expect(text).toContain('SyntheticFixturePrices');
  expect(text).toContain('not measured invoices');
  expect(formatEvaluationUsage(summarizeEvaluationUsage(null))).toContain(
    'Observed gateway calls: unknown',
  );
});
