const OrganizationInvitationAttemptLimits = {
  WINDOW_MS: 60_000,
  ATTEMPTS: 10,
  ACCOUNTS: 1000,
} as const;

/** Bounds copied-code attempts on one API process without retaining invitation codes or email. */
export class OrganizationInvitationAttempts {
  private readonly windows = new Map<string, { since: number; attempts: number }>();

  canAttempt(userId: string, nowMs: number): boolean {
    for (const [id, window] of this.windows) {
      if (nowMs - window.since >= OrganizationInvitationAttemptLimits.WINDOW_MS) {
        this.windows.delete(id);
      }
    }
    const window = this.windows.get(userId);
    if (window) {
      if (window.attempts >= OrganizationInvitationAttemptLimits.ATTEMPTS) {
        return false;
      }
      window.attempts += 1;
      return true;
    }
    if (this.windows.size >= OrganizationInvitationAttemptLimits.ACCOUNTS) {
      return false;
    }
    this.windows.set(userId, { since: nowMs, attempts: 1 });
    return true;
  }
}
