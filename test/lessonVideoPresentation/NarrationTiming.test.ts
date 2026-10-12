import { expect, it } from 'vitest';
import { splitNarration } from '../../src/lessonVideoPresentation/NarrationTiming.js';

it('preserves Vietnamese narration without clipping and bounds each page', () => {
  const text = 'Biểu thức Boolean chỉ có hai giá trị: đúng hoặc sai. '.repeat(19).trim();
  const pages = splitNarration(text);
  expect(pages.every((page) => page.length <= 180)).toBe(true);
  expect(pages.join(' ')).toBe(text);
});
it('splits long unbroken text without losing characters', () => {
  const text = 'x'.repeat(1000);
  expect(splitNarration(text).join('')).toBe(text);
});
