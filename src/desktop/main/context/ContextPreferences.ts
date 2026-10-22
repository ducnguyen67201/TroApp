import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** Persist opt-out locally so an offline disable survives restart and cannot silently re-enable. */
export class ContextPreferences {
  constructor(private readonly directory: string) {}

  private readPath(ownerId: string): string {
    return join(this.directory, createHash('sha256').update(ownerId).digest('hex'));
  }

  async read(ownerId: string): Promise<boolean | null> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.readPath(ownerId), 'utf8'));
      return z.strictObject({ enabled: z.boolean() }).parse(raw).enabled;
    } catch {
      return null;
    }
  }

  async save(ownerId: string, enabled: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.readPath(ownerId);
    await writeFile(`${file}.pending`, JSON.stringify({ enabled }), { mode: 0o600 });
    await rename(`${file}.pending`, file);
  }
}
