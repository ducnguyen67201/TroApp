import { describe, expect, it } from 'vitest';
import { TeachingResultSchema } from '#contracts/CursorCompanion.js';
import { describeTeachingResult } from './TeachingResultPresentation.js';
import { english } from './localization/English.js';
import { vietnamese } from './localization/Vietnamese.js';

describe('teaching instructions and clarification display', () => {
  it.each([english, vietnamese])(
    'shows the actual next instruction or question',
    (translations) => {
      const answer = 'Which app do you want to learn? Tell me its name.';
      const result = TeachingResultSchema.parse({
        outcome: 'needs_input',
        reason: 'no_demonstration',
        answer,
      });
      expect(describeTeachingResult(result, translations)).toBe(answer);
      expect(
        describeTeachingResult(
          { outcome: 'explained', answer: 'Start by entering a question.' },
          translations,
        ),
      ).toBe('Start by entering a question.');
    },
  );

  it.each([english, vietnamese])(
    'retains deterministic copy without a usable answer',
    (translations) => {
      expect(
        describeTeachingResult(
          { outcome: 'needs_input', reason: 'no_demonstration' },
          translations,
        ),
      ).toBe(translations.guidanceNeedsInputMessage);
      expect(
        describeTeachingResult({ outcome: 'canceled', reason: 'user_takeover' }, translations),
      ).toBe(translations.guidanceCanceledMessage);
      expect(
        describeTeachingResult({ outcome: 'failed', reason: 'transport_failed' }, translations),
      ).toBe(translations.guidanceFailedMessage);
    },
  );
});
