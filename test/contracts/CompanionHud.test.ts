import { describe, expect, it } from 'vitest';
import {
  CompanionHudPhase,
  CompanionHudSnapshotSchema,
  AgentProgressSchema,
  VoiceMeterSchema,
  CompanionHudCommandKind,
  CompanionHudCommandSchema,
} from '../../src/contracts/CompanionHud.js';
describe('content-free companion boundaries', () => {
  it('rejects unbounded, invalid and content-bearing payloads', () => {
    const snapshot = { phase: 'thinking', locale: 'en', level: 0 };
    expect(CompanionHudSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      CompanionHudSnapshotSchema.safeParse({ ...snapshot, text: 'private transcript' }).success,
    ).toBe(false);
    expect(CompanionHudSnapshotSchema.safeParse({ ...snapshot, level: Infinity }).success).toBe(
      false,
    );
    expect(VoiceMeterSchema.safeParse({ captureId: 'bad', sequence: -1, level: 2 }).success).toBe(
      false,
    );
    expect(
      AgentProgressSchema.safeParse({
        kind: 'progress',
        sessionId: 'bad',
        requestId: 'bad',
        phase: 'thinking',
        arguments: {},
      }).success,
    ).toBe(false);
  });
});

it('validates message-free lease commands and conditional native clear tokens', () => {
  const group = '11111111-1111-4111-8111-111111111111';
  const renewal = { kind: CompanionHudCommandKind.RENEW_LEASE, group, sequence: 1 };
  expect(CompanionHudCommandSchema.safeParse(renewal).success).toBe(true);
  expect(CompanionHudCommandSchema.safeParse({ ...renewal, message: null }).success).toBe(false);
  expect(
    CompanionHudCommandSchema.safeParse({ ...renewal, sequence: Number.MAX_SAFE_INTEGER + 1 })
      .success,
  ).toBe(false);
  expect(
    CompanionHudCommandSchema.safeParse({
      kind: CompanionHudCommandKind.CLEAR_MESSAGE,
      group,
      sequence: 2,
    }).success,
  ).toBe(false);
  expect(
    CompanionHudCommandSchema.safeParse({
      kind: CompanionHudCommandKind.CLEAR_MESSAGE,
      group,
      sequence: 2,
      expectedToken: { ownerEpoch: group, revision: 1, renderId: group },
    }).success,
  ).toBe(true);
});

it('accepts content-free practice progress without carrying student evidence', () => {
  for (const phase of [
    CompanionHudPhase.CHECKING,
    CompanionHudPhase.SUBMITTING,
    CompanionHudPhase.CHECKED,
    CompanionHudPhase.SUBMITTED,
  ]) {
    expect(CompanionHudSnapshotSchema.safeParse({ phase, locale: 'vi', level: 0 }).success).toBe(
      true,
    );
    expect(
      CompanionHudSnapshotSchema.safeParse({ phase, locale: 'vi', level: 0, evidence: ['private'] })
        .success,
    ).toBe(false);
  }
});
