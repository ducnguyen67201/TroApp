import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StudentAccessCommandSchema, StudentExternalIdSchema } from '#contracts/StudentAccess.js';
import { AuthUserSchema } from '#contracts/AuthSession.js';

describe('student access trust boundaries', () => {
  it('preserves supplier IDs and rejects URLs, controls, oversized or role-bearing payloads', () => {
    expect(StudentExternalIdSchema.parse('0010Ab')).toBe('0010Ab');
    for (const value of ['https://school.test/123', ' 001', '001\n', 'a'.repeat(129), '']) {
      expect(StudentExternalIdSchema.safeParse(value).success).toBe(false);
    }
    expect(
      StudentAccessCommandSchema.safeParse({
        kind: 'enroll',
        requestId: randomUUID(),
        externalId: '001',
        name: 'Minh',
        role: 'teacher',
      }).success,
    ).toBe(false);
  });

  it('accepts only explicit non-admin email-less learner metadata', () => {
    expect(AuthUserSchema.safeParse({ id: 'student', name: 'Minh', email: null }).success).toBe(
      false,
    );
    const learner = {
      schoolId: randomUUID(),
      schoolName: 'School',
      classId: randomUUID(),
      externalId: '001',
      mode: 'personal',
      provisional: true,
    };
    expect(
      AuthUserSchema.safeParse({ id: 'student', name: 'Minh', email: null, learner }).success,
    ).toBe(true);
    expect(
      AuthUserSchema.safeParse({ id: 'student', name: 'Minh', email: null, learner, isAdmin: true })
        .success,
    ).toBe(false);
  });
});
