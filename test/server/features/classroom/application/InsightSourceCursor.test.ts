import { describe, expect, it } from 'vitest';
import {
  decodeSourceCursor,
  encodeSourceCursor,
  type InsightCursorScope,
} from '../../../../../src/server/features/classroom/application/InsightSourceCursor.js';

const scope: InsightCursorScope = {
  classId: '00000000-0000-4000-8000-000000000001',
  studentId: 'child',
  window: { from: '2026-10-01T00:00:00Z', to: '2026-10-31T23:59:59Z', timezone: 'UTC' },
  cutoff: '9007199254740995',
  privacyRevision: '3',
};

describe('insight source cursor snapshot binding', () => {
  it('round-trips an exact decimal position and starts a missing cursor at zero', () => {
    const cursor = encodeSourceCursor('9007199254740993', scope);
    expect(decodeSourceCursor(cursor, scope)).toBe('9007199254740993');
    expect(decodeSourceCursor(undefined, scope)).toBe('0');
  });

  it('rejects class, child, window, cutoff and privacy scope changes', () => {
    const cursor = encodeSourceCursor('10', scope);
    const changedScopes: InsightCursorScope[] = [
      { ...scope, classId: '00000000-0000-4000-8000-000000000002' },
      { ...scope, studentId: 'other' },
      { ...scope, studentId: null },
      { ...scope, cutoff: '9007199254740996' },
      { ...scope, privacyRevision: '4' },
      { ...scope, window: { ...scope.window, timezone: 'Asia/Ho_Chi_Minh' } },
      { ...scope, window: { ...scope.window, from: '2026-10-02T00:00:00Z' } },
      { ...scope, window: { ...scope.window, to: '2026-10-30T23:59:59Z' } },
    ];
    for (const changed of changedScopes) {
      expect(() => decodeSourceCursor(cursor, changed)).toThrow('stale');
    }
    expect(() => decodeSourceCursor(encodeSourceCursor('9007199254740996', scope), scope)).toThrow(
      'stale',
    );
  });

  it('refuses malformed encoding, untrusted JSON and unknown cursor fields', () => {
    const cursorInputs = [
      '',
      '+invalid',
      'a'.repeat(2001),
      Buffer.from('not JSON').toString('base64url'),
      Buffer.from(
        JSON.stringify({ version: 1, position: '10', ...scope, extra: 'untrusted' }),
      ).toString('base64url'),
      Buffer.from(JSON.stringify({ version: 1, position: '-1', ...scope })).toString('base64url'),
    ];
    for (const cursor of cursorInputs) {
      expect(() => decodeSourceCursor(cursor, scope)).toThrow('invalid');
    }
  });
});
