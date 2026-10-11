import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  LessonRenderWorkerDeadlineMs,
  watchLessonRenderWorkerLifetime,
  type LessonRenderWorkerLifetimePorts,
} from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderWorkerLifetime.js';
import { inspectLessonProcesses } from '../../../../src/server/features/guidedLessons/infrastructure/LessonRenderResources.js';

function createLifetime(platform: NodeJS.Platform = 'darwin', connected = true) {
  const events = new EventEmitter();
  const kill = vi.fn<(pid: number, signal: 'SIGKILL') => void>();
  const exit = vi.fn<(code: number) => void>();
  const closeBrowser = vi.fn<() => Promise<void>>().mockResolvedValue();
  const inspectProcesses = vi
    .fn<LessonRenderWorkerLifetimePorts['inspectProcesses']>()
    .mockResolvedValue([
      { pid: 4200, parentId: 4100, residentBytes: 100 },
      { pid: 4201, parentId: 4200, residentBytes: 100 },
      { pid: 4202, parentId: 4201, residentBytes: 100 },
    ]);
  const terminateWindowsTree = vi
    .fn<LessonRenderWorkerLifetimePorts['terminateWindowsTree']>()
    .mockResolvedValue();
  const lifetime = watchLessonRenderWorkerLifetime(closeBrowser, {
    process: {
      pid: 4200,
      platform,
      connected,
      once: (event, listener) => events.once(event, listener),
      off: (event, listener) => events.off(event, listener),
      kill,
      exit,
    },
    inspectProcesses,
    terminateWindowsTree,
  });
  return { lifetime, events, kill, exit, closeBrowser, inspectProcesses, terminateWindowsTree };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('lesson render worker ownership', () => {
  it('closes the browser and kills separate descendant groups after its parent disconnects', async () => {
    const fixture = createLifetime();
    fixture.events.emit('disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.lifetime.isStopping()).toBe(true);
    expect(fixture.inspectProcesses).toHaveBeenCalledWith(4200);
    expect(fixture.closeBrowser).toHaveBeenCalledOnce();
    expect(fixture.kill.mock.calls).toEqual([
      [4202, 'SIGKILL'],
      [4201, 'SIGKILL'],
      [-4200, 'SIGKILL'],
    ]);
    expect(fixture.exit).toHaveBeenCalledWith(1);
    fixture.events.emit('disconnect');
    fixture.lifetime.finish();
    await vi.advanceTimersByTimeAsync(LessonRenderWorkerDeadlineMs);
    expect(fixture.exit).toHaveBeenCalledOnce();
  });

  it('enforces its own deadline even while IPC remains connected', async () => {
    const fixture = createLifetime();
    await vi.advanceTimersByTimeAsync(LessonRenderWorkerDeadlineMs - 1);
    expect(fixture.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.exit).toHaveBeenCalledWith(1);
    expect(fixture.closeBrowser).toHaveBeenCalledOnce();
  });

  it('finishes normally after a flushed reply and removes its disconnect and deadline work', async () => {
    const fixture = createLifetime();
    fixture.lifetime.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.exit).toHaveBeenCalledWith(0);
    expect(fixture.events.listenerCount('disconnect')).toBe(0);
    await vi.advanceTimersByTimeAsync(LessonRenderWorkerDeadlineMs);
    expect(fixture.exit).toHaveBeenCalledOnce();
  });

  it('bounds shutdown when browser closure hangs', async () => {
    const fixture = createLifetime();
    fixture.closeBrowser.mockImplementation(() => new Promise<void>(() => {}));
    fixture.events.emit('disconnect');
    await vi.advanceTimersByTimeAsync(4999);
    expect(fixture.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.kill).toHaveBeenCalledWith(4201, 'SIGKILL');
    expect(fixture.kill).toHaveBeenCalledWith(-4200, 'SIGKILL');
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it('stops a worker whose IPC channel was already disconnected at startup', async () => {
    const fixture = createLifetime('darwin', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it('waits for an in-flight browser and refreshes descendants before exiting', async () => {
    const fixture = createLifetime();
    let finishOpening: () => void = () => {};
    const browserOpened = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    fixture.closeBrowser.mockImplementation(() => browserOpened);
    fixture.inspectProcesses
      .mockResolvedValueOnce([{ pid: 4200, parentId: 4100, residentBytes: 100 }])
      .mockResolvedValueOnce([
        { pid: 4200, parentId: 4100, residentBytes: 100 },
        { pid: 4203, parentId: 4200, residentBytes: 100 },
      ]);
    fixture.events.emit('disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.exit).not.toHaveBeenCalled();
    finishOpening();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.inspectProcesses).toHaveBeenCalledTimes(2);
    expect(fixture.kill).toHaveBeenCalledWith(4203, 'SIGKILL');
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it('uses Windows tree termination and still exits when that operation fails', async () => {
    const fixture = createLifetime('win32');
    fixture.terminateWindowsTree.mockRejectedValue(new Error('Tree termination unavailable'));
    fixture.events.emit('disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.terminateWindowsTree).toHaveBeenCalledWith(4200);
    expect(fixture.inspectProcesses).not.toHaveBeenCalled();
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it('starts Windows tree termination even while browser closure hangs', async () => {
    const fixture = createLifetime('win32');
    fixture.closeBrowser.mockImplementation(() => new Promise<void>(() => {}));
    fixture.events.emit('disconnect');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.terminateWindowsTree).toHaveBeenCalledWith(4200);
    expect(fixture.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fixture.exit).toHaveBeenCalledWith(1);
  });

  it('releases a detached descendant HTTP port after a real parent IPC disconnect', async () => {
    vi.useRealTimers();
    const child = fork(new URL('./LessonRenderWorkerFixture.ts', import.meta.url), [], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {},
      execArgv: ['--conditions=development', '--import', 'tsx'],
    });
    let browserPid: number | undefined;
    const server = createServer();
    try {
      const ready = await new Promise<{ browserPid: number; port: number }>((resolve, reject) => {
        const deadline = setTimeout(() => {
          reject(new Error('Worker fixture did not start.'));
        }, 10_000);
        child.once('error', (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        child.once('message', (message: unknown) => {
          clearTimeout(deadline);
          const parsed = z
            .strictObject({
              browserPid: z.number().int().positive(),
              port: z.number().int().positive(),
            })
            .safeParse(message);
          if (parsed.success) {
            resolve(parsed.data);
          } else {
            reject(new Error('Worker fixture sent an invalid listener receipt.'));
          }
        });
      });
      browserPid = ready.browserPid;
      const exited = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          reject(new Error('Disconnected worker did not exit.'));
        }, 10_000);
        child.once('exit', () => {
          clearTimeout(deadline);
          resolve();
        });
      });
      child.disconnect();
      await exited;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(ready.port, '127.0.0.1', resolve);
      });
      expect(server.listening).toBe(true);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
      }
      if (child.pid) {
        const descendants = await inspectLessonProcesses(child.pid).catch(() => []);
        for (const owned of descendants.reverse()) {
          if (owned.pid !== child.pid) {
            try {
              process.kill(owned.pid, 'SIGKILL');
            } catch {
              /* The fixture descendant already exited. */
            }
          }
        }
      }
      if (browserPid) {
        try {
          process.kill(browserPid, 'SIGKILL');
        } catch {
          /* The fixture browser already exited. */
        }
      }
      if (child.pid) {
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
        } catch {
          /* The fixture worker already exited. */
        }
      }
    }
  }, 25_000);
});
