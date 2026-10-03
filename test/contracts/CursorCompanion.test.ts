import { describe, expect, it } from 'vitest';
import { CursorCompanionStateSchema } from '../../src/contracts/CursorCompanion.js';
import { AgentResultSchema } from '../../src/contracts/AgentSession.js';
import {
  CursorGuidanceResultSchema,
  TeachingResultSchema,
} from '../../src/contracts/CursorCompanion.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const sequence = '22222222-2222-4222-8222-222222222222';

describe('guidance boundary contracts', () => {
  it('rejects explanation-only teaching results at the public boundary', () => {
    expect(
      AgentResultSchema.safeParse({
        kind: 'teaching',
        result: { outcome: 'explained', answer: 'Here is a written tutorial.' },
      }).success,
    ).toBe(false);
  });

  it('allows a specific student instruction without accepting an empty answer', () => {
    expect(
      AgentResultSchema.parse({
        kind: 'teaching',
        result: {
          outcome: 'needs_input',
          reason: 'no_demonstration',
          answer: 'Open ChatGPT first.',
        },
      }),
    ).toMatchObject({ result: { answer: 'Open ChatGPT first.' } });
    expect(
      TeachingResultSchema.safeParse({
        outcome: 'needs_input',
        reason: 'no_demonstration',
        answer: '  ',
      }).success,
    ).toBe(false);
  });

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

it('validates only epoch-bound, content-free native input progression', () => {
  const state = {
    status: 'state',
    following: true,
    active: false,
    guidance: {
      task_epoch: '11111111-1111-4111-8111-111111111111',
      reason: 'user_takeover',
      input_revision: 2,
    },
  };
  expect(CursorCompanionStateSchema.safeParse(state).success).toBe(true);
  expect(
    CursorCompanionStateSchema.safeParse({
      ...state,
      guidance: { ...state.guidance, keys: 'private input' },
    }).success,
  ).toBe(false);
  expect(
    CursorCompanionStateSchema.safeParse({
      ...state,
      guidance: { ...state.guidance, task_epoch: 'old' },
    }).success,
  ).toBe(false);
});
