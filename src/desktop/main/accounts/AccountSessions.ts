import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccountRoleSchema } from '#contracts/AccountRole.js';
import { AuthUserSchema, type AuthResult } from '#contracts/AuthSession.js';
import {
  DesktopAccountLimits,
  SavedAccountSchema,
  type SavedAccounts,
} from '#contracts/DesktopAccounts.js';

const StoredAccountSchema = SavedAccountSchema.extend({ cookie: z.string().min(1).max(64_000) });
export const AccountVaultSchema = z
  .strictObject({
    version: z.literal(1),
    activeAccountId: z.uuid().nullable(),
    accounts: z.array(StoredAccountSchema).max(DesktopAccountLimits.MAX_ACCOUNTS),
  })
  .superRefine((state, context) => {
    const ids = new Set(state.accounts.map((account) => account.id));
    const users = new Set(state.accounts.map((account) => account.user.id));
    if (
      ids.size !== state.accounts.length ||
      users.size !== state.accounts.length ||
      (state.activeAccountId && !ids.has(state.activeAccountId))
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid saved account registry.' });
    }
  });

export type AccountVaultState = z.infer<typeof AccountVaultSchema>;

export interface AccountVault {
  read(): AccountVaultState | null;
  save(state: AccountVaultState): void;
}

const SessionResponseSchema = z.looseObject({
  user: AuthUserSchema.extend({ role: AccountRoleSchema.optional() }).loose(),
});

/** Owns saved sessions. The SDK's OAuth slot is staging, never the active account after migration. */
export class AccountSessions {
  private state: AccountVaultState | null = null;
  private loaded = false;
  private generation = 0;
  private pending: { baselineCookie: string | null; deadlineMs: number } | null = null;

  constructor(
    private readonly vault: AccountVault,
    private readonly readLoginCookie: () => string | null,
    private readonly request: typeof fetch,
    private readonly apiBaseUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): void {
    if (!this.loaded) {
      this.state = this.vault.read();
      this.loaded = true;
    }
  }

  private save(state: AccountVaultState): void {
    this.vault.save(state);
    this.state = state;
  }

  readCookie(): string | null {
    this.load();
    if (!this.state) {
      return this.readLoginCookie();
    }
    const account = this.state.accounts.find((item) => item.id === this.state?.activeAccountId);
    return account && !account.requiresSignIn ? account.cookie : null;
  }

  listAccounts(): SavedAccounts {
    this.load();
    return {
      kind: 'accounts',
      activeAccountId: this.state?.activeAccountId ?? null,
      accounts: (this.state?.accounts ?? []).map(({ id, user, role, requiresSignIn }) => ({
        id,
        user,
        role,
        requiresSignIn,
      })),
    };
  }

  isAddingAccount(): boolean {
    return this.pending !== null;
  }

  beginSignIn(): void {
    this.load();
    if (!this.state) {
      this.save({ version: 1, activeAccountId: null, accounts: [] });
    }
    this.generation += 1;
    this.pending = {
      baselineCookie: this.readLoginCookie(),
      deadlineMs: this.now() + DesktopAccountLimits.SIGN_IN_TIMEOUT_MS,
    };
  }

  cancelSignIn(): void {
    this.load();
    this.generation += 1;
    this.pending = null;
    /* Pin even an empty registry so a late SDK callback cannot become an active login. */
    if (!this.state) {
      this.save({ version: 1, activeAccountId: null, accounts: [] });
    }
  }

  async readSession(): Promise<AuthResult> {
    this.load();
    const pending = this.pending;
    if (pending && this.now() >= pending.deadlineMs) {
      this.cancelSignIn();
      return { kind: 'failed', message: 'Google sign-in did not finish. Please try again.' };
    }
    const cookie = pending ? this.readLoginCookie() : this.readCookie();
    if (pending && (!cookie || cookie === pending.baselineCookie)) {
      return { kind: 'pending' };
    }
    if (!cookie) {
      return { kind: 'signed-out' };
    }
    const generation = this.generation;
    const result = await this.verifyCookie(cookie);
    if (generation !== this.generation) {
      return { kind: 'pending' };
    }
    const activeAccount = this.state?.accounts.find(
      (account) => account.id === this.state?.activeAccountId,
    );
    if (
      !pending &&
      result.kind === 'verified' &&
      activeAccount &&
      result.user.id !== activeAccount.user.id
    ) {
      this.expireAccount(activeAccount.id);
      return { kind: 'signed-out' };
    }
    if (result.kind === 'verified') {
      const previous = this.state?.accounts.find((account) => account.user.id === result.user.id);
      const account = {
        id: previous?.id ?? randomUUID(),
        user: result.user,
        role: result.role,
        cookie,
        requiresSignIn: false,
      };
      const others = (this.state?.accounts ?? []).filter((item) => item.id !== account.id);
      if (others.length >= DesktopAccountLimits.MAX_ACCOUNTS) {
        this.pending = null;
        return {
          kind: 'failed',
          message: 'Saved account limit reached. Sign out an account first.',
        };
      }
      this.save({ version: 1, activeAccountId: account.id, accounts: [...others, account] });
      this.pending = null;
      return { kind: 'signed-in', user: result.user };
    }
    if (pending && result.kind === 'signed-out') {
      this.cancelSignIn();
      return { kind: 'failed', message: 'Sign in to this account again.' };
    }
    if (!pending && result.kind === 'signed-out' && this.state) {
      this.save({
        ...this.state,
        accounts: this.state.accounts.map((account) =>
          account.id === this.state?.activeAccountId
            ? { ...account, requiresSignIn: true }
            : account,
        ),
      });
    }
    return result;
  }

