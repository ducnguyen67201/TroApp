import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { ClassroomCommandSchema, ClassroomHomeSchema } from '#contracts/Classroom.js';

describe('admin classroom contracts', () => {
  it('defaults older classroom homes to no admin access', () => {
    expect(
      ClassroomHomeSchema.parse({ role: AccountRole.STUDENT, courses: [], classes: [] }).isAdmin,
    ).toBe(false);
  });

  it('defaults pagination and bounds search and page offsets', () => {
    expect(ClassroomCommandSchema.parse({ kind: 'admin-classes', search: '  Class A  ' })).toEqual({
      kind: 'admin-classes',
      search: 'Class A',
      offset: 0,
    });
    for (const offset of [-1, 1.5, 1_000_001]) {
      expect(ClassroomCommandSchema.safeParse({ kind: 'admin-classes', offset }).success).toBe(
        false,
      );
    }
    expect(
      ClassroomCommandSchema.safeParse({ kind: 'admin-classes', search: 'a'.repeat(201) }).success,
    ).toBe(false);
  });

  it('rejects caller-supplied authority and target-user impersonation', () => {
    expect(ClassroomCommandSchema.safeParse({ kind: 'admin-classes', isAdmin: true }).success).toBe(
      false,
    );
    expect(
      ClassroomCommandSchema.safeParse({
        kind: 'admin-class',
        classId: randomUUID(),
        userId: 'teacher',
      }).success,
    ).toBe(false);
  });
});
