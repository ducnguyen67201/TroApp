import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  StudentAccessPath,
  StudentSessionCookie,
  StudentSessionReplySchema,
} from '#contracts/StudentAccess.js';
import type { AuthUser } from '#contracts/AuthSession.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import { AccountRoleSchema } from '#contracts/AccountRole.js';
import { AuthUserSchema, type AuthResult } from '#contracts/AuthSession.js';
import { NetworkErrorCodeSchema } from '#contracts/ModelGatewayError.js';
import {
  DesktopAccountLimits,
  SavedAccountSchema,
  type SavedAccounts,
} from '#contracts/DesktopAccounts.js';

const StoredAccountSchema = SavedAccountSchema.extend({ cookie: z.string().min(1).max(64_000) });
export const AccountVaultSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    activeAccountId: z.uuid().nullable(),
    accounts: z.array(StoredAccountSchema).max(DesktopAccountLimits.MAX_ACCOUNTS),
  })
  .superRefine((state, context) => {
    const ids = new Set(state.accounts.map((account) => account.id));
    const users = new Set(state.accounts.map((account) => account.user.id));
    if (
      ids.size !== state.accounts.length ||
      users.size !== state.accounts.length ||
      (state.activeAccountId && !ids.has(state.activeAccountId)) ||
      (state.version === 1 && state.accounts.some((account) => account.user.learner))
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
  user: AuthUserSchema.safeExtend({ role: AccountRoleSchema.optional() }).loose(),
});

const SessionVerificationStage = {
  REQUEST: 'request',
  RESPONSE: 'response',
  BODY: 'response-body',
  JSON: 'response-json',
  SCHEMA: 'response-schema',
} as const;

type SessionVerificationStage =
  (typeof SessionVerificationStage)[keyof typeof SessionVerificationStage];

const SessionVerificationFailure = {
  TRANSPORT: 'transport',
  TIMEOUT: 'timeout',
  HTTP_STATUS: 'http-status',
  INVALID_JSON: 'invalid-json',
  INVALID_SESSION: 'invalid-session',
} as const;

interface SessionVerificationFailureDetails {
  stage: SessionVerificationStage;
  reason: (typeof SessionVerificationFailure)[keyof typeof SessionVerificationFailure];
  status?: number;
  networkCode?: z.infer<typeof NetworkErrorCodeSchema>;
}

/** Owns saved sessions. The SDK's OAuth slot is staging, never the active account after migration. */
export class AccountSessions {
  private state: AccountVaultState | null = null;
  private loaded = false;
  private generation = 0;
  private pending: { baselineCookie: string | null; deadlineMs: number } | null = null;
  private sharedMode = false;
  private sharedAccount: z.infer<typeof StoredAccountSchema> | null = null;

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
    if (state.accounts.some((account) => account.user.learner)) {
      state = { ...state, version: 2 };
    }
    this.vault.save(state);
    this.state = state;
  }

  readCookie(): string | null {
    this.load();
    if (this.sharedMode) {
      return this.sharedAccount?.cookie ?? null;
    }
    if (!this.state) {
      return this.readLoginCookie();
    }
    const account = this.state.accounts.find((item) => item.id === this.state?.activeAccountId);
    return account && !account.requiresSignIn ? account.cookie : null;
  }

  listAccounts(): SavedAccounts {
    this.load();
    if (this.sharedMode) {
      const account = this.sharedAccount;
      return {
        kind: 'accounts',
        deviceMode: StudentDeviceMode.SHARED,
        activeAccountId: account?.id ?? null,
        accounts: account
          ? [
              {
                id: account.id,
                user: account.user,
                role: account.role,
                requiresSignIn: account.requiresSignIn,
              },
            ]
          : [],
      };
    }
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
    if (this.sharedMode) {
      throw new Error('Google login is unavailable on a shared learner device.');
    }
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
    if (this.sharedMode) {
      if (!this.sharedAccount) {
        return { kind: 'signed-out' };
      }
      const generation = this.generation;
      const account = this.sharedAccount;
      const result = await this.verifyCookie(account.cookie);
      if (generation !== this.generation) {
        return { kind: 'pending' };
      }
      if (
        result.kind === 'signed-out' ||
        (result.kind === 'verified' && result.user.id !== account.user.id)
      ) {
        this.sharedAccount = null;
        this.generation += 1;
        return { kind: 'signed-out' };
      }
      return result.kind === 'verified' ? { kind: 'signed-in', user: result.user } : result;
    }
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
    if (this.sharedMode) {
      return { kind: 'failed', message: 'End this lesson and scan the next student card.' };
    }
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
    const learnerCookie = this.readCookie();
    if (this.sharedMode && !learnerCookie) {
      this.generation += 1;
      return { kind: 'signed-out' };
    }
    if (learnerCookie?.startsWith(`${StudentSessionCookie}=`)) {
      this.generation += 1;
      this.sharedAccount = null;
      if (!this.sharedMode && this.state) {
        this.save({
          ...this.state,
          activeAccountId: null,
          accounts: this.state.accounts.filter(
            (account) => account.id !== this.state?.activeAccountId,
          ),
        });
      }
      try {
        const response = await this.request(`${this.apiBaseUrl}${StudentAccessPath}/sign-out`, {
          method: 'POST',
          headers: { cookie: learnerCookie, origin: 'app.tro.desktop:/' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          console.warn('student.session.revocation.failed', { reason: 'response' });
        }
      } catch {
        console.warn('student.session.revocation.failed', { reason: 'transport' });
      }
      return { kind: 'signed-out' };
    }
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
    if (cookie.startsWith(`${StudentSessionCookie}=`)) {
      const startedAt = performance.now();
      let stage: SessionVerificationStage = SessionVerificationStage.REQUEST;
      try {
        const response = await this.request(`${this.apiBaseUrl}${StudentAccessPath}/session`, {
          method: 'POST',
          headers: { cookie, origin: 'app.tro.desktop:/' },
          signal: AbortSignal.timeout(10_000),
        });
        stage = SessionVerificationStage.RESPONSE;
        if (response.status === 401 || response.status === 403) {
          return { kind: 'signed-out' } as const;
        }
        if (!response.ok) {
          logSessionVerificationFailure(startedAt, {
            stage,
            reason: SessionVerificationFailure.HTTP_STATUS,
            status: response.status,
          });
          return {
            kind: 'failed',
            message: 'Could not check your sign-in.',
            retryable: true,
          } as const;
        }
        stage = SessionVerificationStage.JSON;
        const body: unknown = await response.json();
        const parsed = StudentSessionReplySchema.safeParse(body);
        if (!parsed.success || !parsed.data.user.learner) {
          logSessionVerificationFailure(startedAt, {
            stage: SessionVerificationStage.SCHEMA,
            reason: SessionVerificationFailure.INVALID_SESSION,
          });
          return { kind: 'failed', message: 'Could not read your sign-in.' } as const;
        }
        return { kind: 'verified', user: parsed.data.user, role: parsed.data.role } as const;
      } catch {
        logSessionVerificationFailure(startedAt, {
          stage,
          reason:
            stage === SessionVerificationStage.JSON
              ? SessionVerificationFailure.INVALID_JSON
              : SessionVerificationFailure.TRANSPORT,
        });
        return {
          kind: 'failed',
          message: 'Could not reach the sign-in service.',
          retryable: true,
        } as const;
      }
    }
    const startedAt = performance.now();
    let stage: SessionVerificationStage = SessionVerificationStage.REQUEST;
    let status: number | undefined;
    let text: string;
    try {
      const response = await this.request(`${this.apiBaseUrl}/api/auth/get-session`, {
        headers: { cookie },
        signal: AbortSignal.timeout(10_000),
      });
      stage = SessionVerificationStage.RESPONSE;
      status = response.status;
      if (response.status === 401) {
        return { kind: 'signed-out' } as const;
      }
      if (!response.ok) {
        logSessionVerificationFailure(startedAt, {
          stage,
          reason: SessionVerificationFailure.HTTP_STATUS,
          status,
        });
        return {
          kind: 'failed',
          message: 'Could not check your sign-in.',
          ...(isRetryableSessionStatus(response.status) ? { retryable: true } : {}),
        } as const;
      }
      stage = SessionVerificationStage.BODY;
      text = await response.text();
    } catch (error) {
      const networkCode = readSessionNetworkCode(error);
      logSessionVerificationFailure(startedAt, {
        stage,
        reason:
          error instanceof Error && error.name === 'TimeoutError'
            ? SessionVerificationFailure.TIMEOUT
            : SessionVerificationFailure.TRANSPORT,
        ...(status === undefined ? {} : { status }),
        ...(networkCode === undefined ? {} : { networkCode }),
      });
      return {
        kind: 'failed',
        message: 'Could not reach the sign-in service.',
        retryable: true,
      } as const;
    }
    if (!text) {
      return { kind: 'signed-out' } as const;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      logSessionVerificationFailure(startedAt, {
        stage: SessionVerificationStage.JSON,
        reason: SessionVerificationFailure.INVALID_JSON,
        status,
      });
      return { kind: 'failed', message: 'Could not read your sign-in.' } as const;
    }
    if (body === null) {
      return { kind: 'signed-out' } as const;
    }
    const parsed = SessionResponseSchema.safeParse(body);
    if (!parsed.success) {
      logSessionVerificationFailure(startedAt, {
        stage: SessionVerificationStage.SCHEMA,
        reason: SessionVerificationFailure.INVALID_SESSION,
        status,
      });
      return { kind: 'failed', message: 'Could not read your sign-in.' } as const;
    }
    const { id, name, email, isAdmin, role } = parsed.data.user;
    const user: AuthUser = { id, name, email, isAdmin };
    return { kind: 'verified', user, role: role ?? null } as const;
  }

  /** Shared mode fails closed if personal accounts already exist in this OS app profile. */
  configureStudentMode(shared: boolean): void {
    this.load();
    if (
      shared &&
      ((this.state?.accounts.length ?? 0) > 0 || (!this.state && this.readLoginCookie()))
    ) {
      throw new Error('Sign out personal accounts before activating a shared device.');
    }
    if (this.sharedAccount && shared !== this.sharedMode) {
      throw new Error('End the current lesson before changing device mode.');
    }
    this.sharedMode = shared;
  }

  canAddStudent(): boolean {
    this.load();
    return (
      !this.pending &&
      !this.sharedAccount &&
      (this.sharedMode || (this.state?.accounts.length ?? 0) < DesktopAccountLimits.MAX_ACCOUNTS)
    );
  }

  async addStudent(
    cookie: string,
    user: AuthUser,
    beforeSelection?: () => Promise<void>,
  ): Promise<AuthResult> {
    if (
      !this.canAddStudent() ||
      !user.learner ||
      (user.learner.mode === StudentDeviceMode.SHARED) !== this.sharedMode
    ) {
      return { kind: 'failed', message: 'Saved account limit reached. Sign out an account first.' };
    }
    const generation = this.generation;
    const result = await this.verifyCookie(cookie);
    if (result.kind !== 'verified' || result.user.id !== user.id || !result.user.learner) {
      return { kind: 'failed', message: 'Could not check your student sign-in.' };
    }
    if (generation !== this.generation) {
      return { kind: 'failed', message: 'The account changed. Try again.' };
    }
    await beforeSelection?.();
    if (generation !== this.generation || !this.canAddStudent()) {
      return { kind: 'failed', message: 'The account changed. Try again.' };
    }
    const account = {
      id: randomUUID(),
      cookie,
      user: result.user,
      role: result.role,
      requiresSignIn: false,
    };
    if (this.sharedMode) {
      this.sharedAccount = account;
    } else {
      this.save({
        version: 2,
        activeAccountId: account.id,
        accounts: [...(this.state?.accounts ?? []), account],
      });
    }
    this.generation += 1;
    return { kind: 'signed-in', user: result.user };
  }

  isSharedStudent(): boolean {
    return this.sharedMode && this.sharedAccount !== null;
  }
}

function isRetryableSessionStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Read only a bounded network-code allowlist; raw transport errors stay private. */
function readSessionNetworkCode(
  error: unknown,
): z.infer<typeof NetworkErrorCodeSchema> | undefined {
  let candidate = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) {
      return undefined;
    }
    if ('code' in candidate) {
      const parsed = NetworkErrorCodeSchema.safeParse(candidate.code);
      if (parsed.success) {
        return parsed.data;
      }
    }
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

function logSessionVerificationFailure(
  startedAt: number,
  details: SessionVerificationFailureDetails,
): void {
  console.warn('auth.session.failed', {
    ...details,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });
}
