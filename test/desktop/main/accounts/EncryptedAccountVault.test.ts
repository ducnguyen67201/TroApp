import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountRole } from '#contracts/AccountRole.js';
import { EncryptedAccountVault } from '../../../../src/desktop/main/accounts/EncryptedAccountVault.js';
import type { AccountVaultState } from '../../../../src/desktop/main/accounts/AccountSessions.js';

const native = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn<() => boolean>(() => true),
  getSelectedStorageBackend: vi.fn<() => string>(() => 'keychain'),
  encryptString: vi.fn<(value: string) => Buffer>((value) =>
    Buffer.from(`test-cipher:${Buffer.from(value).toString('base64')}`),
  ),
  decryptString: vi.fn<(value: Buffer) => string>((value) =>
    Buffer.from(value.toString().slice('test-cipher:'.length), 'base64').toString(),
  ),
}));
vi.mock('electron', () => ({ safeStorage: native }));

let directory = '';
const accountId = '11111111-1111-4111-8111-111111111111';
const state: AccountVaultState = {
  version: 1,
  activeAccountId: accountId,
  accounts: [
    {
      id: accountId,
      user: { id: 'test-user', name: 'Teacher', email: 'teacher@example.test' },
      role: AccountRole.TEACHER,
      requiresSignIn: false,
      cookie: 'private-session-cookie',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  native.isEncryptionAvailable.mockReturnValue(true);
  directory = mkdtempSync(join(tmpdir(), 'TroAccounts-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it('delegates encryption to native safeStorage and reads a validated vault', () => {
  const vault = new EncryptedAccountVault(directory);
  expect(vault.read()).toBeNull();
  vault.save(state);
  expect(native.encryptString).toHaveBeenCalledOnce();
  expect(readFileSync(join(directory, 'SavedAccounts'), 'utf8')).not.toContain(
    state.accounts[0]?.cookie,
  );
  expect(statSync(join(directory, 'SavedAccounts')).mode & 0o777).toBe(0o600);
  expect(vault.read()).toEqual(state);
});

it('fails closed without native encryption instead of saving plaintext', () => {
  native.isEncryptionAvailable.mockReturnValue(false);
  const vault = new EncryptedAccountVault(directory);
  expect(() => {
    vault.save(state);
  }).toThrow('Secure account storage is unavailable.');
  expect(native.encryptString).not.toHaveBeenCalled();
  expect(vault.read()).toBeNull();
});

it('preserves a corrupted existing vault instead of resetting it', () => {
  const path = join(directory, 'SavedAccounts');
  const corrupted = Buffer.from('invalid data');
  writeFileSync(path, corrupted);
  const vault = new EncryptedAccountVault(directory);
  expect(() => vault.read()).toThrow();
  expect(readFileSync(path)).toEqual(corrupted);
});
