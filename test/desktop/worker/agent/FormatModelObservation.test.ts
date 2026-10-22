import { decode } from '@toon-format/toon';
import { afterEach, expect, it, vi } from 'vitest';
import {
  formatModelObservation,
  ModelObservationEncoding,
  ModelObservationLimits,
  ToonObservationPrefix,
} from '../../../../src/desktop/worker/agent/FormatModelObservation.js';
import * as tokens from '../../../../src/desktop/worker/agent/CountModelTextTokens.js';

function createObservationJson(): string {
  return JSON.stringify({
    pid: 7,
    window_id: 12,
    nodes: Array.from({ length: 120 }, (_, index) => ({
      nodeIdentifier: `node-${String(index)}`,
      role: 'button',
      accessibleName: `Scratch action ${String(index)}`,
      isEnabled: true,
    })),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('uses official lossless TOON only when the complete guided projection saves meaningful tokens', () => {
  const json = createObservationJson();
  const original: unknown = JSON.parse(json);
  const result = formatModelObservation(json);

  expect(result.format).toBe(ModelObservationEncoding.TOON);
  expect(result.text.startsWith(ToonObservationPrefix)).toBe(true);
  expect(result.text).toContain('Tool calls and final outputs must remain JSON');
  expect(decode(result.text.slice(ToonObservationPrefix.length))).toEqual(original);
  expect(result.jsonCharacters).toBe(json.length);
  expect(result.outputCharacters).toBe(result.text.length);
  expect(result.jsonTokens).toBe(tokens.countModelTextTokens(json));
  expect(result.outputTokens).toBe(tokens.countModelTextTokens(result.text));
  expect(result.jsonTokens).not.toBeNull();
  expect(result.outputTokens).not.toBeNull();
  if (result.jsonTokens === null || result.outputTokens === null) {
    throw new Error('Expected comparison token measurements.');
  }
  expect(result.jsonTokens - result.outputTokens).toBeGreaterThanOrEqual(
    ModelObservationLimits.MINIMUM_SAVED_TOKENS,
  );
  expect(result.outputTokens / result.jsonTokens).toBeLessThanOrEqual(0.9);
});

it('preserves Vietnamese, code, UUIDs, numeric-looking strings, nested fields and escaped values', () => {
  const json = JSON.stringify({
    nodes: Array.from({ length: 80 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      value: '00007',
      empty: '',
      missing: null,
      checked: false,
      title: 'Bài tập: tăng điểm 🙂, [2]{a,b}: "quoted"\\path\nnew line\tand tab\rreturn\u0000',
      code: 'if guess > secret:\n    print("Too large")\n<|endoftext|>',
      bounds: { x: index, y: 0, width: 120, height: 30 },
    })),
  });
  const result = formatModelObservation(json);
  const decoded: unknown =
    result.format === ModelObservationEncoding.TOON
      ? decode(result.text.slice(ToonObservationPrefix.length))
      : JSON.parse(result.text);

  expect(decoded).toEqual(JSON.parse(json));
  expect(result.format).toBe(ModelObservationEncoding.TOON);
});

it('keeps small, oversized and unstructured inputs byte-for-byte without tokenizing', () => {
  const count = vi.spyOn(tokens, 'countModelTextTokens');
  const inputs = [
    JSON.stringify({ capture_id: 'capture-1', pid: 7, window_id: 12 }),
    JSON.stringify({ text: 'x'.repeat(ModelObservationLimits.MAXIMUM_JSON_BYTES) }),
    JSON.stringify({ text: 'ế'.repeat(ModelObservationLimits.MAXIMUM_JSON_BYTES / 2) }),
    `not JSON ${'visible page text '.repeat(200)}`,
  ];
  for (const json of inputs) {
    expect(formatModelObservation(json)).toEqual({
      text: json,
      format: ModelObservationEncoding.JSON,
      jsonCharacters: json.length,
      outputCharacters: json.length,
      jsonTokens: null,
      outputTokens: null,
    });
  }
  expect(count).not.toHaveBeenCalled();
});

it('skips counting when encoding and the required syntax guide do not clear the character prefilter', () => {
  const json = JSON.stringify({
    prose: 'This is a long observation with no repeated fields. '.repeat(70),
  });
  const count = vi.spyOn(tokens, 'countModelTextTokens');
  const result = formatModelObservation(json);

  expect(result.text).toBe(json);
  expect(result.format).toBe(ModelObservationEncoding.JSON);
  expect(result.jsonTokens).toBeNull();
  expect(count).not.toHaveBeenCalled();
});

it.each([
  { jsonTokens: 500, candidateTokens: 449, expected: ModelObservationEncoding.JSON },
  { jsonTokens: 1000, candidateTokens: 935, expected: ModelObservationEncoding.JSON },
  { jsonTokens: 640, candidateTokens: 576, expected: ModelObservationEncoding.TOON },
])(
  'requires both token thresholds including the exact boundary: %j',
  ({ jsonTokens, candidateTokens, expected }) => {
    vi.spyOn(tokens, 'countModelTextTokens')
      .mockReturnValueOnce(jsonTokens)
      .mockReturnValueOnce(candidateTokens);
    const json = createObservationJson();
    const result = formatModelObservation(json);

    expect(result.format).toBe(expected);
    expect(result.jsonTokens).toBe(jsonTokens);
    expect(result.outputTokens).toBe(
      expected === ModelObservationEncoding.TOON ? candidateTokens : jsonTokens,
    );
    if (expected === ModelObservationEncoding.JSON) {
      expect(result.text).toBe(json);
    }
  },
);

it('returns the unchanged JSON when token comparison fails', () => {
  vi.spyOn(tokens, 'countModelTextTokens').mockImplementationOnce(() => {
    throw new Error('Synthetic tokenizer failure.');
  });
  const json = createObservationJson();
  expect(formatModelObservation(json)).toEqual({
    text: json,
    format: ModelObservationEncoding.JSON,
    jsonCharacters: json.length,
    outputCharacters: json.length,
    jsonTokens: null,
    outputTokens: null,
  });
});

it('retains all data when a deeply nested input is not a useful tabular projection', () => {
  const json = '['.repeat(1500) + '0' + ']'.repeat(1500);
  const result = formatModelObservation(json);

  expect(result.format).toBe(ModelObservationEncoding.JSON);
  expect(result.text).toBe(json);
});
