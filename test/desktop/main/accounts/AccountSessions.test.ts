import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { AuthResultSchema } from '#contracts/AuthSession.js';
import {
  AccountSessions,
  AccountVaultSchema,
  type AccountVaultState,
} from '../../../../src/desktop/main/accounts/AccountSessions.js';

const teacher = {
  id: 'teacher-user',
  name: 'Teacher',
  email: 'teacher@example.test',
  role: AccountRole.TEACHER,
};
const student = {
  id: 'student-user',
  name: 'Student',
  email: 'student@example.test',
  role: AccountRole.STUDENT,
};

const durationMatcher: unknown = expect.any(Number);

function createAccounts() {
  let state: AccountVaultState | null = null;
  let loginCookie: string | null = 'teacher-cookie';
  let now = 0;
  const save = vi.fn<(value: AccountVaultState) => void>((value) => {
    state = structuredClone(value);
  });
  const request = vi.fn<typeof fetch>().mockImplementation((_input, options) => {
    const cookie = new Headers(options?.headers).get('cookie');
    const user =
      cookie === 'teacher-cookie' ? teacher : cookie === 'student-cookie' ? student : null;
    return Promise.resolve(Response.json(user ? { user } : null));
  });
  const accounts = new AccountSessions(
    { read: () => state, save },
    () => loginCookie,
    request,
    'https://api.example.test',
    () => now,
  );
  return {
    accounts,
    request,
    save,
    setCookie: (value: string | null) => {
      loginCookie = value;
    },
    advanceTime: () => {
      now += 120_001;
    },
    readState: () => state,
  };
}

async function saveBothAccounts(harness: ReturnType<typeof createAccounts>) {
  await harness.accounts.readSession();
  harness.accounts.beginSignIn();
  harness.setCookie('student-cookie');
  await harness.accounts.readSession();
  const saved = harness.accounts.listAccounts();
  const teacherAccount = saved.accounts.find((account) => account.user.id === teacher.id);
  const studentAccount = saved.accounts.find((account) => account.user.id === student.id);
  if (!teacherAccount || !studentAccount) {
    throw new Error('Missing saved test accounts');
  }
  return { teacherAccount, studentAccount };
}

