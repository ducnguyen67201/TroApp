import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ReportFileWriter {
  save(destination: string, content: string, canCommit: () => boolean): Promise<boolean>;
}

/** Keeps the previous destination intact until a complete, still-authorized report is ready. */
export class AtomicReportFile implements ReportFileWriter {
  async save(destination: string, content: string, canCommit: () => boolean): Promise<boolean> {
    const temporary = join(dirname(destination), `.TroParentReport-${randomUUID()}.tmp`);
    try {
      if (!canCommit()) {
        return false;
      }
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (!canCommit()) {
        return false;
      }
      await rename(temporary, destination);
      return true;
    } catch {
      return false;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
