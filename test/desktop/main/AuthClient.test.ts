import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { AccountVaultState } from '../../../src/desktop/main/accounts/AccountSessions.js';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAuthCallbackError } from '../../../src/desktop/main/accounts/DesktopAuthCallback.js';
import { AuthClient } from '../../../src/desktop/main/AuthClient.js';

const actions = vi.hoisted(() => ({
  setupMain: vi.fn<(config: unknown) => void>(),
  requestAuth:
    vi.fn<
      (options: {
        provider: 'google';
        additionalParams?: { prompt: 'select_account' };
      }) => Promise<void>
    >(),
  getCookie: vi.fn<() => string>(() => ''),
  signOut: vi.fn<() => Promise<unknown>>(),
}));

const sdk = vi.hoisted(() => ({
  observe: vi.fn<(options: { fetchOptions: { customFetchImpl: typeof fetch } }) => void>(),
}));
vi.mock('better-auth/client', () => ({
  createAuthClient: (options: { fetchOptions: { customFetchImpl: typeof fetch } }) => {
    sdk.observe(options);
    return actions;
  },
}));
vi.mock('@better-auth/electron/client', () => ({
  electronClient: () => ({ getActions: () => actions, fetchPlugins: [] }),
}));

describe('desktop authentication handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actions.getCookie.mockReturnValue('');
  });

  it('explicitly enables the SDK protocol handler without enabling its IPC bridge', () => {
    const client = new AuthClient('http://127.0.0.1:3000', '/unused-test-storage');
    const getWindow = (): BrowserWindow | undefined => undefined;

    client.registerDeepLink(getWindow);

    expect(actions.setupMain).toHaveBeenCalledExactlyOnceWith({
      csp: false,
      bridges: false,
      scheme: true,
      getWindow,
    });
  });

  it('uses the same Google flow with account selection and keeps the previous session', async () => {
    let state: AccountVaultState | null = null;
    const request = vi.fn<typeof fetch>().mockImplementation((input, options) =>
      Promise.resolve(
        (input instanceof Request ? input.url : input.toString()).endsWith('/api/v1/auth/google')
          ? Response.json({ available: true })
          : Response.json({
              user: {
                id: new Headers(options?.headers).get('cookie') ?? 'missing',
                name: 'Test user',
                email: 'test@example.test',
                role: 'student',
              },
            }),
      ),
    );
    const client = new AuthClient(
      'https://api.example.test',
      '/unused-test-storage',
      request,
      {
        read: () => state,
        save: (value) => {
          state = value;
        },
      },
      () => Promise.resolve(),
    );
    actions.getCookie.mockReturnValue('first-cookie');
    expect((await client.readSession()).kind).toBe('signed-in');
    expect(await client.addGoogleAccount()).toEqual({ kind: 'pending' });
    expect(actions.requestAuth).toHaveBeenCalledWith({
      provider: 'google',
      additionalParams: { prompt: 'select_account' },
    });
    expect(await client.readSession()).toEqual({ kind: 'pending' });
    actions.getCookie.mockReturnValue('second-cookie');
    expect((await client.readSession()).kind).toBe('signed-in');
    const saved = client.listAccounts();
    expect(saved.kind).toBe('accounts');
    if (saved.kind !== 'accounts' || !saved.accounts[0]) {
      throw new Error('Missing accounts');
    }
    expect(saved.accounts).toHaveLength(2);
    expect((await client.switchAccount(saved.accounts[0].id)).kind).toBe('signed-in');
    expect(client.readCookie()).toBe('first-cookie');
  });

  it('keeps the current account and avoids opening Google when its callback points elsewhere', async () => {
    let state: AccountVaultState | null = null;
    const request = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        (input instanceof Request ? input.url : input.toString()).endsWith('/api/v1/auth/google')
          ? Response.json({ available: true })
          : Response.json({
              user: { id: 'teacher', name: 'Teacher', email: 'teacher@example.test' },
            }),
      ),
    );
    const prepareCallback = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error(DesktopAuthCallbackError.WRONG_APP));
    const client = new AuthClient(
      'https://api.example.test',
      '/unused-test-storage',
      request,
      {
        read: () => state,
        save: (value) => {
          state = value;
        },
      },
      prepareCallback,
    );
    actions.getCookie.mockReturnValue('teacher-cookie');
    await client.readSession();
    expect(await client.addGoogleAccount()).toEqual({
      kind: 'failed',
      message: DesktopAuthCallbackError.WRONG_APP,
    });
    expect(prepareCallback).toHaveBeenCalledOnce();
    expect(actions.requestAuth).not.toHaveBeenCalled();
    expect(client.isAddingAccount()).toBe(false);
    expect(client.readCookie()).toBe('teacher-cookie');
  });

  it('cancels pending SDK proof states and rejects a late OAuth exchange', async () => {
    let state: AccountVaultState | null = null;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ user: { id: 'test-user', name: 'Test', email: 'test@example.test' } }),
      );
    const client = new AuthClient(
      'https://api.example.test',
      '/unused-test-storage',
      request,
      {
        read: () => state,
        save: (value) => {
          state = value;
        },
      },
      () => Promise.resolve(),
    );
    actions.getCookie.mockReturnValue('first-cookie');
    await client.readSession();
    let finish: (value: Response) => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const sdkFetch = sdk.observe.mock.lastCall?.[0].fetchOptions.customFetchImpl;
    if (!sdkFetch) {
      throw new Error('Missing SDK fetch boundary');
    }
    const lateExchange = sdkFetch('https://api.example.test/api/auth/electron/token');
    const proofs = new Map([['canceled-state', 'test-verifier']]);
    const symbol = Symbol.for('better-auth:electron');
    Reflect.set(globalThis, symbol, proofs);
    await client.cancelAccountSignIn();
    expect(proofs.size).toBe(0);
    finish(Response.json({ user: { id: 'wrong-user' } }));
    await expect(lateExchange).rejects.toThrow('The sign-in attempt ended.');
    expect(client.readCookie()).toBe('first-cookie');
    Reflect.deleteProperty(globalThis, symbol);
  });

  it('matches the pinned SDK runtime state-map key used for cancellation', () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve('@better-auth/electron/client'), 'utf8');
    expect(source).toContain('Symbol.for("better-auth:electron")');
    expect(source).toContain('globalThis[kElectron]?.delete(decoded?.state)');
  });
});
