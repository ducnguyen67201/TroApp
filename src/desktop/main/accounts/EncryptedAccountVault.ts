import { safeStorage } from 'electron';
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountVaultSchema,
  type AccountVault,
  type AccountVaultState,
} from './AccountSessions.js';

/** Main-only device vault. No plaintext fallback; existing files are preserved on read failure. */
export class EncryptedAccountVault implements AccountVault {
  private readonly file: string;
  constructor(private readonly userDataPath: string) {
    this.file = join(userDataPath, 'SavedAccounts');
  }

  read(): AccountVaultState | null {
    let encrypted: Buffer;
    try {
      if (statSync(this.file).size > 1_000_000) {
        throw new Error('Saved account storage is unavailable.');
      }
      encrypted = readFileSync(this.file);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw new Error('Saved account storage is unavailable.', { cause: error });
    }
    this.requireEncryption();
    const data: unknown = JSON.parse(safeStorage.decryptString(encrypted));
    return AccountVaultSchema.parse(data);
  }

  save(state: AccountVaultState): void {
    this.requireEncryption();
    const encrypted = safeStorage.encryptString(JSON.stringify(AccountVaultSchema.parse(state)));
    mkdirSync(this.userDataPath, { recursive: true });
    const temporaryFile = `${this.file}.pending`;
    writeFileSync(temporaryFile, encrypted, { mode: 0o600 });
    renameSync(temporaryFile, this.file);
  }

  private requireEncryption(): void {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    ) {
      throw new Error('Secure account storage is unavailable.');
    }
  }
}
