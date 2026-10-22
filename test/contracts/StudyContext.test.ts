import { expect, it } from 'vitest';
import { ContextCommandSchema } from '../../src/contracts/StudyContext.js';
import { CheckpointUpdateSchema } from '../../src/contracts/StudyMemory.js';

it('rejects authority fields at context and checkpoint boundaries', () => {
  expect(ContextCommandSchema.safeParse({ kind: 'preferences', ownerId: 'other' }).success).toBe(
    false,
  );
  expect(
    CheckpointUpdateSchema.safeParse({
      expectedRevision: 0,
      coveredEventRevision: 0,
      sourceIds: [],
      summary: '',
      openQuestions: [],
      claims: [],
      verified: true,
    }).success,
  ).toBe(false);
});
