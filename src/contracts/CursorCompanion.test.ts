import { describe, expect, it } from 'vitest';
import { AgentResultSchema } from './AgentSession.js';
import { CursorGuidanceResultSchema, TeachingResultSchema } from './CursorCompanion.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const sequence = '22222222-2222-4222-8222-222222222222';

describe('guidance boundary contracts', () => {
  it('requires task-bound step evidence rather than the V1 completed state', () => {
    expect(
      CursorGuidanceResultSchema.safeParse({ status: 'completed', following: true, active: false })
        .success,
    ).toBe(false);
    expect(
      CursorGuidanceResultSchema.safeParse({
        status: 'completed',
        following: true,
        active: false,
        receipt: {
          presentation_version: 2,
          task_epoch: epoch,
          sequence_id: sequence,
          completed_steps: 2,
        },
      }).success,
    ).toBe(true);
  });

  it('cannot attach a model completion answer to a canceled guide', () => {
    expect(
      TeachingResultSchema.safeParse({
        outcome: 'canceled',
        reason: 'user_takeover',
        answer: 'Done',
      }).success,
    ).toBe(false);
    expect(
      AgentResultSchema.parse({
        kind: 'teaching',
        result: { outcome: 'canceled', reason: 'user_takeover' },
      }),
    ).toEqual({ kind: 'teaching', result: { outcome: 'canceled', reason: 'user_takeover' } });
  });
});
