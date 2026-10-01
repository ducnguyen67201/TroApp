import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

function readSessionPath(): string {
  return join(app.getPath('userData'), 'auth', 'session.bin');
}

function hasProtectedStorage(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  );
}

/** Persists only OS-encrypted session material outside the renderer sandbox. */
export async function saveSessionToken(sessionToken: string): Promise<void> {
  if (!hasProtectedStorage()) {
    throw new Error('Secure credential storage is unavailable.');
  }

  const sessionPath = readSessionPath();
  await mkdir(dirname(sessionPath), { recursive: true, mode: 0o700 });
  await writeFile(sessionPath, safeStorage.encryptString(sessionToken), { mode: 0o600 });
}

export async function readSessionToken(): Promise<string | null> {
  if (!hasProtectedStorage()) {
    return null;
  }

  try {
    return safeStorage.decryptString(await readFile(readSessionPath()));
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return null;
    }

    throw new Error('Stored credentials could not be read.', { cause: error });
  }
}

export async function clearSessionToken(): Promise<void> {
  try {
    await unlink(readSessionPath());
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw new Error('Stored credentials could not be removed.', { cause: error });
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === 'ENOENT'
  );
}
