import type { AuthResult } from '#contracts/AuthSession.js';

/** Keeps account transitions exclusive with authenticated classroom/material requests. */
export class AccountTransitionGate {
  private changing = false;
  private requests = 0;

  constructor(
    private readonly isAddingAccount: () => boolean,
    private readonly isTaskBusy: () => boolean,
  ) {}

  isChanging(): boolean {
    return this.changing;
  }

  async runRequest<Result>(action: () => Promise<Result>, unavailable: Result): Promise<Result> {
    if (this.changing || this.isAddingAccount()) {
      return unavailable;
    }
    this.requests += 1;
    try {
      return await action();
    } finally {
      this.requests -= 1;
    }
  }

  async changeAccount(
    action: () => Promise<AuthResult>,
    canCancelSignIn = false,
  ): Promise<AuthResult> {
    return this.changeContext(
      action,
      { kind: 'failed', message: 'An account change cannot start during active work.' },
      canCancelSignIn,
    );
  }

  /** Classroom delegation changes share the same exclusion as signed-in account changes. */
  async changeContext<Result>(
    action: () => Promise<Result>,
    unavailable: Result,
    canCancelSignIn = false,
  ): Promise<Result> {
    if (
      this.changing ||
      this.requests > 0 ||
      this.isTaskBusy() ||
      (this.isAddingAccount() && !canCancelSignIn)
    ) {
      return unavailable;
    }
    this.changing = true;
    try {
      return await action();
    } finally {
      this.changing = false;
    }
  }
}
