import { describe, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import {
  AccountSessions,
  AccountVaultSchema,
  type AccountSessionVerificationFailure,
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
  const writeVerificationFailure = vi.fn<(event: AccountSessionVerificationFailure) => void>();
  const accounts = new AccountSessions(
    { read: () => state, save },
    () => loginCookie,
    request,
    'https://api.example.test',
    () => now,
    writeVerificationFailure,
  );
  return {
    accounts,
    request,
    save,
    writeVerificationFailure,
    setCookie: (value: string | null) => {
      loginCookie = value;
    },
    advanceTime: () => {
      now += 120_001;
    },
    readState: () => state,
  };
}

function restartAccounts(harness: ReturnType<typeof createAccounts>): AccountSessions {
  return new AccountSessions(
    { read: harness.readState, save: harness.save },
    () => 'unrelated-staging-cookie',
    harness.request,
    'https://api.example.test',
    () => 0,
    harness.writeVerificationFailure,
  );
}

function readVerificationElapsedMs(event: unknown): number {
  if (
    typeof event !== 'object' ||
    event === null ||
    !('elapsedMs' in event) ||
    typeof event.elapsedMs !== 'number'
  ) {
    throw new Error('Expected numeric verification timing.');
  }
  expect(Number.isInteger(event.elapsedMs)).toBe(true);
  expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
  return event.elapsedMs;
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
  it('migrates the existing login and exposes metadata without credentials', async () => {
    const harness = createAccounts();
    expect(await harness.accounts.readSession()).toEqual({
      kind: 'signed-in',
      user: { id: teacher.id, name: teacher.name, email: teacher.email },
    });
    const saved = harness.accounts.listAccounts();
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0]?.role).toBe(AccountRole.TEACHER);
    expect(JSON.stringify(saved)).not.toContain('cookie');
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
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

  it.each([
    ['http', 'http', 'http-error', 503, 'Could not check your sign-in.'],
    ['schema', 'response', 'invalid-response', 200, 'Could not read your sign-in.'],
    ['json', 'response', 'invalid-response', 200, 'Could not reach the sign-in service.'],
    ['network', 'request', 'request-failed', null, 'Could not reach the sign-in service.'],
  ] as const)(
    'preserves a saved session after restart during a %s failure and recovers',
    async (mode, stage, reason, httpStatus, message) => {
      const harness = createAccounts();
      await harness.accounts.readSession();
      const saved = harness.accounts.listAccounts();
      const state = structuredClone(harness.readState());
      harness.save.mockClear();
      const restarted = restartAccounts(harness);
      const privateDetails = `teacher-cookie ${teacher.email} https://api.example.test/private`;
      const failVerification = (): void => {
        if (mode === 'network') {
          harness.request.mockRejectedValueOnce(new Error(privateDetails));
        } else if (mode === 'http') {
          harness.request.mockResolvedValueOnce(new Response(privateDetails, { status: 503 }));
        } else if (mode === 'json') {
          harness.request.mockResolvedValueOnce(new Response(privateDetails));
        } else {
          harness.request.mockResolvedValueOnce(
            Response.json({ user: { name: privateDetails, email: teacher.email } }),
          );
        }
      };
      failVerification();
      expect(await restarted.readSession()).toEqual({ kind: 'failed', message });
      failVerification();
      expect(await restarted.readSession()).toEqual({ kind: 'failed', message });
      expect(restarted.readCookie()).toBe('teacher-cookie');
      expect(restarted.listAccounts()).toEqual(saved);
      expect(harness.readState()).toEqual(state);
      expect(harness.save).not.toHaveBeenCalled();
      expect(harness.writeVerificationFailure).toHaveBeenCalledExactlyOnceWith({
        stage,
        reason,
        ...(httpStatus === null ? {} : { httpStatus }),
        elapsedMs: readVerificationElapsedMs(harness.writeVerificationFailure.mock.calls[0]?.[0]),
        hasSavedAccount: true,
      });
      const diagnostics = JSON.stringify(harness.writeVerificationFailure.mock.calls);
      expect(diagnostics).not.toContain('teacher-cookie');
      expect(diagnostics).not.toContain(teacher.email);
      expect(diagnostics).not.toContain('api.example.test');
      expect(diagnostics).not.toContain('unrelated-staging-cookie');

      expect(await restarted.readSession()).toEqual({
        kind: 'signed-in',
        user: { id: teacher.id, name: teacher.name, email: teacher.email },
      });
      expect(restarted.listAccounts()).toEqual(saved);
      expect(harness.writeVerificationFailure).toHaveBeenCalledTimes(1);
      failVerification();
      expect(await restarted.readSession()).toEqual({ kind: 'failed', message });
      expect(harness.writeVerificationFailure).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['unauthorized', 'empty', 'null'] as const)(
    'expires an active saved session for an %s reply and resets failure diagnostics',
    async (mode) => {
      const harness = createAccounts();
      await harness.accounts.readSession();
      const saved = harness.accounts.listAccounts();
      const accountId = saved.activeAccountId;
      if (!accountId) {
        throw new Error('Expected the saved teacher account.');
      }
      const restarted = restartAccounts(harness);
      harness.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
      expect((await restarted.readSession()).kind).toBe('failed');
      harness.request.mockResolvedValueOnce(
        mode === 'unauthorized'
          ? new Response(null, { status: 401 })
          : mode === 'empty'
            ? new Response(null)
            : Response.json(null),
      );
      expect(await restarted.readSession()).toEqual({ kind: 'signed-out' });
      expect(restarted.readCookie()).toBeNull();
      expect(restarted.listAccounts()).toEqual({
        ...saved,
        accounts: saved.accounts.map((account) => ({ ...account, requiresSignIn: true })),
      });
      expect(harness.writeVerificationFailure).toHaveBeenCalledTimes(1);
      harness.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
      expect((await restarted.switchAccount(accountId)).kind).toBe('failed');
      expect(harness.writeVerificationFailure).toHaveBeenCalledTimes(2);
    },
  );

  it('logs a changed HTTP refusal and identifies a cookie that has not been saved', async () => {
    const harness = createAccounts();
    harness.request.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await harness.accounts.readSession()).kind).toBe('failed');
    harness.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await harness.accounts.readSession()).kind).toBe('failed');
    expect(harness.writeVerificationFailure.mock.calls.map(([event]) => event)).toEqual([
      {
        stage: 'http',
        reason: 'http-error',
        httpStatus: 404,
        elapsedMs: readVerificationElapsedMs(harness.writeVerificationFailure.mock.calls[0]?.[0]),
        hasSavedAccount: false,
      },
      {
        stage: 'http',
        reason: 'http-error',
        httpStatus: 503,
        elapsedMs: readVerificationElapsedMs(harness.writeVerificationFailure.mock.calls[1]?.[0]),
        hasSavedAccount: false,
      },
    ]);
    expect(harness.accounts.listAccounts().accounts).toEqual([]);
  });

  it('emits the named safe diagnostic by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const accounts = new AccountSessions(
        { read: () => null, save: vi.fn<(value: AccountVaultState) => void>() },
        () => 'private-cookie',
        vi.fn<typeof fetch>().mockResolvedValue(new Response('private-response', { status: 404 })),
        'https://api.example.test',
      );
      expect((await accounts.readSession()).kind).toBe('failed');
      expect(warn).toHaveBeenCalledExactlyOnceWith('auth.session.verification.failed', {
        stage: 'http',
        reason: 'http-error',
        httpStatus: 404,
        elapsedMs: readVerificationElapsedMs(warn.mock.calls[0]?.[1]),
        hasSavedAccount: false,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves verification behavior when the diagnostic sink throws', async () => {
    const harness = createAccounts();
    await harness.accounts.readSession();
    harness.writeVerificationFailure.mockImplementation(() => {
      throw new Error('Diagnostic sink unavailable.');
    });
    harness.request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await harness.accounts.readSession()).toEqual({
      kind: 'failed',
      message: 'Could not check your sign-in.',
    });
    expect(harness.accounts.readCookie()).toBe('teacher-cookie');
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
