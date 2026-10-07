const InvitationLimits = { WINDOW_MS: 60_000, ATTEMPTS: 10, ACCOUNTS: 1000 } as const;

/** Bounds enrollment-code attempts per account on this API instance. No codes are retained. */
export class InvitationAttempts {
  private readonly windows = new Map<string, { since: number; attempts: number }>();

  canAttempt(userId: string, nowMs: number): boolean {
    for (const [id, window] of this.windows) {
      if (nowMs - window.since >= InvitationLimits.WINDOW_MS) {
        this.windows.delete(id);
      }
    }
    const window = this.windows.get(userId);
    if (window) {
      if (window.attempts >= InvitationLimits.ATTEMPTS) {
        return false;
      }
      window.attempts += 1;
      return true;
    }
    if (this.windows.size >= InvitationLimits.ACCOUNTS) {
      return false;
    }
    this.windows.set(userId, { since: nowMs, attempts: 1 });
    return true;
  }
}
