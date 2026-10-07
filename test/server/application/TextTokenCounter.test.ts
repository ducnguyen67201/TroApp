import { expect, it, vi } from 'vitest';
import { countTextTokens } from '../../../src/server/application/TextTokenCounter.js';
import { countPracticeInput } from '../../../src/server/features/classroom/application/PracticeEvidence.js';
import { materialTokenCounter } from '../../../src/server/features/materials/application/MaterialTokenBudget.js';

const constructed = vi.hoisted(() => vi.fn<() => void>());
vi.mock('js-tiktoken/lite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('js-tiktoken/lite')>();
  return {
    ...actual,
    Tiktoken: class extends actual.Tiktoken {
      constructor(...arguments_: ConstructorParameters<typeof actual.Tiktoken>) {
        super(...arguments_);
        constructed();
      }
    },
  };
});

it('avoids route-import allocation and shares the real encoder between API features', () => {
  expect(constructed).not.toHaveBeenCalled();
  expect(materialTokenCounter.countText('Hello Python! Xin chào lớp học.')).toBe(9);
  expect(countPracticeInput({}, [])).toBe(1000 + countTextTokens('{"rubric":{},"evidence":[]}'));
  expect(constructed).toHaveBeenCalledOnce();
});

// Frozen counts from the previous getEncoding('o200k_base') implementation.
it.each([
  ['', 0],
  ['print("Xin chào các bạn")\n'.repeat(10), 80],
  ['🧑‍💻 café 中文\n    if x >= 2:\n        print(x)', 20],
  ['<|endoftext|> <|endofprompt|>', 14],
] as const)('preserves material token counts for %j', (text, tokens) => {
  expect(materialTokenCounter.countText(text)).toBe(tokens);
});

it('preserves the practice check rejection of reserved token text', () => {
  expect(() =>
    countPracticeInput({}, [
      { id: 'evidence', kind: 'text', name: 'Reserved', text: '<|endoftext|>' },
    ]),
  ).toThrow();
});
