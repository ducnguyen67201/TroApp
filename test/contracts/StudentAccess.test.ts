import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  StudentAccessCommandSchema,
  StudentExternalIdSchema,
  StudentActivationCodeSchema,
  StudentDeviceContextSchema,
} from '#contracts/StudentAccess.js';
import { StudentQrLimits } from '#contracts/StudentIdentity.js';
import { AuthUserSchema } from '#contracts/AuthSession.js';

describe('student access trust boundaries', () => {
  it('preserves decoded QR text, including random values, URLs and structured text', () => {
    for (const value of [
      '0010Ab',
      'https://school.example.test/card?id=001',
      ' 001 ',
      'BEGIN:VCARD\nFN:Minh\nEND:VCARD',
      '{"role":"admin"}',
      'a'.repeat(StudentQrLimits.TEXT_CHARACTERS),
    ]) {
      expect(StudentExternalIdSchema.parse(value)).toBe(value);
    }
  });

  it('rejects empty, oversized or null-bearing QR text and role-bearing command fields', () => {
    for (const value of ['', ' \n\t ', '001\0', 'a'.repeat(StudentQrLimits.TEXT_CHARACTERS + 1)]) {
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

  it('allows QR login without a name while still bounding supplied names', () => {
    const command = { kind: 'enroll', requestId: randomUUID(), externalId: '001a' };
    expect(StudentAccessCommandSchema.parse(command)).toEqual({ ...command, name: '' });
    expect(StudentAccessCommandSchema.safeParse({ ...command, name: 'a'.repeat(81) }).success).toBe(
      false,
    );
  });

  it('distinguishes organization computer codes and validates organization learner scope', () => {
    expect(StudentActivationCodeSchema.safeParse('TRO-ABCDEFGHIJKLMNOP').success).toBe(true);
    expect(StudentActivationCodeSchema.safeParse('ABCDEF123456').success).toBe(false);
    expect(StudentActivationCodeSchema.safeParse('ABCDEFGHIJKLMNOP').success).toBe(false);
    const organizationId = randomUUID();
    const context = {
      schoolId: organizationId,
      organizationId,
      schoolName: 'Organization',
      classId: null,
      className: null,
      mode: 'shared',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    expect(StudentDeviceContextSchema.safeParse(context).success).toBe(true);
    expect(
      StudentDeviceContextSchema.safeParse({ ...context, classId: randomUUID() }).success,
    ).toBe(false);
    expect(
      StudentDeviceContextSchema.safeParse({ ...context, schoolId: randomUUID() }).success,
    ).toBe(false);
    expect(StudentDeviceContextSchema.safeParse({ ...context, mode: 'personal' }).success).toBe(
      true,
    );
  });

  it('accepts explicit personal activation and defaults omitted modes at the application boundary', () => {
    const command = { kind: 'activate', code: 'TRO-ABCDEFGHIJKLMNOP', requestId: randomUUID() };
    expect(StudentAccessCommandSchema.parse(command)).toEqual(command);
    expect(StudentAccessCommandSchema.safeParse({ ...command, mode: 'personal' }).success).toBe(
      true,
    );
    expect(StudentAccessCommandSchema.safeParse({ ...command, mode: 'shared' }).success).toBe(true);
    expect(StudentAccessCommandSchema.safeParse({ ...command, mode: 'unknown' }).success).toBe(
      false,
    );
  });

  it('creates an organization code without accepting a per-computer name', () => {
    const command = { kind: 'create-computer-code', organizationId: randomUUID() };
    expect(StudentAccessCommandSchema.parse(command)).toEqual(command);
    expect(
      StudentAccessCommandSchema.safeParse({ ...command, computerName: 'Manual name' }).success,
    ).toBe(false);
  });

  it('rejects retired class activation and roster operations', () => {
    const classId = randomUUID();
    for (const command of [
      { kind: 'create-admission', classId, schoolName: 'Old school', mode: 'personal' },
      { kind: 'revoke-admission', classId },
      { kind: 'preview-roster', classId, rows: [{ externalId: '001', name: 'Minh' }] },
      { kind: 'apply-roster', classId, rows: [{ externalId: '001', name: 'Minh' }], revision: 0 },
    ]) {
      expect(StudentAccessCommandSchema.safeParse(command).success).toBe(false);
    }
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
