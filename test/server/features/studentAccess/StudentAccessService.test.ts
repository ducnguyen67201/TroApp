import { describe, expect, it } from 'vitest';
import { InvitationAttempts } from '../../../../src/server/features/classroom/application/InvitationAttempts.js';
import { StudentAccessPolicy } from '../../../../src/server/features/studentAccess/application/StudentAccessStore.js';
import {
  hasStudentCookie,
  readStudentCookie,
} from '../../../../src/server/features/studentAccess/application/StudentAccessService.js';

describe('student cookie parsing', () => {
  it('admits a classroom sharing one network while bounding repeated attempts', () => {
    const attempts = new InvitationAttempts(StudentAccessPolicy.REQUEST_ATTEMPTS_PER_IP);
    for (let request = 0; request < StudentAccessPolicy.REQUEST_ATTEMPTS_PER_IP; request += 1) {
      expect(attempts.canAttempt('shared-school-network', 0)).toBe(true);
    }
    expect(attempts.canAttempt('shared-school-network', 0)).toBe(false);
    expect(attempts.canAttempt('shared-school-network', 60_000)).toBe(true);
  });
  it('never falls back from duplicate or malformed learner credentials', () => {
    const token = 'a'.repeat(64);
    expect(readStudentCookie({ cookie: `other=1; tro_student=${token}` })).toBe(token);
    for (const cookie of ['tro_student=bad', `tro_student=${token}; tro_student=${token}`]) {
      expect(hasStudentCookie({ cookie })).toBe(true);
      expect(readStudentCookie({ cookie })).toBeNull();
    }
  });
});
