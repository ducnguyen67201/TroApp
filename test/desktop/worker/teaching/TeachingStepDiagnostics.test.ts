import { expect, it } from 'vitest';
import {
  describeTeachingMessage,
  describeTeachingProposal,
} from '../../../../src/desktop/worker/teaching/TeachingStepDiagnostics.js';
import { createLesson } from './TeachingTestFixture.js';
it('logs action/receipt identities and lengths without instructional or screen contents', () => {
  const { proposal } = createLesson();
  const diagnostic = describeTeachingProposal({
    ...proposal,
    instruction: 'private-instruction',
    expectedResult: 'private-result',
  });
  expect(diagnostic).toMatchObject({ actionKind: 'click', checkpointId: null });
  const message = describeTeachingMessage({
    lessonId: 'private-lesson',
    stepId: 'private-step',
    sequence: 4,
    kind: 'instruction',
    text: 'private-text',
  });
  expect(message).toMatchObject({ messageSequence: 4, messageKind: 'instruction' });
  expect(JSON.stringify({ diagnostic, message })).not.toContain('private');
});
