import { safeStorage } from 'electron';
import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { StudentDeviceCredentialSchema } from '#contracts/StudentAccess.js';
import type { z } from 'zod';

export interface StudentDeviceStorage {
  read(): z.infer<typeof StudentDeviceCredentialSchema> | null;
  save(device: z.infer<typeof StudentDeviceCredentialSchema>): void;
  clear(): void;
}

/** Device admission is independent of the personal login vault; credentials never cross preload. */
export class EncryptedStudentDevice implements StudentDeviceStorage {
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = join(directory, 'StudentDevice');
  }

  read(): z.infer<typeof StudentDeviceCredentialSchema> | null {
    if (!existsSync(this.file)) {
      return null;
    }
    this.requireEncryption();
    if (statSync(this.file).size > 16_000) {
      throw new Error('Secure device storage is unavailable.');
    }
    const value: unknown = JSON.parse(safeStorage.decryptString(readFileSync(this.file)));
    return StudentDeviceCredentialSchema.parse(value);
  }

  save(device: z.infer<typeof StudentDeviceCredentialSchema>): void {
    this.requireEncryption();
    const bytes = safeStorage.encryptString(
      JSON.stringify(StudentDeviceCredentialSchema.parse(device)),
    );
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(`${this.file}.pending`, bytes, { mode: 0o600 });
    renameSync(`${this.file}.pending`, this.file);
  }

  clear(): void {
    rmSync(this.file, { force: true });
    rmSync(`${this.file}.pending`, { force: true });
  }

  private requireEncryption(): void {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    ) {
      throw new Error('Secure device storage is unavailable.');
    }
  }
}
