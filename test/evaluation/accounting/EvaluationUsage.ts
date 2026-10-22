import { z } from 'zod';
import {
  InteractiveModelNameSchema,
  InteractiveModelRequestSchema,
  type InteractiveModelRequest,
} from '../interactive/InteractiveAgentProtocol.js';

export const MissingCacheWriteTokens = { ZERO: 'zero', UNKNOWN: 'unknown' } as const;

export const EvaluationCostReason = {
  PRICED: 'priced',
  NO_PRICE_CARD: 'no_price_card',
  MODEL_UNREPORTED: 'model_unreported',
  MODEL_NOT_PRICED: 'model_not_priced',
  USAGE_UNKNOWN: 'usage_unknown',
  INVALID_USAGE: 'invalid_usage',
  CACHE_WRITE_UNKNOWN: 'cache_write_unknown',
  CACHE_WRITE_NOT_PRICED: 'cache_write_not_priced',
  INPUT_TIER_NOT_PRICED: 'input_tier_not_priced',
  COST_OVERFLOW: 'cost_overflow',
} as const;

export type EvaluationCostReason = (typeof EvaluationCostReason)[keyof typeof EvaluationCostReason];

/* Limit rates to six decimal places so decimal arithmetic never depends on
 * binary floating-point multiplication. These are supplied rates, not defaults. */
const UsdPerMillionSchema = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine((value) => /^\d+(?:\.\d{1,6})?$/u.test(String(value)));

const EvaluationPriceTierSchema = z.strictObject({
  maximumInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  inputUsdPerMillion: UsdPerMillionSchema,
  cachedInputUsdPerMillion: UsdPerMillionSchema,
  cacheWriteInputUsdPerMillion: UsdPerMillionSchema.nullable(),
  outputUsdPerMillion: UsdPerMillionSchema,
});

const EvaluationModelPriceSchema = z
  .strictObject({
    model: InteractiveModelNameSchema,
    missingCacheWriteTokens: z
      .enum(MissingCacheWriteTokens)
      .default(MissingCacheWriteTokens.UNKNOWN),
    tiers: z.array(EvaluationPriceTierSchema).min(1).max(8),
  })
  .superRefine((price, context) => {
    let previousMaximum = -1;
    for (const [index, tier] of price.tiers.entries()) {
      if (
        (tier.maximumInputTokens === null && index !== price.tiers.length - 1) ||
        (tier.maximumInputTokens !== null && tier.maximumInputTokens <= previousMaximum)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Input tiers must increase, with an unlimited tier only at the end.',
          path: ['tiers', index, 'maximumInputTokens'],
        });
      }
      if (tier.maximumInputTokens !== null) {
        previousMaximum = tier.maximumInputTokens;
      }
    }
  });

/** Explicit, reproducible USD rate card. The caller owns checking its source,
 * effective date and applicable provider contract; no price is assumed current. */
export const EvaluationPriceCardSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    currency: z.literal('USD'),
    id: z.string().trim().min(1).max(160),
    source: z.string().trim().min(1).max(500),
    effectiveAt: z.iso.datetime(),
    models: z.array(EvaluationModelPriceSchema).min(1).max(16),
  })
  .superRefine((card, context) => {
    if (new Set(card.models.map((price) => price.model)).size !== card.models.length) {
      context.addIssue({ code: 'custom', message: 'Price-card models must be unique.' });
    }
  });

export type EvaluationPriceCard = z.infer<typeof EvaluationPriceCardSchema>;

interface EvaluationPriceProvenance {
  id: string;
  source: string;
  effectiveAt: string;
  currency: 'USD';
}

export interface EvaluationCallUsage {
  id: string;
  model: string | null;
  status: number | null;
  durationMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  estimatedCostUsd: number | null;
  costReason: EvaluationCostReason;
  pricingTierMaximumInputTokens: number | null;
  cacheWriteTokensAssumedZero: boolean;
}

