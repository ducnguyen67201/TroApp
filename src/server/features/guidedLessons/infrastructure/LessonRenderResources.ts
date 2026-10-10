import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
export interface LessonProcess {
  pid: number;
  parentId: number;
  residentBytes: number;
}

/** Match only the renderer and its descendants. Process listings contain numeric metadata, never arguments. */
export function readLessonProcesses(text: string, rootPid: number): LessonProcess[] {
  const rows = text
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pid, parentId, residentKiB] = line.trim().split(/\s+/).map(Number);
      return pid !== undefined &&
        parentId !== undefined &&
        residentKiB !== undefined &&
        [pid, parentId, residentKiB].every(Number.isSafeInteger) &&
        pid > 0 &&
        parentId >= 0 &&
        residentKiB >= 0
        ? [{ pid, parentId, residentBytes: residentKiB * 1024 }]
        : [];
    });
  const ownedIds = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ownedIds.has(row.parentId) && !ownedIds.has(row.pid)) {
        ownedIds.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => ownedIds.has(row.pid));
}

export async function inspectLessonProcesses(rootPid: number): Promise<LessonProcess[]> {
  const result = await executeFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], {
    timeout: 3000,
    maxBuffer: 1024 * 1024,
  });
  return readLessonProcesses(result.stdout, rootPid);
}
