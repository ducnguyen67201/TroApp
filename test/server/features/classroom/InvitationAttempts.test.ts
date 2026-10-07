import { expect, it } from 'vitest';
import { InvitationAttempts } from '../../../../src/server/features/classroom/application/InvitationAttempts.js';

it('limits repeated invitation attempts per account and admits again after the window', () => {
  const attempts = new InvitationAttempts();
  for (let index = 0; index < 10; index += 1) {
    expect(attempts.canAttempt('first', 100)).toBe(true);
  }
  expect(attempts.canAttempt('first', 100)).toBe(false);
  expect(attempts.canAttempt('second', 100)).toBe(true);
  expect(attempts.canAttempt('first', 60_100)).toBe(true);
});