  async switchAccount(accountId: string): Promise<AuthResult> {
    this.load();
    const account = this.state?.accounts.find((item) => item.id === accountId);
    if (!account) {
      return { kind: 'failed', message: 'This saved account is unavailable.' };
    }
    this.cancelSignIn();
    const generation = this.generation;
    const result = await this.verifyCookie(account.cookie);
    if (generation !== this.generation) {
      return { kind: 'failed', message: 'The account changed. Try again.' };
    }
    const state = this.state;
    if (!state) {
      return { kind: 'failed', message: 'This saved account is unavailable.' };
    }
    if (result.kind === 'verified' && result.user.id === account.user.id) {
      this.save({
        ...state,
        activeAccountId: account.id,
        accounts: state.accounts.map((item) =>
          item.id === account.id
            ? { ...item, user: result.user, role: result.role, requiresSignIn: false }
            : item,
        ),
      });
      return { kind: 'signed-in', user: result.user };
    }
    if (result.kind === 'signed-out' || result.kind === 'verified') {
      this.save({
        ...state,
        accounts: state.accounts.map((item) =>
          item.id === account.id ? { ...item, requiresSignIn: true } : item,
        ),
      });
      return { kind: 'failed', message: 'Sign in to this account again.' };
    }
    return result;
  }

  private expireAccount(accountId: string): void {
    if (this.state) {
      this.save({
        ...this.state,
        accounts: this.state.accounts.map((account) =>
          account.id === accountId ? { ...account, requiresSignIn: true } : account,
        ),
      });
    }
  }

  async signOut(): Promise<AuthResult> {
    this.load();
    if (!this.state) {
      const session = await this.readSession();
      if (session.kind === 'failed') {
        return session;
      }
    }
    this.cancelSignIn();
    const cookie = this.readCookie();
    const state = this.state;
    if (!cookie || !state) {
      if (state) {
        this.save({
          ...state,
          activeAccountId: null,
          accounts: state.accounts.filter((item) => item.id !== state.activeAccountId),
        });
      }
      return { kind: 'signed-out' };
    }
    let response: Response;
    try {
      response = await this.request(`${this.apiBaseUrl}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie, origin: 'app.tro.desktop:/', 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { kind: 'failed', message: 'Could not sign out.' };
    }
    if (!response.ok) {
      return { kind: 'failed', message: 'Could not sign out.' };
    }
    this.save({
      ...state,
      activeAccountId: null,
      accounts: state.accounts.filter((item) => item.id !== state.activeAccountId),
    });
    return { kind: 'signed-out' };
  }

  private async verifyCookie(cookie: string) {
    try {
      const response = await this.request(`${this.apiBaseUrl}/api/auth/get-session`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        return { kind: 'signed-out' } as const;
      }
      if (!response.ok) {
        return { kind: 'failed', message: 'Could not check your sign-in.' } as const;
      }
      const text = await response.text();
      if (!text) {
        return { kind: 'signed-out' } as const;
      }
      const body: unknown = JSON.parse(text);
      if (body === null) {
        return { kind: 'signed-out' } as const;
      }
      const parsed = SessionResponseSchema.safeParse(body);
      if (!parsed.success) {
        return { kind: 'failed', message: 'Could not read your sign-in.' } as const;
      }
      const { id, name, email, role } = parsed.data.user;
      return { kind: 'verified', user: { id, name, email }, role: role ?? null } as const;
    } catch {
      return { kind: 'failed', message: 'Could not reach the sign-in service.' } as const;
    }
  }
}
