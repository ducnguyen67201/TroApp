import { describe, expect, it, vi } from 'vitest';
import { AuthStatus, WorkspaceRole, type AuthState } from '#contracts/Auth.js';
import {
  AuthFailure,
  AuthService,
  type AuthStore,
  type GoogleIdentityProvider,
  type OAuthFlow,
} from './AuthService.js';

const now = new Date('2026-09-30T12:00:00.000Z');
const profile = {
  googleSubject: 'google-subject-1',
  email: 'person@example.test',
  emailVerified: true as const,
  displayName: 'Person',
  avatarUrl: null,
};
const pendingState: AuthState = {
  status: AuthStatus.NEEDS_WORKSPACE,
  profile: { email: profile.email, displayName: profile.displayName, avatarUrl: null },
};
const activeState: AuthState = {
  status: AuthStatus.AUTHENTICATED,
  profile: pendingState.profile,
  workspace: {
    id: 'a81bc81b-dead-4e5d-abff-90865d1e13b1',
    displayName: 'Studio',
    role: WorkspaceRole.OWNER,
  },
};

function createStore(overrides: Partial<AuthStore> = {}): AuthStore {
  return {
    saveOAuthFlow: vi.fn(() => Promise.resolve()),
    consumeOAuthFlow: vi.fn(() =>
      Promise.resolve<OAuthFlow | null>({ codeVerifier: 'verifier', nonce: 'nonce' }),
    ),
    saveIdentityAndHandoff: vi.fn(() => Promise.resolve()),
    exchangeHandoff: vi.fn(() => Promise.resolve(pendingState)),
    readSession: vi.fn(() => Promise.resolve(activeState)),
    createWorkspace: vi.fn(() => Promise.resolve(activeState)),
    revokeSession: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function createGoogle(): GoogleIdentityProvider {
  return { exchangeAuthorizationCode: vi.fn(() => Promise.resolve(profile)) };
}

function createService(store = createStore(), google = createGoogle()): AuthService {
  return new AuthService(
    store,
    google,
    {
      googleClientId: 'client-id.example.test',
      googleRedirectUri: 'https://api.example.test/api/v1/auth/google/callback',
    },
    () => now,
  );
}

describe('Google authentication workflow', () => {
  it('creates a correlated Google authorization request with nonce and PKCE', async () => {
    const saveOAuthFlow = vi.fn<AuthStore['saveOAuthFlow']>(() => Promise.resolve());
    const store = createStore({ saveOAuthFlow });
    const authorizeUrl = new URL(await createService(store).startGoogleSignIn());

    expect(authorizeUrl.origin).toBe('https://accounts.google.com');
    expect(authorizeUrl.searchParams.get('state')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('nonce')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      'https://api.example.test/api/v1/auth/google/callback',
    );
    expect(saveOAuthFlow).toHaveBeenCalledOnce();
  });

  it('validates the callback through the provider and creates a one-time desktop handoff', async () => {
    const saveIdentityAndHandoff = vi.fn<AuthStore['saveIdentityAndHandoff']>(() =>
      Promise.resolve(),
    );
    const exchangeAuthorizationCode = vi.fn<GoogleIdentityProvider['exchangeAuthorizationCode']>(
      () => Promise.resolve(profile),
    );
    const store = createStore({ saveIdentityAndHandoff });
    const google = { exchangeAuthorizationCode };
    const callbackUrl = new URL(
      await createService(store, google).completeGoogleSignIn({
        state: 'opaque-state',
        code: 'authorization-code',
      }),
    );

    expect(callbackUrl.protocol).toBe('tro:');
    expect(callbackUrl.hostname).toBe('auth');
    expect(callbackUrl.searchParams.get('handoff')).toBeTruthy();
    expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: 'authorization-code',
      codeVerifier: 'verifier',
      nonce: 'nonce',
    });
    expect(saveIdentityAndHandoff).toHaveBeenCalledOnce();
  });

  it('rejects expired or replayed callback state before contacting Google', async () => {
    const exchangeAuthorizationCode = vi.fn<GoogleIdentityProvider['exchangeAuthorizationCode']>(
      () => Promise.resolve(profile),
    );
    const google = { exchangeAuthorizationCode };
    const store = createStore({ consumeOAuthFlow: vi.fn(() => Promise.resolve(null)) });
    const callbackUrl = new URL(
      await createService(store, google).completeGoogleSignIn({
        state: 'replayed-state',
        code: 'authorization-code',
      }),
    );

    expect(callbackUrl.searchParams.get('error')).toBe('invalid_or_expired');
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('routes a new identity to onboarding and a returning user to their workspace', async () => {
    const newService = createService();
    await expect(newService.exchangeHandoff('a'.repeat(32))).resolves.toMatchObject({
      state: pendingState,
    });

    const returningStore = createStore({
      exchangeHandoff: vi.fn(() => Promise.resolve(activeState)),
    });
    await expect(
      createService(returningStore).exchangeHandoff('b'.repeat(32)),
    ).resolves.toMatchObject({ state: activeState });
  });

  it('rejects an invalid or expired handoff', async () => {
    const store = createStore({ exchangeHandoff: vi.fn(() => Promise.resolve(null)) });

    await expect(createService(store).exchangeHandoff('c'.repeat(32))).rejects.toBeInstanceOf(
      AuthFailure,
    );
  });
});
