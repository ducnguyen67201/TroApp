import { describe, expect, it } from 'vitest';
import { TeachingResultSchema } from '#contracts/CursorCompanion.js';
import { describeTeachingResult } from '../../../src/desktop/renderer/TeachingResultPresentation.js';
import { english } from '../../../src/desktop/renderer/localization/English.js';
import { vietnamese } from '../../../src/desktop/renderer/localization/Vietnamese.js';

describe('teaching instructions and clarification display', () => {
  it.each([english, vietnamese])(
    'asks for a stable target after capture invalidation and suppresses model claims',
    (translations) => {
      expect(
        describeTeachingResult({ outcome: 'failed', reason: 'target_invalidated' }, translations),
      ).toBe(translations.guidanceTargetChangedMessage);
      expect(
        describeTeachingResult({ outcome: 'canceled', reason: 'target_invalidated' }, translations),
      ).toBe(translations.guidanceTargetChangedMessage);
    },
  );

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
          { outcome: 'demonstrated', answer: 'Click the message box I highlighted.' },
          translations,
        ),
      ).toBe('Click the message box I highlighted.');
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
