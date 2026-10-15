import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountSessions,
  type AccountVaultState,
} from '../../../../src/desktop/main/accounts/AccountSessions.js';
import { AuthUserSchema } from '#contracts/AuthSession.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import { DesktopAccountLimits } from '#contracts/DesktopAccounts.js';

function learner(mode: StudentDeviceMode = StudentDeviceMode.PERSONAL) {
  return AuthUserSchema.parse({
    id: randomUUID(),
    name: 'Minh',
    email: null,
    isAdmin: false,
    learner: {
      schoolId: randomUUID(),
      schoolName: 'School',
      classId: randomUUID(),
      externalId: '00104a',
      mode,
      provisional: true,
    },
  });
}

function harness() {
  let state: AccountVaultState | null = null;
  const users = new Map<string, ReturnType<typeof learner>>();
  const save = vi.fn<(value: AccountVaultState) => void>((value) => {
    state = structuredClone(value);
  });
  const request = vi.fn<typeof fetch>().mockImplementation((input, options) => {
    const cookie = new Headers(options?.headers).get('cookie') ?? '';
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    if (url.endsWith('/sign-out')) {
      users.delete(cookie);
      return Promise.resolve(Response.json({ kind: 'done' }));
    }
    const user = users.get(cookie);
    return Promise.resolve(
      user
        ? Response.json({
            user,
            role: 'student',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          })
        : Response.json(null, { status: 401 }),
    );
  });
  const vault = { read: () => state, save };
  return {
    accounts: new AccountSessions(vault, () => null, request, 'https://api.example.test'),
    request,
    users,
    save,
    vault,
  };
}

