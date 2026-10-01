import { createHash, randomBytes } from 'node:crypto';
import type { AuthState } from '#contracts/Auth.js';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DESKTOP_CALLBACK_URL = 'tro://auth/callback';
const FLOW_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface VerifiedGoogleIdentity {
  googleSubject: string;
  email: string;
  emailVerified: true;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface OAuthFlow {
  codeVerifier: string;
  nonce: string;
}

export interface AuthStore {
  saveOAuthFlow(input: {
    stateHash: string;
    codeVerifier: string;
    nonce: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeOAuthFlow(stateHash: string, usedAt: Date): Promise<OAuthFlow | null>;
  saveIdentityAndHandoff(input: {
    identity: VerifiedGoogleIdentity;
    codeHash: string;
    expiresAt: Date;
  }): Promise<void>;
  exchangeHandoff(input: {
    codeHash: string;
    tokenHash: string;
    expiresAt: Date;
    usedAt: Date;
  }): Promise<AuthState | null>;
  readSession(tokenHash: string, now: Date): Promise<AuthState | null>;
  createWorkspace(input: {
    tokenHash: string;
    displayName: string;
    now: Date;
  }): Promise<AuthState | null>;
  revokeSession(tokenHash: string, revokedAt: Date): Promise<void>;
  close(): Promise<void>;
}

export interface GoogleIdentityProvider {
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<VerifiedGoogleIdentity>;
}

export interface AuthConfiguration {
  googleClientId: string;
  googleRedirectUri: string;
}

export interface HandoffResult {
  sessionToken: string;
  state: AuthState;
}

export interface AuthOperations {
  startGoogleSignIn(): Promise<string>;
  completeGoogleSignIn(input: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
  }): Promise<string>;
  exchangeHandoff(code: string): Promise<HandoffResult>;
  readSession(sessionToken: string): Promise<AuthState>;
  createWorkspace(sessionToken: string, displayName: string): Promise<AuthState>;
  logout(sessionToken: string): Promise<void>;
  close(): Promise<void>;
}

export class AuthFailure extends Error {}

function createSecret(): string {
  return randomBytes(32).toString('base64url');
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

/** Owns OAuth correlation, one-time handoff, and server-side session workflows. */
export class AuthService implements AuthOperations {
  public constructor(
    private readonly store: AuthStore,
    private readonly google: GoogleIdentityProvider,
    private readonly configuration: AuthConfiguration,
    private readonly readNow: () => Date = () => new Date(),
  ) {}

  public async startGoogleSignIn(): Promise<string> {
    const state = createSecret();
    const nonce = createSecret();
    const codeVerifier = createSecret();
    const now = this.readNow();

    await this.store.saveOAuthFlow({
      stateHash: hashSecret(state),
      codeVerifier,
      nonce,
      expiresAt: addMilliseconds(now, FLOW_TTL_MS),
    });

    const authorizeUrl = new URL(GOOGLE_AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      client_id: this.configuration.googleClientId,
      redirect_uri: this.configuration.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();

    return authorizeUrl.href;
  }

  public async completeGoogleSignIn(input: {
    state?: string | undefined;
    code?: string | undefined;
    error?: string | undefined;
  }): Promise<string> {
    if (!input.state) {
      return this.createDesktopFailureUrl('invalid_request');
    }

    const now = this.readNow();
    const flow = await this.store.consumeOAuthFlow(hashSecret(input.state), now);

    if (!flow) {
      return this.createDesktopFailureUrl('invalid_or_expired');
    }

    if (input.error || !input.code) {
      return this.createDesktopFailureUrl(input.error === 'access_denied' ? 'cancelled' : 'failed');
    }

    try {
      const identity = await this.google.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: flow.codeVerifier,
        nonce: flow.nonce,
      });
      const handoffCode = createSecret();

      await this.store.saveIdentityAndHandoff({
        identity,
        codeHash: hashSecret(handoffCode),
        expiresAt: addMilliseconds(now, HANDOFF_TTL_MS),
      });

      const callbackUrl = new URL(DESKTOP_CALLBACK_URL);
      callbackUrl.searchParams.set('handoff', handoffCode);

      return callbackUrl.href;
    } catch {
      return this.createDesktopFailureUrl('failed');
    }
  }

  public async exchangeHandoff(code: string): Promise<HandoffResult> {
    const sessionToken = createSecret();
    const now = this.readNow();
    const state = await this.store.exchangeHandoff({
      codeHash: hashSecret(code),
      tokenHash: hashSecret(sessionToken),
      expiresAt: addMilliseconds(now, SESSION_TTL_MS),
      usedAt: now,
    });

    if (!state) {
      throw new AuthFailure('The sign-in link is invalid or expired.');
    }

    return { sessionToken, state };
  }

  public async readSession(sessionToken: string): Promise<AuthState> {
    const state = await this.store.readSession(hashSecret(sessionToken), this.readNow());

    if (!state) {
      throw new AuthFailure('The session is invalid or expired.');
    }

    return state;
  }

  public async createWorkspace(sessionToken: string, displayName: string): Promise<AuthState> {
    const state = await this.store.createWorkspace({
      tokenHash: hashSecret(sessionToken),
      displayName,
      now: this.readNow(),
    });

    if (!state) {
      throw new AuthFailure('The session cannot create a workspace.');
    }

    return state;
  }

  public async logout(sessionToken: string): Promise<void> {
    await this.store.revokeSession(hashSecret(sessionToken), this.readNow());
  }

  public async close(): Promise<void> {
    await this.store.close();
  }

  private createDesktopFailureUrl(reason: string): string {
    const callbackUrl = new URL(DESKTOP_CALLBACK_URL);
    callbackUrl.searchParams.set('error', reason);

    return callbackUrl.href;
  }
}
