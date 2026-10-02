import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkerRequestSchema } from '#contracts/AgentSession.js';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { DesktopDriverPort } from './DesktopDriverPort.js';
import { AgentWorkerClient } from './AgentWorkerClient.js';

const doubles = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: doubles.fork } }));
const sessionId = '11111111-1111-4111-8111-111111111111';
const group = '22222222-2222-4222-8222-222222222222';
const connection = {
  command: '/tro/cua-driver',
  args: ['mcp', '--embedded', '--socket', '/private/tro.sock'],
  env: { CUA_DRIVER_EMBEDDED: '1' },
};

class Child extends EventEmitter {
  postMessage = vi.fn<(message: unknown) => void>();
  kill = vi.fn<() => void>(() => {
    this.emit('exit');
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('agent connection to the shared desktop host', () => {
  it('passes the host endpoint and HUD binding, fences progress, and keeps the daemon alive on replacement', async () => {
    const child = new Child();
    let notifyFork = (): void => {};
    const forked = new Promise<void>((resolve) => {
      notifyFork = resolve;
    });
    doubles.fork.mockImplementation(() => {
      notifyFork();
      return child;
    });
    const driver = {
      start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection),
      stop: vi.fn<() => Promise<void>>(),
    };
    const receiveProgress = vi.fn<(progress: AgentProgress) => void>();
    const worker = new AgentWorkerClient('/worker', false, driver, group, receiveProgress);
    const starting = worker.startCompanion(sessionId);
    await forked;
    child.emit('spawn');
    await Promise.resolve();
    const initial = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
    expect(initial.command).toMatchObject({
      kind: 'follow',
      desktopDriver: connection,
      hudGroup: group,
    });
    child.emit('message', { requestId: initial.requestId, result: { kind: 'started', sessionId } });
    expect(await starting).toEqual({ kind: 'started', sessionId });
    const turning = worker.sendMessage(sessionId, 'Show me', DesktopLocale.ENGLISH);
    const turn = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
    child.emit('message', {
      kind: 'progress',
      requestId: initial.requestId,
      sessionId,
      phase: AgentProgressPhase.THINKING,
    });
    expect(receiveProgress).not.toHaveBeenCalled();
    child.emit('message', {
      kind: 'progress',
      requestId: turn.requestId,
      sessionId,
      phase: AgentProgressPhase.SHOWING,
    });
    expect(receiveProgress).toHaveBeenCalledOnce();
    worker.dispose();
    expect(await turning).toMatchObject({ kind: 'failed' });
    expect(driver.stop).not.toHaveBeenCalled();
    child.emit('message', {
      kind: 'progress',
      requestId: turn.requestId,
      sessionId,
      phase: AgentProgressPhase.THINKING,
    });
    expect(receiveProgress).toHaveBeenCalledOnce();
  });

  it('does not fork a task after sign-out while the embedded host is starting', async () => {
    let finishConnection: (value: typeof connection) => void = () => {};
    const driver = {
      start: vi.fn<DesktopDriverPort['start']>().mockReturnValue(
        new Promise((resolve) => {
          finishConnection = resolve;
        }),
      ),
    };
    const worker = new AgentWorkerClient('/worker', false, driver);
    const starting = worker.startCompanion(sessionId);
    worker.dispose();
    finishConnection(connection);
    expect(await starting).toEqual({ kind: 'failed', message: 'The agent session ended.' });
    expect(doubles.fork).not.toHaveBeenCalled();
  });
});