describe('remembered and shared student sessions', () => {
  it('replaces an expired saved student login without duplicating the account even at capacity', async () => {
    const f = harness();
    const student = learner();
    f.users.set('tro_student=original', student);
    await f.accounts.addStudent('tro_student=original', student);
    const originalId = f.accounts.listAccounts().activeAccountId;
    f.users.delete('tro_student=original');
    expect(await f.accounts.readSession()).toEqual({ kind: 'signed-out' });
    for (let index = 1; index < DesktopAccountLimits.MAX_ACCOUNTS; index += 1) {
      const otherStudent = learner();
      const cookie = `tro_student=other-${String(index)}`;
      f.users.set(cookie, otherStudent);
      await f.accounts.addStudent(cookie, otherStudent);
    }
    const before = f.accounts.listAccounts();
    f.users.set('tro_student=recovered', student);
    expect((await f.accounts.addStudent('tro_student=recovered', student)).kind).toBe('signed-in');
    expect(f.accounts.listAccounts().accounts).toHaveLength(DesktopAccountLimits.MAX_ACCOUNTS);
    expect(f.accounts.listAccounts().activeAccountId).toBe(originalId);
    expect(
      f.accounts.listAccounts().accounts.find((account) => account.id === originalId)
        ?.requiresSignIn,
    ).toBe(false);
    expect(f.accounts.readCookie()).toBe('tro_student=recovered');
    expect(
      f.accounts.listAccounts().accounts.filter((account) => account.id !== originalId),
    ).toEqual(before.accounts.filter((account) => account.id !== originalId));
    const extraStudent = learner();
    f.users.set('tro_student=extra', extraStudent);
    expect((await f.accounts.addStudent('tro_student=extra', extraStudent)).kind).toBe('failed');
    const restarted = new AccountSessions(
      f.vault,
      () => null,
      f.request,
      'https://api.example.test',
    );
    expect(await restarted.readSession()).toEqual({ kind: 'signed-in', user: student });
  });

  it('remembers independent learner credentials, verifies switching and never exposes secrets', async () => {
    const f = harness();
    const first = learner();
    const second = learner();
    f.users.set('tro_student=first', first);
    f.users.set('tro_student=second', second);
    expect((await f.accounts.addStudent('tro_student=first', first)).kind).toBe('signed-in');
    expect((await f.accounts.addStudent('tro_student=second', second)).kind).toBe('signed-in');
    expect(f.vault.read()?.version).toBe(2);
    const row = f.accounts.listAccounts().accounts.find((account) => account.user.id === first.id);
    if (!row) {
      throw new Error('Missing remembered account.');
    }
    expect(JSON.stringify(f.accounts.listAccounts())).not.toContain('tro_student');
    expect((await f.accounts.switchAccount(row.id)).kind).toBe('signed-in');
    const restarted = new AccountSessions(
      f.vault,
      () => null,
      f.request,
      'https://api.example.test',
    );
    expect(await restarted.readSession()).toEqual({ kind: 'signed-in', user: first });
    await restarted.signOut();
    expect(restarted.listAccounts().accounts).toHaveLength(1);
    expect(restarted.listAccounts().activeAccountId).toBeNull();
    expect(restarted.readCookie()).toBeNull();
  });

  it('keeps the original account after failed student verification', async () => {
    const f = harness();
    const first = learner();
    f.users.set('tro_student=first', first);
    await f.accounts.addStudent('tro_student=first', first);
    const before = f.accounts.listAccounts();
    expect((await f.accounts.addStudent('tro_student=invalid', learner())).kind).toBe('failed');
    expect(f.accounts.listAccounts()).toEqual(before);
    expect(f.accounts.readCookie()).toBe('tro_student=first');
  });

  it('selects a verified student only after local cleanup succeeds', async () => {
    const f = harness();
    const first = learner();
    const second = learner();
    f.users.set('tro_student=first', first);
    f.users.set('tro_student=second', second);
    await f.accounts.addStudent('tro_student=first', first);
    const before = f.accounts.listAccounts();
    await expect(
      f.accounts.addStudent('tro_student=second', second, () =>
        Promise.reject(new Error('Synthetic worker shutdown failure')),
      ),
    ).rejects.toThrow();
    expect(f.accounts.listAccounts()).toEqual(before);
    const cleanup = vi.fn<() => Promise<void>>(() => {
      expect(f.accounts.readCookie()).toBe('tro_student=first');
      return Promise.resolve();
    });
    expect((await f.accounts.addStudent('tro_student=second', second, cleanup)).kind).toBe(
      'signed-in',
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.accounts.readCookie()).toBe('tro_student=second');
  });

  it('stores shared credentials only in memory and rejects personal account mixing', async () => {
    const f = harness();
    f.accounts.configureStudentMode(true);
    const user = learner(StudentDeviceMode.SHARED);
    f.users.set('tro_student=shared', user);
    await f.accounts.addStudent('tro_student=shared', user);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.accounts.listAccounts().accounts).toHaveLength(1);
    expect((await f.accounts.switchAccount(randomUUID())).kind).toBe('failed');
    const restarted = new AccountSessions(
      f.vault,
      () => null,
      f.request,
      'https://api.example.test',
    );
    restarted.configureStudentMode(true);
    expect(await restarted.readSession()).toEqual({ kind: 'signed-out' });
    await f.accounts.signOut();
    expect(f.accounts.listAccounts().accounts).toEqual([]);
    expect(f.save).not.toHaveBeenCalled();
    const personal = harness();
    const remembered = learner();
    personal.users.set('tro_student=personal', remembered);
    await personal.accounts.addStudent('tro_student=personal', remembered);
    expect(() => {
      personal.accounts.configureStudentMode(true);
    }).toThrow();
  });

  it('removes a local student login even if revocation cannot reach the server', async () => {
    const f = harness();
    const user = learner();
    f.users.set('tro_student=personal', user);
    await f.accounts.addStudent('tro_student=personal', user);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.request.mockRejectedValueOnce(new Error('Synthetic transport failure'));
    expect(await f.accounts.signOut()).toEqual({ kind: 'signed-out' });
    expect(f.accounts.readCookie()).toBeNull();
    expect(f.accounts.listAccounts().accounts).toEqual([]);
    warning.mockRestore();
  });
});
