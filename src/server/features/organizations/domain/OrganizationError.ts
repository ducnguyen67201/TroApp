import type { OrganizationFailure } from '#contracts/Organizations.js';

/** Public refusal code only; no email, invitation or profile content enters errors. */
export class OrganizationError extends Error {
  constructor(readonly code: OrganizationFailure) {
    super(code);
    this.name = 'OrganizationError';
  }
}
