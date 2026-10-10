import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';

const executeFile = promisify(execFile);
const memoryBudgetBytes = 1_000_000_000;
const usage = 'Use --pid PID [--duration-seconds 0..3600] [--interval-seconds 1..60].';
const ProcessSchema = z.strictObject({
  pid: z.int().positive(),
  parentId: z.int().nonnegative(),
  startedAt: z.string().min(1),
});
const OptionsSchema = z.strictObject({
  pid: z.coerce.number().pipe(z.int().positive()),
  durationSeconds: z.coerce.number().pipe(z.int().min(0).max(3600)),
  intervalSeconds: z.coerce.number().pipe(z.int().min(1).max(60)),
});

type DesktopProcess = z.infer<typeof ProcessSchema>;
type MemoryOptions = z.infer<typeof OptionsSchema>;

/** Accept only an explicit root and a finite sampling window. */
export function parseDesktopMemoryOptions(args: string[]): MemoryOptions {
  try {
    const { values } = parseArgs({
      args,
      options: {
        pid: { type: 'string' },
        'duration-seconds': { type: 'string', default: '0' },
        'interval-seconds': { type: 'string', default: '5' },
      },
    });
    return OptionsSchema.parse({
      pid: values.pid,
      durationSeconds: values['duration-seconds'],
      intervalSeconds: values['interval-seconds'],
    });
  } catch {
    throw new Error(usage);
  }
}

/** Read numeric ownership and opaque start times; command arguments are never collected. */
export function readDesktopProcessTree(output: string, rootPid: number): DesktopProcess[] {
  const rows = output
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) {
        throw new Error('Desktop process metadata is unavailable.');
      }
      return ProcessSchema.parse({
        pid: Number(match[1]),
        parentId: Number(match[2]),
        startedAt: match[3],
      });
    });
  if (!rows.some((row) => row.pid === rootPid)) {
    throw new Error('The requested desktop process has exited or is unavailable.');
  }
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
  return rows.filter((row) => ownedIds.has(row.pid)).sort((left, right) => left.pid - right.pid);
}

/** Include compressed memory by using macOS's exact physical-footprint counters. */
export function readDesktopFootprints(
  output: string,
  processIds: number[],
): { pid: number; physicalFootprintBytes: number }[] {
  const footprints = new Map<number, number>();
  let currentPid: number | undefined;
  for (const line of output.split('\n')) {
    const heading = /^.+ \[(\d+)\]:/.exec(line);
    if (heading) {
      currentPid = Number(heading[1]);
    }
    const value = /^\s+phys_footprint:\s+(\d+) B\s*$/.exec(line);
    if (value && currentPid !== undefined) {
      const bytes = Number(value[1]);
      if (!Number.isSafeInteger(bytes) || footprints.has(currentPid)) {
        throw new Error('Desktop physical-footprint counters are invalid.');
      }
      footprints.set(currentPid, bytes);
    }
  }
  return processIds.map((pid) => {
    const physicalFootprintBytes = footprints.get(pid);
    if (physicalFootprintBytes === undefined) {
      throw new Error(
        'A desktop physical-footprint counter is unavailable; no total was reported.',
      );
    }
    return { pid, physicalFootprintBytes };
  });
}

async function inspectDesktopProcessTree(pid: number): Promise<DesktopProcess[]> {
  let output: string;
  try {
    ({ stdout: output } = await executeFile('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw new Error('The macOS process listing is unavailable.');
  }
  return readDesktopProcessTree(output, pid);
}

/** A changing tree invalidates the sample, including any process-ID reuse. */
async function measureDesktopMemory(
  pid: number,
  startedAt: string,
): Promise<ReturnType<typeof readDesktopFootprints>> {
  const before = await inspectDesktopProcessTree(pid);
  if (before.find((row) => row.pid === pid)?.startedAt !== startedAt) {
    throw new Error('The requested desktop process ID was reused; choose the new root PID.');
  }
  let output: string;
  try {
    ({ stdout: output } = await executeFile(
      '/usr/bin/footprint',
      ['-f', 'bytes', '--noCategories', ...before.flatMap((row) => ['-p', String(row.pid)])],
      { timeout: 10000, maxBuffer: 1024 * 1024 },
    ));
  } catch {
    throw new Error(
      'macOS physical-footprint inspection is unavailable for the requested process tree.',
    );
  }
  const after = await inspectDesktopProcessTree(pid);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      'The desktop process tree changed during measurement; retry with a stable app.',
    );
  }
  return readDesktopFootprints(
    output,
    before.map((row) => row.pid),
  );
}

async function checkDesktopMemory(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Desktop physical-footprint measurement currently requires macOS.');
  }
  const options = parseDesktopMemoryOptions(process.argv.slice(2));
  const root = (await inspectDesktopProcessTree(options.pid)).find(
    (row) => row.pid === options.pid,
  );
  if (!root) {
    throw new Error('The requested desktop process is unavailable.');
  }
  const startedAt = performance.now();
  const deadlineMs = startedAt + options.durationSeconds * 1000;
  const intervalMs = options.intervalSeconds * 1000;
  let nextSampleAtMs = startedAt;
  let baselineBytes: number | undefined;
  for (let sample = 0; ; sample += 1) {
    const waitMs = nextSampleAtMs - performance.now();
    if (waitMs > 0) {
      await delay(waitMs);
    }
    const processes = await measureDesktopMemory(options.pid, root.startedAt);
    const physicalFootprintBytes = processes.reduce(
      (sum, row) => sum + row.physicalFootprintBytes,
      0,
    );
    baselineBytes ??= physicalFootprintBytes;
    console.info(
      JSON.stringify({
        sample: sample + 1,
        elapsedSeconds: Math.round((performance.now() - startedAt) / 1000),
        physicalFootprintBytes,
        growthBytes: physicalFootprintBytes - baselineBytes,
        budgetBytes: memoryBudgetBytes,
        belowBudget: physicalFootprintBytes < memoryBudgetBytes,
        processes,
      }),
    );
    const nowMs = performance.now();
    if (nowMs >= deadlineMs) {
      break;
    }
    /* Skip missed intervals instead of queuing catch-up process inspections. */
    const elapsedIntervals = Math.floor((nowMs - startedAt) / intervalMs);
    nextSampleAtMs = Math.min(startedAt + (elapsedIntervals + 1) * intervalMs, deadlineMs);
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  try {
    await checkDesktopMemory();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Desktop memory measurement failed.');
    process.exitCode = 1;
  }
}
