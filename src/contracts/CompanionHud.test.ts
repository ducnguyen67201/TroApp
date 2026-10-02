import { describe, expect, it } from 'vitest';
import {
  CompanionHudSnapshotSchema,
  AgentProgressSchema,
  VoiceMeterSchema,
} from './CompanionHud.js';
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
