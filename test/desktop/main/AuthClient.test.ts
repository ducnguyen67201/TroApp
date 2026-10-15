import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { AccountVaultState } from '../../../src/desktop/main/accounts/AccountSessions.js';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopAuthCallbackError } from '../../../src/desktop/main/accounts/DesktopAuthCallback.js';
import { AuthUserSchema } from '#contracts/AuthSession.js';
import { AuthClient } from '../../../src/desktop/main/AuthClient.js';
import {
  StudentAccessCommandSchema,
  StudentDeviceCredentialSchema,
  StudentAccessKind,
} from '#contracts/StudentAccess.js';
import type { StudentDeviceStorage } from '../../../src/desktop/main/accounts/EncryptedStudentDevice.js';
import type { z } from 'zod';

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

  it('retains company authorization across restarts, forgets students and can return to personal mode', async () => {
    const context = {
      schoolId: '11111111-1111-4111-8111-111111111111',
      organizationId: '11111111-1111-4111-8111-111111111111',
      schoolName: 'School',
      classId: null,
      className: null,
      mode: 'shared',
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    const device = StudentDeviceCredentialSchema.parse({ credential: 'a'.repeat(64), context });
    let stored: z.infer<typeof StudentDeviceCredentialSchema> | null = null;
    const clear = vi.fn<() => void>(() => {
      stored = null;
    });
    const storage: StudentDeviceStorage = {
      read: () => stored,
      save: (value) => {
        stored = value;
      },
      clear,
    };
    const user = {
      id: 'existing-organization-student',
      name: 'Minh',
      email: null,
      learner: {
        schoolId: context.schoolId,
        schoolName: context.schoolName,
        organizationId: context.organizationId,
        classId: null,
        externalId: '001Ab',
        mode: 'shared',
        provisional: true,
      },
    };
    const request = vi.fn<typeof fetch>().mockImplementation((input, options) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/command')) {
        const raw: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
        const command = StudentAccessCommandSchema.parse(raw);
        if (command.kind === StudentAccessKind.ACTIVATE) {
          return Promise.resolve(Response.json(device));
        }
        if (command.kind === StudentAccessKind.ENROLL) {
          return Promise.resolve(
            Response.json({
              user,
              role: 'student',
              expiresAt: context.expiresAt,
              credential: 'b'.repeat(64),
            }),
          );
        }
        return Promise.resolve(Response.json({ kind: 'done' }));
      }
      if (url.endsWith('/sign-out')) {
        return Promise.resolve(Response.json({ kind: 'done' }));
      }
      return Promise.resolve(
        Response.json({ user, role: 'student', expiresAt: context.expiresAt }),
      );
    });
    const save = vi.fn<(value: AccountVaultState) => void>();
    const vault = { read: () => null, save };
    const createClient = () =>
      new AuthClient(
        'https://api.example.test',
        '/unused-test-storage',
        request,
        vault,
        () => Promise.resolve(),
        storage,
      );
    const client = createClient();
    expect(
      await client.controlStudentAccess({
        kind: 'activate',
        code: 'TRO-ABCDEFGHIJKLMNOP',
        requestId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toMatchObject({ kind: 'ready', context });
    expect(client.listAccounts()).toMatchObject({
      kind: 'accounts',
      deviceMode: 'shared',
      accounts: [],
    });
    expect(
      (
        await client.controlStudentAccess({
          kind: 'enroll',
          externalId: '001Ab',
          name: '',
          requestId: '33333333-3333-4333-8333-333333333333',
        })
      ).kind,
    ).toBe('signed-in');
    expect(save).not.toHaveBeenCalled();
    const requestsBeforeModeChange = request.mock.calls.length;
    expect(
      (
        await client.controlStudentAccess({
          kind: 'activate',
          code: 'TRO-ABCDEFGHIJKLMNOP',
          requestId: '44444444-4444-4444-8444-444444444444',
          mode: 'personal',
        })
      ).kind,
    ).toBe('failed');
    expect(request).toHaveBeenCalledTimes(requestsBeforeModeChange);
    const restarted = createClient();
    expect(await restarted.readSession()).toEqual({ kind: 'signed-out' });
    expect(restarted.listAccounts()).toMatchObject({ deviceMode: 'shared', accounts: [] });
    expect((await client.controlStudentAccess({ kind: 'deactivate' })).kind).toBe('failed');
    await client.signOut();
    expect(stored).not.toBeNull();
    expect((await client.controlStudentAccess({ kind: 'deactivate' })).kind).toBe('done');
    expect(clear).toHaveBeenCalledOnce();
    expect(client.listAccounts()).not.toHaveProperty('deviceMode', 'shared');
    expect(await client.controlStudentAccess({ kind: 'status' })).toEqual({ kind: 'unconfigured' });
  });

  it('does not consume a company code while a personal account remains saved', async () => {
    let state: AccountVaultState | null = null;
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        user: { id: 'personal', name: 'Personal', email: 'personal@example.test' },
      }),
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
      { read: () => null, save: () => {}, clear: () => {} },
    );
    actions.getCookie.mockReturnValue('personal-cookie');
    await client.readSession();
    request.mockClear();
    expect(
      await client.controlStudentAccess({
        kind: 'activate',
        code: 'TRO-ABCDEFGHIJKLMNOP',
        requestId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toEqual({
      kind: 'failed',
      message: 'Sign out all saved personal accounts before authorizing a company computer.',
    });
    expect(request).not.toHaveBeenCalled();
    expect(client.readCookie()).toBe('personal-cookie');
  });

  it('remembers personal organization QR logins alongside Google accounts and restores them after restart', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const google = AuthUserSchema.parse({
      id: 'google-user',
      name: 'Google user',
      email: 'personal@example.test',
    });
    const student = AuthUserSchema.parse({
      id: 'qr-user',
      name: 'Minh',
      email: null,
      learner: {
        schoolId: organizationId,
        organizationId,
        schoolName: 'School',
        classId: null,
        externalId: '001Ab',
        mode: 'personal',
        provisional: true,
      },
    });
    const device = StudentDeviceCredentialSchema.parse({
      credential: 'a'.repeat(64),
      context: {
        schoolId: organizationId,
        organizationId,
        schoolName: 'School',
        classId: null,
        className: null,
        mode: 'personal',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });
    let state: AccountVaultState | null = null;
    let stored: z.infer<typeof StudentDeviceCredentialSchema> | null = null;
    const storage: StudentDeviceStorage = {
      read: () => stored,
      save: (value) => {
        stored = value;
      },
      clear: () => {
        stored = null;
      },
    };
    const request = vi.fn<typeof fetch>().mockImplementation((input, options) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/command')) {
        const raw: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
        const command = StudentAccessCommandSchema.parse(raw);
        if (command.kind === StudentAccessKind.ACTIVATE) {
          expect(command.mode).toBe('personal');
          return Promise.resolve(Response.json(device));
        }
        if (command.kind === StudentAccessKind.ENROLL) {
          return Promise.resolve(
            Response.json({
              user: student,
              role: 'student',
              expiresAt: device.context.expiresAt,
              credential: 'b'.repeat(64),
            }),
          );
        }
        return Promise.resolve(Response.json({ kind: 'done' }));
      }
      const cookie = new Headers(options?.headers).get('cookie');
      return Promise.resolve(
        Response.json({
          user: cookie?.startsWith('tro_student=') ? student : google,
          role: 'student',
          expiresAt: device.context.expiresAt,
        }),
      );
    });
    const createClient = () =>
      new AuthClient(
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
        storage,
      );
    actions.getCookie.mockReturnValue('google-cookie');
    const client = createClient();
    expect(await client.readSession()).toEqual({ kind: 'signed-in', user: google });
    const googleAccount = client.listAccounts();
    if (googleAccount.kind !== 'accounts' || !googleAccount.accounts[0]) {
      throw new Error('Missing Google account fixture.');
    }
    const googleAccountId = googleAccount.accounts[0].id;
    expect(
      await client.controlStudentAccess({
        kind: 'activate',
        code: 'TRO-ABCDEFGHIJKLMNOP',
        requestId: '22222222-2222-4222-8222-222222222222',
        mode: 'personal',
      }),
    ).toMatchObject({ kind: 'ready', context: { mode: 'personal' } });
    expect(client.readCookie()).toBe('google-cookie');
    const cleanup = vi.fn<() => Promise<void>>(() => {
      expect(client.readCookie()).toBe('google-cookie');
      return Promise.resolve();
    });
    expect(
      await client.controlStudentAccess(
        {
          kind: 'enroll',
          externalId: '001Ab',
          name: '',
          requestId: '33333333-3333-4333-8333-333333333333',
        },
        cleanup,
      ),
    ).toEqual({ kind: 'signed-in', user: student });
    expect(cleanup).toHaveBeenCalledOnce();
    const accounts = client.listAccounts();
    if (accounts.kind !== 'accounts') {
      throw new Error('Missing remembered accounts.');
    }
    expect(accounts.accounts.map((account) => account.user.id)).toEqual([google.id, student.id]);
    const restarted = createClient();
    expect(await restarted.readSession()).toEqual({ kind: 'signed-in', user: student });
    expect(await restarted.switchAccount(googleAccountId)).toEqual({
      kind: 'signed-in',
      user: google,
    });
    expect(restarted.readCookie()).toBe('google-cookie');
    expect(restarted.listAccounts()).not.toHaveProperty('deviceMode', 'shared');
  });

  it('rejects an activation response whose mode differs from the requested personal login', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const save = vi.fn<StudentDeviceStorage['save']>();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        credential: 'a'.repeat(64),
        context: {
          schoolId: organizationId,
          organizationId,
          schoolName: 'School',
          classId: null,
          className: null,
          mode: 'shared',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
      }),
    );
    const client = new AuthClient(
      'https://api.example.test',
      '/unused-test-storage',
      request,
      { read: () => null, save: () => {} },
      () => Promise.resolve(),
      { read: () => null, save, clear: () => {} },
    );
    expect(
      await client.controlStudentAccess({
        kind: 'activate',
        code: 'TRO-ABCDEFGHIJKLMNOP',
        requestId: '22222222-2222-4222-8222-222222222222',
        mode: 'personal',
      }),
    ).toEqual({
      kind: 'failed',
      message: 'The computer authorization mode did not match this sign-in.',
    });
    expect(save).not.toHaveBeenCalled();
    expect(client.listAccounts()).not.toHaveProperty('deviceMode', 'shared');
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
