import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readlink, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readProcessListEnv } from './Env.js';

const executeFile = promisify(execFile);
const processSchema = z.strictObject({
  pid: z.number().int().positive(),
  parentId: z.number().int().nonnegative(),
  groupId: z.number().int().positive(),
  startedAt: z.string().min(1),
  command: z.string(),
  executable: z.string().min(1),
});
const commandLimits = { timeout: 5000, maxBuffer: 8 * 1024 * 1024 };
const shutdownGraceMs = 2000;
const shutdownForceMs = 1000;

export type DevelopmentProcess = z.infer<typeof processSchema>;

const ProcessMetadataSource = {
  EXECUTABLES: 'executables',
  PROCESSES: 'processes',
} as const;

/** Safe record shape only: never retain process arguments, paths or raw tool output. */
export class DevelopmentProcessMetadataError extends Error {
  readonly diagnostic;

  constructor(
    source: (typeof ProcessMetadataSource)[keyof typeof ProcessMetadataSource],
    line: string,
    recordNumber: number,
  ) {
    super('Development process metadata is unavailable.');
    const pid = Number(/^\s*(\d+)(?:\s|$)/.exec(line)?.[1]);
    this.diagnostic = {
      source,
      recordNumber,
      recordLength: line.length,
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      hasStartTime: /\d{2}:\d{2}:\d{2}\s+\d{4}/.test(line),
    };
  }
}

/** Process metadata stays local: command arguments can contain private desktop URLs. */
export function parseDevelopmentProcesses(
  output: string,
  executables: string,
): DevelopmentProcess[] {
  const names = new Map<number, string>();
  for (const [index, line] of executables.trim().split('\n').filter(Boolean).entries()) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) {
      throw new DevelopmentProcessMetadataError(ProcessMetadataSource.EXECUTABLES, line, index + 1);
    }
    names.set(Number(match[1]), match[2] ?? '');
  }
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line, index) => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\S+)\s+)?(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
          line,
        );
      if (!match) {
        throw new DevelopmentProcessMetadataError(ProcessMetadataSource.PROCESSES, line, index + 1);
      }
      const executable = names.get(Number(match[1]));
      // Snapshots may straddle an exit; zombies and kernel tasks cannot own development groups.
      if (!executable || match[4]?.startsWith('Z') || Number(match[3]) === 0) {
        return [];
      }
      return [
        processSchema.parse({
          pid: Number(match[1]),
          parentId: Number(match[2]),
          groupId: Number(match[3]),
          startedAt: match[5]?.replace(/\s+/g, ' '),
          command: match[6],
          executable,
        }),
      ];
    });
}

/** Protect the invoking shell, this launcher and its new children even when roots overlap. */
export function selectDevelopmentProcesses(
  processes: readonly DevelopmentProcess[],
  currentPid: number,
  workspaceProcessIds: ReadonlySet<number>,
): DevelopmentProcess[] {
  const protectedIds = new Set([currentPid]);
  let ancestor = processes.find((item) => item.pid === currentPid);
  if (!ancestor) {
    throw new Error('The development launcher could not identify itself.');
  }
  while (ancestor && !protectedIds.has(ancestor.parentId)) {
    protectedIds.add(ancestor.parentId);
    ancestor = processes.find((item) => item.pid === ancestor?.parentId);
  }
  addDescendants(processes, new Set([currentPid]), protectedIds);
  const selectedIds = new Set([...workspaceProcessIds].filter((pid) => !protectedIds.has(pid)));
  addDescendants(processes, selectedIds, selectedIds, protectedIds);
  return [
    ...new Map(
      processes.filter((item) => selectedIds.has(item.pid)).map((item) => [item.pid, item]),
    ).values(),
  ];
}

function addDescendants(
  processes: readonly DevelopmentProcess[],
  roots: Set<number>,
  destination: Set<number>,
  excluded: ReadonlySet<number> = new Set(),
): void {
  const descendants = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (descendants.has(item.parentId) && !descendants.has(item.pid) && !excluded.has(item.pid)) {
        descendants.add(item.pid);
        destination.add(item.pid);
        changed = true;
      }
    }
  }
}

