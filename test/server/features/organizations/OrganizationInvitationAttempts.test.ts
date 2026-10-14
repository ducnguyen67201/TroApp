import { expect, it } from 'vitest';
import { OrganizationInvitationAttempts } from '../../../../src/server/features/organizations/infrastructure/OrganizationInvitationAttempts.js';

it('bounds attempts per account, permits independent accounts and clears expired windows', () => {
  const attempts = new OrganizationInvitationAttempts();
  for (let index = 0; index < 10; index += 1) {
    expect(attempts.canAttempt('first', 0)).toBe(true);
  }
  expect(attempts.canAttempt('first', 0)).toBe(false);
  expect(attempts.canAttempt('second', 0)).toBe(true);
  expect(attempts.canAttempt('first', 60_000)).toBe(true);
});

it('bounds retained account windows without evicting live limits', () => {
  const attempts = new OrganizationInvitationAttempts();
  for (let index = 0; index < 1000; index += 1) {
    expect(attempts.canAttempt(String(index), 0)).toBe(true);
  }
  expect(attempts.canAttempt('overflow', 0)).toBe(false);
  expect(attempts.canAttempt('overflow', 60_000)).toBe(true);
});