export interface EvaluationUsageSummary {
  gatewayCalls: number | null;
  duplicateGatewayCalls: number;
  /** Missing/invalid input, cached-input or output counts. Optional reasoning
   * and cache-write detail coverage is reported separately through the calls. */
  requestsWithUnknownUsage: number | null;
  failedHttpCalls: number | null;
  failedFetchCalls: number | null;
  inputTokensObserved: number | null;
  cachedInputTokensObserved: number | null;
  cacheWriteInputTokensObserved: number | null;
  outputTokensObserved: number | null;
  reasoningTokensObserved: number | null;
  knownEstimatedCostUsd: number | null;
  /** Null unless every observed call can be priced. Hidden upstream attempts
   * remain outside this estimate even when this field is populated. */
  estimatedCostUsd: number | null;
  unpricedCalls: number | null;
  priceCard: EvaluationPriceProvenance | null;
  calls: EvaluationCallUsage[];
  providerAttemptAccountingComplete: false;
  costMeasured: false;
}

function isTokenCount(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function hasInvalidUsage(request: InteractiveModelRequest): boolean {
  const counts = [
    request.inputTokens,
    request.cachedInputTokens,
    request.cacheWriteInputTokens,
    request.outputTokens,
    request.reasoningTokens,
  ];
  return (
    counts.some((count) => count !== null && count !== undefined && !isTokenCount(count)) ||
    (isTokenCount(request.inputTokens) &&
      BigInt(request.cachedInputTokens ?? 0) + BigInt(request.cacheWriteInputTokens ?? 0) >
        BigInt(request.inputTokens)) ||
    (isTokenCount(request.outputTokens) &&
      isTokenCount(request.reasoningTokens) &&
      request.reasoningTokens > request.outputTokens)
  );
}

function readRateMillionths(rate: number): bigint {
  const [whole, fraction = ''] = String(rate).split('.');
  if (whole === undefined) {
    throw new Error('Missing validated price rate.');
  }
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function convertMicroUsd(value: bigint): number | null {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  const dollars = Number(value) / 1_000_000;
  /* At unusually large amounts, a safe integer can still lose a micro-dollar
   * when converted to decimal dollars. Keep that estimate unknown as well. */
  return BigInt(dollars.toFixed(6).replace('.', '')) === value ? dollars : null;
}

interface CallEstimate {
  microUsd: bigint | null;
  reason: EvaluationCostReason;
  maximumInputTokens: number | null;
  assumedWriteZero: boolean;
}

function estimateCall(
  request: InteractiveModelRequest,
  card: EvaluationPriceCard | null,
): CallEstimate {
  const unknown = (reason: EvaluationCostReason): CallEstimate => ({
    microUsd: null,
    reason,
    maximumInputTokens: null,
    assumedWriteZero: false,
  });
  if (hasInvalidUsage(request)) {
    return unknown(EvaluationCostReason.INVALID_USAGE);
  }
  if (!card) {
    return unknown(EvaluationCostReason.NO_PRICE_CARD);
  }
  if (!request.model) {
    return unknown(EvaluationCostReason.MODEL_UNREPORTED);
  }
  const price = card.models.find((entry) => entry.model === request.model);
  if (!price) {
    return unknown(EvaluationCostReason.MODEL_NOT_PRICED);
  }
  if (
    !isTokenCount(request.inputTokens) ||
    !isTokenCount(request.cachedInputTokens) ||
    !isTokenCount(request.outputTokens)
  ) {
    return unknown(EvaluationCostReason.USAGE_UNKNOWN);
  }
  const inputTokens = request.inputTokens;
  const tier = price.tiers.find(
    (entry) => entry.maximumInputTokens === null || inputTokens <= entry.maximumInputTokens,
  );
  if (!tier) {
    return unknown(EvaluationCostReason.INPUT_TIER_NOT_PRICED);
  }
  const assumedWriteZero =
    request.cacheWriteInputTokens == null &&
    price.missingCacheWriteTokens === MissingCacheWriteTokens.ZERO;
  const cacheWriteTokens = assumedWriteZero ? 0 : request.cacheWriteInputTokens;
  if (!isTokenCount(cacheWriteTokens)) {
    return unknown(EvaluationCostReason.CACHE_WRITE_UNKNOWN);
  }
  if (cacheWriteTokens > 0 && tier.cacheWriteInputUsdPerMillion === null) {
    return unknown(EvaluationCostReason.CACHE_WRITE_NOT_PRICED);
  }
  const uncached = inputTokens - request.cachedInputTokens - cacheWriteTokens;
  if (uncached < 0) {
    return unknown(EvaluationCostReason.INVALID_USAGE);
  }
  /* Sum exact millionths-of-rate products, then round the complete call upward
   * once to a micro-USD. Reasoning tokens are already included in output. */
  const numerator =
    BigInt(uncached) * readRateMillionths(tier.inputUsdPerMillion) +
    BigInt(request.cachedInputTokens) * readRateMillionths(tier.cachedInputUsdPerMillion) +
    BigInt(cacheWriteTokens) * readRateMillionths(tier.cacheWriteInputUsdPerMillion ?? 0) +
    BigInt(request.outputTokens) * readRateMillionths(tier.outputUsdPerMillion);
  const microUsd = (numerator + 999_999n) / 1_000_000n;
  if (convertMicroUsd(microUsd) === null) {
    return unknown(EvaluationCostReason.COST_OVERFLOW);
  }
  return {
    microUsd,
    reason: EvaluationCostReason.PRICED,
    maximumInputTokens: tier.maximumInputTokens,
    assumedWriteZero,
  };
}

function readObservedTotal(
  requests: readonly InteractiveModelRequest[] | null,
  readCount: (request: InteractiveModelRequest) => number | null | undefined,
): number | null {
  if (requests === null) {
    return null;
  }
  if (requests.length === 0) {
    return 0;
  }
  const counts = requests
    .filter((request) => !hasInvalidUsage(request))
    .map(readCount)
    .filter(isTokenCount);
  if (!counts.length) {
    return null;
  }
  const sum = counts.reduce((total, count) => total + BigInt(count), 0n);
  return sum <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sum) : null;
}

function readCallIdentity(request: InteractiveModelRequest): string {
  return JSON.stringify({
    ...request,
    model: request.model ?? null,
    cacheWriteInputTokens: request.cacheWriteInputTokens ?? null,
    reasoningTokens: request.reasoningTokens ?? null,
  });
}

/** Summarize returned gateway observations, not hidden provider retries or an
 * invoice. Duplicate identical observations are counted once; conflicting IDs
 * reject ambiguous accounting. Unknown measurements never become free calls. */
export function summarizeEvaluationUsage(
  requests: readonly InteractiveModelRequest[] | null,
  priceCard?: EvaluationPriceCard | null,
): EvaluationUsageSummary {
  const card = priceCard ? EvaluationPriceCardSchema.parse(priceCard) : null;
  const unique = new Map<string, InteractiveModelRequest>();
  let duplicates = 0;
  for (const input of requests ?? []) {
    const request = InteractiveModelRequestSchema.parse(input);
    const previous = unique.get(request.id);
    if (previous) {
      if (readCallIdentity(previous) !== readCallIdentity(request)) {
        throw new Error('Conflicting model request identity in evaluation accounting.');
      }
      duplicates += 1;
    } else {
      unique.set(request.id, request);
    }
  }
  const observed = requests === null ? null : [...unique.values()];
  let knownMicroUsd = 0n;
  const calls = (observed ?? []).map((request): EvaluationCallUsage => {
    const estimate = estimateCall(request, card);
    if (estimate.microUsd !== null) {
      knownMicroUsd += estimate.microUsd;
    }
    return {
      id: request.id,
      model: request.model ?? null,
      status: request.status,
      durationMs: request.durationMs,
      inputTokens: request.inputTokens,
      cachedInputTokens: request.cachedInputTokens,
      cacheWriteInputTokens: request.cacheWriteInputTokens ?? null,
      outputTokens: request.outputTokens,
      reasoningTokens: request.reasoningTokens ?? null,
      estimatedCostUsd: estimate.microUsd === null ? null : convertMicroUsd(estimate.microUsd),
      costReason: estimate.reason,
      pricingTierMaximumInputTokens: estimate.maximumInputTokens,
      cacheWriteTokensAssumedZero: estimate.assumedWriteZero,
    };
  });
  const unpriced =
    observed === null ? null : calls.filter((call) => call.estimatedCostUsd === null).length;
  const knownCost = observed === null ? null : convertMicroUsd(knownMicroUsd);
  return {
    gatewayCalls: observed?.length ?? null,
    duplicateGatewayCalls: duplicates,
    requestsWithUnknownUsage:
      observed?.filter(
        (request) =>
          hasInvalidUsage(request) ||
          !isTokenCount(request.inputTokens) ||
          !isTokenCount(request.cachedInputTokens) ||
          !isTokenCount(request.outputTokens),
      ).length ?? null,
    failedHttpCalls:
      observed?.filter((request) => request.status !== null && request.status >= 400).length ??
      null,
    failedFetchCalls: observed?.filter((request) => request.status === null).length ?? null,
    inputTokensObserved: readObservedTotal(observed, (request) => request.inputTokens),
    cachedInputTokensObserved: readObservedTotal(observed, (request) => request.cachedInputTokens),
    cacheWriteInputTokensObserved: readObservedTotal(
      observed,
      (request) => request.cacheWriteInputTokens,
    ),
    outputTokensObserved: readObservedTotal(observed, (request) => request.outputTokens),
    reasoningTokensObserved: readObservedTotal(observed, (request) => request.reasoningTokens),
    knownEstimatedCostUsd: knownCost,
    estimatedCostUsd: unpriced === 0 ? knownCost : null,
    unpricedCalls: unpriced,
    priceCard: card
      ? { id: card.id, source: card.source, effectiveAt: card.effectiveAt, currency: card.currency }
      : null,
    calls,
    providerAttemptAccountingComplete: false,
    costMeasured: false,
  };
}

function formatCount(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

function formatUsd(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(6)}`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

/** Readable per-call estimates preserve unknowns and rate-card provenance. */
export function formatEvaluationUsage(summary: EvaluationUsageSummary): string {
  return [
    `Observed gateway calls: ${formatCount(summary.gatewayCalls)}. HTTP failures: ${formatCount(summary.failedHttpCalls)}. Fetch failures: ${formatCount(summary.failedFetchCalls)}. Duplicate observations excluded: ${String(summary.duplicateGatewayCalls)}.`,
    `Observed token subtotals — input: ${formatCount(summary.inputTokensObserved)}; cached input: ${formatCount(summary.cachedInputTokensObserved)}; cache-write input: ${formatCount(summary.cacheWriteInputTokensObserved)}; output: ${formatCount(summary.outputTokensObserved)}; reasoning (included in output): ${formatCount(summary.reasoningTokensObserved)}. Requests with unknown core token usage: ${formatCount(summary.requestsWithUnknownUsage)}.`,
    `Estimated observed-call cost: ${formatUsd(summary.estimatedCostUsd)}. Known priced subtotal: ${formatUsd(summary.knownEstimatedCostUsd)}. Unpriced calls: ${formatCount(summary.unpricedCalls)}.`,
    summary.priceCard
      ? `Rate card: ${escapeCell(summary.priceCard.id)}; effective ${summary.priceCard.effectiveAt}; source: ${escapeCell(summary.priceCard.source)}. Estimates round each complete call upward to one micro-USD.`
      : 'Rate card: unavailable. Token observations are retained without inventing a price.',
    '',
    '| Call | Model | HTTP | Input | Cached | Cache write | Output | Reasoning subset | Estimated USD | Pricing status |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...summary.calls.map(
      (call) =>
        `| ${call.id} | ${escapeCell(call.model ?? 'unknown')} | ${formatCount(call.status)} | ${formatCount(call.inputTokens)} | ${formatCount(call.cachedInputTokens)} | ${formatCount(call.cacheWriteInputTokens)}${call.cacheWriteTokensAssumedZero ? ' (assumed 0 by card)' : ''} | ${formatCount(call.outputTokens)} | ${formatCount(call.reasoningTokens)} | ${formatUsd(call.estimatedCostUsd)} | ${call.costReason} |`,
    ),
    '',
    'Costs are token-based estimates for observed gateway responses, not measured invoices or complete provider-attempt accounting. Hidden backend retries and calls without terminal usage can add cost. Reasoning is not charged again beyond the output total.',
  ].join('\n');
}