describe('saved account sessions', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps failure contracts compatible while validating optional retry permission', () => {
    const failure = { kind: 'failed', message: 'Could not check your sign-in.' };
    expect(AuthResultSchema.parse(failure)).toEqual(failure);
    expect(AuthResultSchema.parse({ ...failure, retryable: true })).toEqual({
      ...failure,
      retryable: true,
    });
    expect(AuthResultSchema.parse({ ...failure, retryable: false })).toEqual({
      ...failure,
      retryable: false,
    });
    expect(AuthResultSchema.safeParse({ ...failure, retryable: 'true' }).success).toBe(false);
    expect(AuthResultSchema.safeParse({ kind: 'signed-out', retryable: true }).success).toBe(false);
  });

  it('returns signed out without contacting the backend when no session is stored', async () => {
    const harness = createAccounts();
    harness.setCookie(null);
    expect(await harness.accounts.readSession()).toEqual({ kind: 'signed-out' });
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('migrates the existing login and exposes metadata without credentials', async () => {
    const harness = createAccounts();
    expect(await harness.accounts.readSession()).toEqual({
      kind: 'signed-in',
      user: { id: teacher.id, name: teacher.name, email: teacher.email, isAdmin: false },
    });
    const saved = harness.accounts.listAccounts();
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0]?.role).toBe(AccountRole.TEACHER);
    expect(JSON.stringify(saved)).not.toContain('cookie');
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
  });

  it('refreshes administrator access from the backend and preserves the account role', async () => {
    const harness = createAccounts();
    harness.request.mockResolvedValueOnce(Response.json({ user: { ...teacher, isAdmin: true } }));
    expect(await harness.accounts.readSession()).toEqual({
      kind: 'signed-in',
      user: { id: teacher.id, name: teacher.name, email: teacher.email, isAdmin: true },
    });
    expect(harness.accounts.listAccounts().accounts[0]?.user.isAdmin).toBe(true);
    expect(harness.accounts.listAccounts().accounts[0]?.role).toBe(AccountRole.TEACHER);

    await harness.accounts.readSession();
    expect(harness.accounts.listAccounts().accounts[0]?.user.isAdmin).toBe(false);
    expect(harness.accounts.listAccounts().accounts[0]?.role).toBe(AccountRole.TEACHER);
  });

  it('keeps separate cookies, rechecks the target, and restores an account after restart', async () => {
    const harness = createAccounts();
    const { teacherAccount } = await saveBothAccounts(harness);
    expect(harness.accounts.readCookie()).toBe('student-cookie');
    expect((await harness.accounts.switchAccount(teacherAccount.id)).kind).toBe('signed-in');
    expect(harness.request.mock.lastCall?.[1]?.headers).toEqual({ cookie: 'teacher-cookie' });
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
    harness.setCookie('unknown-staging-cookie');
    const restarted = new AccountSessions(
      { read: harness.readState, save: harness.save },
      () => 'student-cookie',
      harness.request,
      'https://api.example.test',
    );
    expect(restarted.readCookie()).toBe('teacher-cookie');
    expect(restarted.listAccounts().accounts).toHaveLength(2);
  });

  it('waits for a new OAuth cookie while retaining the old active account', async () => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    harness.accounts.beginSignIn();
    expect(await harness.accounts.readSession()).toEqual({ kind: 'pending' });
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
    expect(harness.accounts.listAccounts().accounts).toHaveLength(1);
  });

  it('deduplicates a renewed login for the same user', async () => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    const firstId = harness.accounts.listAccounts().activeAccountId;
    harness.accounts.beginSignIn();
    harness.setCookie('teacher-renewed-cookie');
    harness.request.mockResolvedValueOnce(Response.json({ user: teacher }));
    await harness.accounts.readSession();
    expect(harness.accounts.listAccounts().activeAccountId).toBe(firstId);
    expect(harness.accounts.listAccounts().accounts).toHaveLength(1);
    expect(harness.accounts.readCookie()).toBe('teacher-renewed-cookie');
  });

  it('ignores a canceled callback, including on a fresh signed-out device', async () => {
    const harness = createAccounts();
    harness.setCookie(null);
    harness.accounts.beginSignIn();
    harness.accounts.cancelSignIn();
    harness.setCookie('student-cookie');
    expect(await harness.accounts.readSession()).toEqual({ kind: 'signed-out' });
    expect(harness.accounts.listAccounts().accounts).toEqual([]);
  });

  it('expires the pending attempt without replacing the original account', async () => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    harness.accounts.beginSignIn();
    harness.advanceTime();
    expect((await harness.accounts.readSession()).kind).toBe('failed');
    harness.setCookie('student-cookie');
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
  });

  it('marks an expired target for sign-in and preserves the current identity', async () => {
    const harness = createAccounts();
    const { teacherAccount } = await saveBothAccounts(harness);
    harness.request.mockResolvedValueOnce(Response.json(null));
    expect(await harness.accounts.switchAccount(teacherAccount.id)).toEqual({
      kind: 'failed',
      message: 'Sign in to this account again.',
    });
    expect(harness.accounts.readCookie()).toBe('student-cookie');
    expect(
      harness.accounts.listAccounts().accounts.find((account) => account.id === teacherAccount.id)
        ?.requiresSignIn,
    ).toBe(true);
  });

  it('rejects an identity mismatch and a network failure without switching', async () => {
    const harness = createAccounts();
    const { teacherAccount } = await saveBothAccounts(harness);
    harness.request.mockResolvedValueOnce(Response.json({ user: student }));
    expect((await harness.accounts.switchAccount(teacherAccount.id)).kind).toBe('failed');
    harness.request.mockRejectedValueOnce(new Error('network'));
    expect((await harness.accounts.switchAccount(teacherAccount.id)).kind).toBe('failed');
    expect(harness.accounts.readCookie()).toBe('student-cookie');
  });

  it.each([408, 429, 500, 503, 599])(
    'allows bounded recovery from HTTP %i without expiring the saved account',
    async (status) => {
      const harness = createAccounts();
      await harness.accounts.readSession();
      const savedAccounts = harness.accounts.listAccounts();
      harness.save.mockClear();
      harness.request.mockResolvedValueOnce(new Response('private response body', { status }));

      expect(await harness.accounts.readSession()).toEqual({
        kind: 'failed',
        message: 'Could not check your sign-in.',
        retryable: true,
      });
      expect(harness.accounts.listAccounts()).toEqual(savedAccounts);
      expect(harness.accounts.readCookie()).toBe('teacher-cookie');
      expect(harness.save).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith('auth.session.failed', {
        stage: 'response',
        reason: 'http-status',
        status,
        durationMs: durationMatcher,
      });
    },
  );

  it.each([400, 403, 404, 422])(
    'does not permit automatic retries for HTTP %i or expire the saved account',
    async (status) => {
      const harness = createAccounts();
      await harness.accounts.readSession();
      const savedAccounts = harness.accounts.listAccounts();
      harness.save.mockClear();
      harness.request.mockResolvedValueOnce(new Response('private response body', { status }));

      expect(await harness.accounts.readSession()).toEqual({
        kind: 'failed',
        message: 'Could not check your sign-in.',
      });
      expect(harness.accounts.listAccounts()).toEqual(savedAccounts);
      expect(harness.accounts.readCookie()).toBe('teacher-cookie');
      expect(harness.save).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith('auth.session.failed', {
        stage: 'response',
        reason: 'http-status',
        status,
        durationMs: durationMatcher,
      });
    },
  );

  it.each([
    {
      name: 'connection failure',
      error: new TypeError('private transport message and URL', {
        cause: Object.assign(new Error('private cookie and configuration'), {
          code: 'ECONNREFUSED',
          address: 'private address',
        }),
      }),
      reason: 'transport',
      networkCode: 'ECONNREFUSED',
    },
    {
      name: 'request timeout',
      error: new DOMException('private timeout message', 'TimeoutError'),
      reason: 'timeout',
      networkCode: undefined,
    },
    {
      name: 'unknown network code',
      error: Object.assign(new Error('private request content'), { code: 'private network code' }),
      reason: 'transport',
      networkCode: undefined,
    },
  ])('permits recovery from $name and logs only safe transport evidence', async (failure) => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    const savedAccounts = harness.accounts.listAccounts();
    harness.save.mockClear();
    harness.request.mockRejectedValueOnce(failure.error);

    expect(await harness.accounts.readSession()).toEqual({
      kind: 'failed',
      message: 'Could not reach the sign-in service.',
      retryable: true,
    });
    expect(harness.accounts.listAccounts()).toEqual(savedAccounts);
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
    expect(harness.save).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('auth.session.failed', {
      stage: 'request',
      reason: failure.reason,
      ...(failure.networkCode === undefined ? {} : { networkCode: failure.networkCode }),
      durationMs: durationMatcher,
    });
  });

  it('permits recovery after interrupted response reading without logging content', async () => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    const savedAccounts = harness.accounts.listAccounts();
    harness.save.mockClear();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private response body and credentials'));
      },
    });
    harness.request.mockResolvedValueOnce(new Response(body));

    expect(await harness.accounts.readSession()).toEqual({
      kind: 'failed',
      message: 'Could not reach the sign-in service.',
      retryable: true,
    });
    expect(harness.accounts.listAccounts()).toEqual(savedAccounts);
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
    expect(harness.save).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('auth.session.failed', {
      stage: 'response-body',
      reason: 'transport',
      status: 200,
      durationMs: durationMatcher,
    });
  });

  it.each([
    {
      body: 'private invalid JSON and credentials',
      stage: 'response-json',
      reason: 'invalid-json',
    },
    {
      body: JSON.stringify({ user: { name: 'private profile', email: 'private@example.test' } }),
      stage: 'response-schema',
      reason: 'invalid-session',
    },
  ])(
    'rejects invalid sessions at $stage without retrying or expiring accounts',
    async (failure) => {
      const harness = createAccounts();
      await harness.accounts.readSession();
      const savedAccounts = harness.accounts.listAccounts();
      harness.save.mockClear();
      harness.request.mockResolvedValueOnce(new Response(failure.body));

      expect(await harness.accounts.readSession()).toEqual({
        kind: 'failed',
        message: 'Could not read your sign-in.',
      });
      expect(harness.accounts.listAccounts()).toEqual(savedAccounts);
      expect(harness.accounts.readCookie()).toBe('teacher-cookie');
      expect(harness.save).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith('auth.session.failed', {
        stage: failure.stage,
        reason: failure.reason,
        status: 200,
        durationMs: durationMatcher,
      });
    },
  );

  it.each([
    { name: 'HTTP 401', response: () => new Response(null, { status: 401 }) },
    { name: 'a null session', response: () => Response.json(null) },
    { name: 'an empty response', response: () => new Response(null) },
  ])('marks $name as signed out without retry permission or failure logs', async (failure) => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    harness.request.mockResolvedValueOnce(failure.response());

    expect(await harness.accounts.readSession()).toEqual({ kind: 'signed-out' });
    expect(harness.accounts.readCookie()).toBeNull();
    expect(harness.accounts.listAccounts().accounts[0]?.requiresSignIn).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('invalidates a session reply that arrives after cancellation', async () => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    harness.accounts.beginSignIn();
    harness.setCookie('student-cookie');
    let finish: (response: Response) => void = () => {};
    harness.request.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = harness.accounts.readSession();
    harness.accounts.cancelSignIn();
    finish(Response.json({ user: student }));
    expect(await pending).toEqual({ kind: 'pending' });
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
  });

  it('signs out only the active session and preserves another saved account', async () => {
    const harness = createAccounts();
    const { teacherAccount } = await saveBothAccounts(harness);
    harness.request.mockResolvedValueOnce(Response.json({ success: true }));
    expect(await harness.accounts.signOut()).toEqual({ kind: 'signed-out' });
    expect(harness.request.mock.lastCall?.[0]).toBe('https://api.example.test/api/auth/sign-out');
    expect(new Headers(harness.request.mock.lastCall?.[1]?.headers).get('cookie')).toBe(
      'student-cookie',
    );
    expect(harness.accounts.listAccounts().accounts.map((account) => account.id)).toEqual([
      teacherAccount.id,
    ]);
    expect(harness.accounts.readCookie()).toBeNull();
    expect((await harness.accounts.switchAccount(teacherAccount.id)).kind).toBe('signed-in');
  });

  it('keeps the saved session when revocation fails', async () => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    harness.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await harness.accounts.signOut()).kind).toBe('failed');
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
    harness.request.mockRejectedValueOnce(new Error('offline'));
    expect((await harness.accounts.signOut()).kind).toBe('failed');
    expect(harness.accounts.listAccounts().accounts).toHaveLength(1);
  });

  it('rejects inconsistent vault metadata', () => {
    expect(
      AccountVaultSchema.safeParse({
        version: 1,
        activeAccountId: '11111111-1111-4111-8111-111111111111',
        accounts: [],
      }).success,
    ).toBe(false);
  });
});
