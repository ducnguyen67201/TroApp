import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const executeFile = promisify(execFile);
const WindowsProcessSchema = z.strictObject({
  pid: z.int().nonnegative(),
  parentId: z.int().nonnegative(),
  startedAt: z.string().min(1),
  privateCommittedBytes: z.int().nonnegative().nullable(),
  workingSetBytes: z.int().nonnegative().nullable(),
});
const WindowsSnapshotSchema = z.strictObject({
  before: z.array(WindowsProcessSchema),
  after: z.array(WindowsProcessSchema),
});
type WindowsProcess = z.infer<typeof WindowsProcessSchema>;

function selectOwnedProcesses(rows: WindowsProcess[], rootPid: number): WindowsProcess[] {
  const owned = new Set([rootPid]);
  if (
    new Set(rows.map((row) => row.pid)).size !== rows.length ||
    !rows.some((row) => row.pid === rootPid)
  ) {
    throw new Error('The Windows desktop process tree is unavailable.');
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.parentId) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => owned.has(row.pid)).sort((left, right) => left.pid - right.pid);
}

/** Reject partial or changing samples; private commit is distinct from shared working sets. */
export function readWindowsDesktopMemory(output: string, rootPid: number, expectedStart?: string) {
  const raw: unknown = JSON.parse(output.replace(/^\uFEFF/, ''));
  const snapshot = WindowsSnapshotSchema.parse(raw);
  const before = selectOwnedProcesses(snapshot.before, rootPid);
  const after = selectOwnedProcesses(snapshot.after, rootPid);
  const root = before.find((row) => row.pid === rootPid);
  if (!root || (expectedStart !== undefined && expectedStart !== root.startedAt)) {
    throw new Error('The desktop process ID was reused; choose the new root PID.');
  }
  const identity = (rows: WindowsProcess[]): string =>
    JSON.stringify(rows.map(({ pid, parentId, startedAt }) => ({ pid, parentId, startedAt })));
  if (identity(before) !== identity(after)) {
    throw new Error(
      'The desktop process tree changed during measurement; retry with a stable app.',
    );
  }
  const processes = before.map((row) => {
    if (row.privateCommittedBytes === null || row.workingSetBytes === null) {
      throw new Error('A Windows memory counter is unavailable; no total was reported.');
    }
    return {
      ...row,
      privateCommittedBytes: row.privateCommittedBytes,
      workingSetBytes: row.workingSetBytes,
    };
  });
  return {
    startedAt: root.startedAt,
    privateCommittedBytes: processes.reduce((sum, row) => sum + row.privateCommittedBytes, 0),
    summedWorkingSetBytes: processes.reduce((sum, row) => sum + row.workingSetBytes, 0),
    processes,
  };
}

/* No names, command lines, credentials or process environments are collected.
   CIM identity is checked against Get-Process to reject PID reuse during each pass. */
const snapshotScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Read-Processes {
  @(Get-CimInstance Win32_Process | ForEach-Object {
    $created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') } else { 'unknown' }
    $private = $null
    $working = $null
    try {
      $observed = Get-Process -Id $_.ProcessId -ErrorAction Stop
      if ($observed.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') -eq $created) {
        $private = $observed.PrivateMemorySize64
        $working = $observed.WorkingSet64
      }
    } catch {}
    [pscustomobject]@{ pid = [int]$_.ProcessId; parentId = [int]$_.ParentProcessId; startedAt = $created; privateCommittedBytes = $private; workingSetBytes = $working }
  })
}
$before = @(Read-Processes)
$after = @(Read-Processes)
[pscustomobject]@{ before = $before; after = $after } | ConvertTo-Json -Depth 4 -Compress
`;

export async function measureWindowsDesktopMemory(rootPid: number, expectedStart?: string) {
  const { stdout } = await executeFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', snapshotScript],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  return readWindowsDesktopMemory(stdout, rootPid, expectedStart);
}
