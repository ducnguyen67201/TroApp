import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as waitForProcessExit } from 'node:timers/promises';
import type { LessonRenderer } from '../application/LessonPorts.js';
import { inspectLessonProcesses, type LessonProcess } from './LessonRenderResources.js';
import {
  LessonPresentationIdentitySchema,
  LessonRenderInputSchema,
  LessonRenderResultSchema,
  LessonRenderFailureSchema,
} from './LessonRenderProtocol.js';

/** One isolated trusted renderer per API instance. Deadline/cancellation kills the process group, including Chromium. */
export class RemotionLessonRenderer implements LessonRenderer {
  private active = false;
  constructor(
    private readonly bundlePath = resolve('dist/lessonBundle'),
    private readonly reportFailure: (event: {
      stage: string;
      sceneId: string | null;
      frame: number | null;
      geometry: unknown;
    }) => void = () => {},
  ) {}

  async render(
    request: Parameters<LessonRenderer['render']>[0],
    signal: AbortSignal,
  ): ReturnType<LessonRenderer['render']> {
    if (this.active || signal.aborted) {
      throw new Error('The lesson renderer is busy or cancelled.');
    }
    this.active = true;
    let stopped = true;
    try {
      const validated = LessonRenderInputSchema.parse(request);
      if (
        validated.speechArtifacts.reduce((sum, item) => sum + item.bytes.byteLength, 0) >
        160 * 1024 * 1024
      ) {
        throw new Error('Lesson media exceeds the run allowance.');
      }
      const raw: unknown = JSON.parse(
        await readFile(join(this.bundlePath, 'PresentationIdentity.json'), 'utf8'),
      );
      const identity = LessonPresentationIdentitySchema.parse(raw);
      const development = import.meta.url.endsWith('.ts');
      const child = fork(
        new URL(`./RenderLessonWorker.${development ? 'ts' : 'js'}`, import.meta.url),
        [],
        {
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          detached: process.platform !== 'win32',
          env: {},
          execArgv: [
            '--max-old-space-size=1024',
            ...(development ? ['--conditions=development', '--import', 'tsx'] : []),
          ],
        },
      );
      stopped = false;
      const lifecycle = { exited: false };
      const childExit = new Promise<void>((fulfill) =>
        child.once('exit', () => {
          lifecycle.exited = true;
          fulfill();
        }),
      );
      let descendants: LessonProcess[] = [];
      const terminate = (): void => {
        for (const processInfo of [...descendants].reverse()) {
          if (processInfo.pid !== child.pid) {
            try {
              process.kill(processInfo.pid, 'SIGKILL');
            } catch {
              /* It already exited. */
            }
          }
        }
        if (!child.pid) {
          return;
        }
        try {
          if (process.platform === 'win32') {
            child.kill('SIGKILL');
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          /* It already exited. */
        }
      };
      let result: Awaited<ReturnType<LessonRenderer['render']>> | undefined;
      let renderFailure: unknown;
      try {
        result = await new Promise<Awaited<ReturnType<LessonRenderer['render']>>>(
          (fulfill, reject) => {
            const cancel = (): void => {
              reject(new Error('Lesson rendering was cancelled.'));
            };
            const deadline = setTimeout(cancel, 600_000);
            let inspecting = false;
            const memoryGuard = setInterval(() => {
              if (inspecting || !child.pid) {
                return;
              }
              inspecting = true;
              void inspectLessonProcesses(child.pid)
                .then(
                  (processes) => {
                    descendants = processes;
                    const residentBytes = processes.reduce(
                      (sum, item) => sum + item.residentBytes,
                      0,
                    );
                    if (residentBytes > 2 * 1024 ** 3) {
                      this.reportFailure({
                        stage: 'memory',
                        sceneId: null,
                        frame: null,
                        geometry: { residentBytes, processCount: processes.length },
                      });
                      cancel();
                    }
                  },
                  () => {
                    cancel();
                  },
                )
                .finally(() => {
                  inspecting = false;
                });
            }, 1000);

            signal.addEventListener('abort', cancel, { once: true });
            const cleanup = (): void => {
              clearTimeout(deadline);
              clearInterval(memoryGuard);
              signal.removeEventListener('abort', cancel);
            };
            child.once('message', (message: unknown) => {
              cleanup();
              const result = LessonRenderResultSchema.safeParse(message);
              if (result.success) {
                fulfill(result.data);
              } else {
                const failure = LessonRenderFailureSchema.safeParse(message);
                if (failure.success) {
                  this.reportFailure({
                    stage: failure.data.stage,
                    sceneId: failure.data.sceneId,
                    frame: failure.data.frame,
                    geometry: failure.data.geometry,
                  });
                }
                reject(new Error('Lesson rendering failed its output contract.'));
              }
            });
            child.once('error', () => {
              cleanup();
              reject(new Error('The lesson renderer could not start.'));
            });
            child.once('exit', () => {
              cleanup();
              reject(new Error('The lesson renderer stopped.'));
            });
            child.send({ request: validated, identity, bundlePath: this.bundlePath });
            if (signal.aborted) {
              cancel();
            }
          },
        );
      } catch (error) {
        renderFailure = error;
      } finally {
        if (!lifecycle.exited && child.pid) {
          descendants = await inspectLessonProcesses(child.pid).catch(() => descendants);
        }
        terminate();
        let exitDeadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          childExit,
          new Promise<void>((fulfill) => {
            exitDeadline = setTimeout(fulfill, 5000);
          }),
        ]);
        clearTimeout(exitDeadline);
        const shutdownDeadlineMs = Date.now() + 5000;
        do {
          stopped =
            lifecycle.exited &&
            descendants.every((processInfo) => !isLessonProcessRunning(processInfo.pid));
          if (stopped) {
            break;
          }
          await waitForProcessExit(25);
        } while (Date.now() < shutdownDeadlineMs);
      }
      if (!stopped) {
        this.reportFailure({
          stage: 'shutdown',
          sceneId: null,
          frame: null,
          geometry: {
            workerExited: lifecycle.exited,
            processes: descendants.filter((processInfo) => isLessonProcessRunning(processInfo.pid)),
          },
        });
        throw new Error(
          'The prior lesson renderer has not confirmed shutdown. Restart the API before rendering again.',
        );
      }
      if (result) {
        return result;
      }
      throw renderFailure instanceof Error ? renderFailure : new Error('Lesson rendering failed.');
    } finally {
      if (stopped) {
        this.active = false;
      }
    }
  }
}

function isLessonProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