async function readProcesses(): Promise<DevelopmentProcess[]> {
  if (process.platform === 'win32') {
    const script =
      "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate } | ForEach-Object { @{ pid = [int]$_.ProcessId; parentId = [int]$_.ParentProcessId; groupId = [int]$_.ProcessId; startedAt = $_.CreationDate.ToUniversalTime().ToString('o'); command = [string]$_.CommandLine; executable = [string]$_.Name } })";
    const result = await executeFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      commandLimits,
    );
    const value: unknown = JSON.parse(result.stdout);
    return z.array(processSchema).parse(value);
  }
  const processListOptions = { ...commandLimits, env: readProcessListEnv() };
  const metadata = await executeFile(
    'ps',
    ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='],
    processListOptions,
  );
  const executables =
    process.platform === 'darwin'
      ? (await executeFile('ps', ['-axo', 'pid=,comm='], processListOptions)).stdout
      : await readLinuxProcessExecutables(metadata.stdout);
  return parseDevelopmentProcesses(metadata.stdout, executables);
}

/** Linux comm is a mutable thread name (Node 24 uses MainThread), not an executable identity. */
async function readLinuxProcessExecutables(metadata: string): Promise<string> {
  const executables = await Promise.all(
    metadata
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(async (line, index) => {
        const pid = /^\s*(\d+)\s/.exec(line)?.[1];
        if (pid === undefined) {
          throw new DevelopmentProcessMetadataError(
            ProcessMetadataSource.PROCESSES,
            line,
            index + 1,
          );
        }
        try {
          return `${pid} ${await readlink(`/proc/${pid}/exe`)}`;
        } catch {
          // Exited, kernel and inaccessible processes have no usable executable identity.
          return '';
        }
      }),
  );
  return executables.filter(Boolean).join('\n');
}

