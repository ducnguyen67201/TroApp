import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { serializeLessonValue } from '#contracts/LessonValue.js';
import { hashLessonValue } from '../../../../src/server/features/guidedLessons/application/BuildLessonInput.js';

it('preserves the existing sorted lesson hash representation across nested objects and arrays', () => {
  const value = { z: [{ b: 2, a: 1 }, null], a: { d: false, c: 'Tiếng Việt' } };
  const expected = '{"a":{"c":"Tiếng Việt","d":false},"z":[{"a":1,"b":2},null]}';
  expect(serializeLessonValue(value)).toBe(expected);
  expect(hashLessonValue(value)).toBe(createHash('sha256').update(expected).digest('hex'));
  expect(
    serializeLessonValue({ a: { c: 'Tiếng Việt', d: false }, z: [{ a: 1, b: 2 }, null] }),
  ).toBe(expected);
  expect(hashLessonValue({ values: [1, 2] })).not.toBe(hashLessonValue({ values: [2, 1] }));
});

it('rejects non-JSON lesson values instead of silently dropping them from the hash', () => {
  expect(() => serializeLessonValue({ missing: undefined })).toThrow();
  expect(() => serializeLessonValue({ value: Number.NaN })).toThrow();
});
