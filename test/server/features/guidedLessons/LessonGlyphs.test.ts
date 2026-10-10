import { expect, it } from 'vitest';
import { usesLessonGlyphs } from '../../../../src/server/features/guidedLessons/domain/LessonGlyphs.js';
import { validateLessonPlan } from '../../../../src/server/features/guidedLessons/domain/ValidateLessonPlan.js';
import { createLessonFixture } from './LessonFixture.js';

it('supports English, Vietnamese, normalized accents, and qualified punctuation', () => {
  expect(usesLessonGlyphs('Giải thích từng bước: tổng bằng không. “Đầu vào” – kết quả…')).toBe(
    true,
  );
  expect(usesLessonGlyphs('Dự đoán giá trị tiếp theo'.normalize('NFD'))).toBe(true);
  expect(usesLessonGlyphs('total = total + number\nprint(total)')).toBe(true);
});

it.each(['代码解释', '🙂', '∑ total', 'total\u200b', 'α + β'])(
  'rejects unsupported glyph fallback',
  (text) => {
    expect(usesLessonGlyphs(text)).toBe(false);
  },
);

it('blocks an otherwise valid plan when an essential title contains unsupported glyphs', () => {
  const { input, plan } = createLessonFixture();
  plan.title = 'Loop walkthrough 🙂';
  expect(validateLessonPlan(input, plan).some((issue) => issue.criterion === 'readability')).toBe(
    true,
  );
});