function isDevelopmentEntry(item: DevelopmentProcess, workspace: string): boolean {
  const name = basename(item.executable)
    .toLowerCase()
    .replace(/\.exe$/, '');
  const command = item.command.replaceAll('\\', '/');
  const directory = workspace.replaceAll('\\', '/');
  if (['electron', 'tro'].includes(name)) {
    return (
      command.includes(`${directory}/.tro-development/`) ||
      command.includes(`${directory}/node_modules/electron/`)
    );
  }
  if (
    !['node', 'nodejs', 'tsx', 'pnpm', 'doppler'].includes(name) ||
    /(?:^|\s)(?:--eval|-e|--print|-p)(?:\s|=|$)/.test(command)
  ) {
    return false;
  }
  return (
    /(?:^|[\s/])(?:scripts\/Start(?:Development|Desktop)\.ts|src\/server\/StartApi\.ts)(?:[\s"']|$)/.test(
      command,
    ) ||
    /(?:^|[\s/])electron-vite(?:\/bin\/electron-vite\.js)?(?:[\s"']|$)/.test(command) ||
    /(?:^|[\s/])pnpm(?:\.(?:mjs|cjs|js))?\s+(?:run\s+)?dev(?::(?:api|desktop))?(?:\s|$)/.test(
      command,
    )
  );
}

async function usesWorkspace(item: DevelopmentProcess, workspace: string): Promise<boolean> {
  if (process.platform === 'win32') {
    // Windows provides no CWD in Win32_Process: only explicit checkout paths establish ownership.
    return item.command
      .replaceAll('\\', '/')
      .toLowerCase()
      .includes(`${workspace.replaceAll('\\', '/').toLowerCase()}/`);
  }
  try {
    const directory =
      process.platform === 'darwin'
        ? (
            await executeFile(
              'lsof',
              ['-a', '-p', String(item.pid), '-d', 'cwd', '-Fn'],
              commandLimits,
            )
          ).stdout
            .split('\n')
            .find((line) => line.startsWith('n'))
            ?.slice(1)
        : await readlink(`/proc/${String(item.pid)}/cwd`);
    return directory !== undefined && (await realpath(directory)) === workspace;
  } catch {
    // Exited or inaccessible processes are never selected by a name/port fallback.
    return false;
  }
}

function hasSameIdentity(left: DevelopmentProcess, right: DevelopmentProcess): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

async function signalProcesses(
  processes: DevelopmentProcess[],
  signal: NodeJS.Signals,
  groups: boolean,
): Promise<void> {
  const current = await readProcesses();
  const alive = processes.filter((item) =>
    current.some(
      (candidate) =>
        hasSameIdentity(item, candidate) && (!groups || candidate.groupId === item.groupId),
    ),
  );
  const ids = new Set(alive.map((item) => (groups ? item.groupId : item.pid)));
  await Promise.all(
    [...ids].map(async (pid) => {
      try {
        if (process.platform === 'win32') {
          await executeFile(
            'taskkill.exe',
            ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
            commandLimits,
          );
        } else {
          process.kill(groups ? -pid : pid, signal);
        }
      } catch (error: unknown) {
        if (process.platform === 'win32') {
          return; // Rechecked below; taskkill also reports already-exited children as errors.
        }
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw new Error('A previous development process could not be stopped.', { cause: error });
        }
      }
    }),
  );
}

async function waitForProcesses(
  processes: DevelopmentProcess[],
  timeoutMs: number,
): Promise<DevelopmentProcess[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = processes;
  do {
    const current = await readProcesses();
    remaining = remaining.filter((item) =>
      current.some((candidate) => hasSameIdentity(item, candidate)),
    );
    if (!remaining.length) {
      return [];
    }
    await delay(100);
  } while (Date.now() < deadline);
  return remaining;
}

async function stopProcesses(processes: DevelopmentProcess[], groups = false): Promise<void> {
  if (!processes.length) {
    return;
  }
  await signalProcesses(processes, 'SIGTERM', groups);
  const remaining = await waitForProcesses(processes, shutdownGraceMs);
  await signalProcesses(remaining, 'SIGKILL', groups);
  if ((await waitForProcesses(remaining, shutdownForceMs)).length) {
    throw new Error(
      'Previous development processes are still running. Close their terminal and retry.',
    );
  }
}

/** Native CLI trees are owned by this checkout. Containers and unrelated port owners are untouched. */
export async function createDevelopmentProcessGroup(workspace: string): Promise<{
  stopPrevious(): Promise<void>;
  spawn(command: string, args: string[], environment: NodeJS.ProcessEnv): ChildProcess;
  close(): Promise<void>;
}> {
  const directory = await realpath(workspace);
  const children: { child: ChildProcess; members: Promise<DevelopmentProcess[]> }[] = [];
  let closing: Promise<void> | null = null;

  function isClosing(): boolean {
    return closing !== null;
  }

  return {
    async stopPrevious() {
      if (isClosing()) {
        return;
      }
      const processes = await readProcesses();
      const candidates = await Promise.all(
        processes.map(async (item) =>
          isDevelopmentEntry(item, directory) && (await usesWorkspace(item, directory))
            ? item.pid
            : null,
        ),
      );
      const targets = selectDevelopmentProcesses(
        processes,
        process.pid,
        new Set(candidates.filter((pid) => pid !== null)),
      );
      if (isClosing()) {
        return;
      }
      await stopProcesses(targets);
      if (targets.length) {
        console.info(`Stopped ${String(targets.length)} previous Tro development processes.`);
      }
    },
    spawn(command, args, environment) {
      if (isClosing()) {
        throw new Error('Development startup has already stopped.');
      }
      const child = spawn(command, args, {
        cwd: directory,
        stdio: 'inherit',
        env: environment,
        detached: process.platform !== 'win32',
      });
      const members = readProcesses().then((processes) => {
        if (process.platform !== 'win32') {
          return processes.filter((item) => item.groupId === child.pid);
        }
        const ids = new Set(child.pid === undefined ? [] : [child.pid]);
        addDescendants(processes, ids, ids);
        return processes.filter((item) => ids.has(item.pid));
      });
      void members.catch(() => undefined);
      children.push({ child, members });
      return child;
    },
    close() {
      closing ??= (async () => {
        const initial = (await Promise.all(children.map((item) => item.members))).flat();
        const current = await readProcesses();
        const ownedGroups = new Set(
          initial
            .filter((item) =>
              current.some(
                (candidate) =>
                  hasSameIdentity(item, candidate) && candidate.groupId === item.groupId,
              ),
            )
            .map((item) => item.groupId),
        );
        // A wrapper may have exited. Recognizable survivors still need explicit checkout ownership.
        for (const item of current) {
          if (
            children.some(({ child }) => child.pid === item.groupId) &&
            isDevelopmentEntry(item, directory) &&
            (await usesWorkspace(item, directory))
          ) {
            ownedGroups.add(item.groupId);
          }
        }
        const targets =
          process.platform === 'win32'
            ? initial.filter((item) =>
                current.some((candidate) => hasSameIdentity(item, candidate)),
              )
            : current.filter((item) => ownedGroups.has(item.groupId));
        await stopProcesses(targets, process.platform !== 'win32');
      })();
      return closing;
    },
  };
}
