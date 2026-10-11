import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectLessonProcesses, type LessonProcess } from './LessonRenderResources.js';

export const LessonRenderWorkerDeadlineMs = 600_000;

const shutdownGraceMs = 5000;
const finalInspectionMs = 3000;
const executeFile = promisify(execFile);

interface LessonRenderWorkerProcess {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly connected: boolean | undefined;
  once(event: 'disconnect', listener: () => void): unknown;
  off(event: 'disconnect', listener: () => void): unknown;
  kill(pid: number, signal: 'SIGKILL'): void;
  exit(code: number): void;
}

export interface LessonRenderWorkerLifetimePorts {
  process: LessonRenderWorkerProcess;
  inspectProcesses: (pid: number) => Promise<LessonProcess[]>;
  terminateWindowsTree: (pid: number) => Promise<void>;
}

export interface LessonRenderWorkerLifetime {
  isStopping: () => boolean;
  finish: () => void;
}

async function terminateWindowsTree(pid: number): Promise<void> {
  await executeFile('taskkill', ['/pid', String(pid), '/t', '/f'], {
    timeout: shutdownGraceMs,
    windowsHide: true,
  });
}

/** Own only this detached worker and its descendants; IPC loss must not leave its HTTP server alive. */
export function watchLessonRenderWorkerLifetime(
  closeBrowser: () => Promise<void>,
  ports: LessonRenderWorkerLifetimePorts = {
    process,
    inspectProcesses: inspectLessonProcesses,
    terminateWindowsTree,
  },
): LessonRenderWorkerLifetime {
  const host = ports.process;
  let stopping = false;
  let exited = false;
  let descendants: LessonProcess[] = [];

  const refreshDescendants = async (): Promise<void> => {
    if (host.platform === 'win32') {
      return;
    }
    try {
      const processes = await ports.inspectProcesses(host.pid);
      const owned = new Map(descendants.map((child) => [child.pid, child]));
      for (const child of processes) {
        owned.set(child.pid, child);
      }
      descendants = [...owned.values()];
    } catch {
      /* Retain the last owned snapshot if the process listing is unavailable. */
    }
  };

  const exitWorker = (code: number): void => {
    if (exited) {
      return;
    }
    exited = true;
    /* Chromium may lead its own process group, so the worker group alone is insufficient. */
    for (const child of [...descendants].reverse()) {
      if (child.pid !== host.pid) {
        try {
          host.kill(child.pid, 'SIGKILL');
        } catch {
          /* The owned child already exited. */
        }
      }
    }
    if (host.platform !== 'win32') {
      try {
        host.kill(-host.pid, 'SIGKILL');
      } catch {
        /* A standalone launch may not own a detached group; still exit this worker. */
      }
    }
    host.exit(code);
  };

  const stopWorker = (code: number): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearTimeout(deadline);
    host.off('disconnect', onDisconnect);
    let finishing = false;
    const finishShutdown = (): void => {
      if (finishing) {
        return;
      }
      finishing = true;
      clearTimeout(shutdownDeadline);
      const finalDeadline = setTimeout(() => {
        exitWorker(code);
      }, finalInspectionMs);
      /* A browser may have launched while its opening promise or close operation was pending. */
      void refreshDescendants().then(() => {
        clearTimeout(finalDeadline);
        exitWorker(code);
      });
    };
    const shutdownDeadline = setTimeout(finishShutdown, shutdownGraceMs);
    void (async () => {
      if (host.platform === 'win32') {
        const browserClosed = Promise.resolve()
          .then(closeBrowser)
          .catch(() => {});
        try {
          await ports.terminateWindowsTree(host.pid);
        } catch {
          /* Browser closure and the exit watchdog remain available. */
        }
        await browserClosed;
      } else {
        await refreshDescendants();
        try {
          await closeBrowser();
        } catch {
          /* The owned process snapshot still permits forced cleanup. */
        }
      }
    })().then(finishShutdown, finishShutdown);
  };

  const onDisconnect = (): void => {
    stopWorker(1);
  };
  const deadline = setTimeout(() => {
    stopWorker(1);
  }, LessonRenderWorkerDeadlineMs);
  host.once('disconnect', onDisconnect);
  if (host.connected === false) {
    stopWorker(1);
  }
  return {
    isStopping: () => stopping,
    finish: () => {
      stopWorker(0);
    },
  };
}
