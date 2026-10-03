import { describe, expect, it } from 'vitest';
import { AgentResultSchema } from '../../src/contracts/AgentSession.js';
import { TaskOutcomeSchema, TaskOutcomeStatus } from '../../src/contracts/TaskOutcome.js';

describe('public task outcomes', () => {
  const success = {
    status: TaskOutcomeStatus.SUCCEEDED,
    requiredCriteriaCount: 2,
    supportedCriteriaCount: 2,
    remainingCriteriaCount: 0,
    limitation: null,
  };

  it('requires an explicit completion mode and excludes private evidence', () => {
    expect(AgentResultSchema.safeParse({ kind: 'completed', answer: 'Done' }).success).toBe(false);
    expect(
      AgentResultSchema.safeParse({
        kind: 'completed',
        answer: 'Done',
        completion: { kind: 'task', outcome: success },
      }).success,
    ).toBe(true);
    expect(
      AgentResultSchema.safeParse({
        kind: 'completed',
        answer: 'Done',
        completion: { kind: 'task', outcome: { ...success, evidence: [] } },
      }).success,
    ).toBe(false);
  });

  it.each([
    { ...success, remainingCriteriaCount: 1 },
    { ...success, limitation: 'Missing permission' },
    { ...success, status: TaskOutcomeStatus.PARTIAL },
    { ...success, status: TaskOutcomeStatus.BLOCKED },
    { ...success, status: TaskOutcomeStatus.UNVERIFIED },
  ])('rejects inconsistent counts or status: %j', (outcome) => {
    expect(TaskOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('accepts partial progress only with remaining criteria and a limitation', () => {
    expect(
      TaskOutcomeSchema.safeParse({
        ...success,
        status: TaskOutcomeStatus.PARTIAL,
        supportedCriteriaCount: 1,
        remainingCriteriaCount: 1,
        limitation: 'The window is hidden.',
      }).success,
    ).toBe(true);
  });
});
