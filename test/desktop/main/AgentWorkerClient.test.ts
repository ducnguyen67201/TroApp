import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkerRequestSchema } from '#contracts/AgentSession.js';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { DesktopDriverPort } from '../../../src/desktop/main/DesktopDriverPort.js';
import { AgentWorkerClient } from '../../../src/desktop/main/AgentWorkerClient.js';

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
  vi.useRealTimers();
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

it('keeps a teaching request alive past ten minutes while accepting a separate lesson answer', async () => {
  vi.useFakeTimers();
  const child = new Child();
  doubles.fork.mockReturnValue(child);
  const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
  const worker = new AgentWorkerClient('/worker', false, driver);
  const starting = worker.startCompanion(sessionId);
  await vi.advanceTimersByTimeAsync(0);
  child.emit('spawn');
  await vi.advanceTimersByTimeAsync(0);
  const initial = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  child.emit('message', { requestId: initial.requestId, result: { kind: 'started', sessionId } });
  await starting;
  const turning = worker.sendMessage(sessionId, 'Open YouTube', DesktopLocale.ENGLISH, 'teach');
  const turn = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  await vi.advanceTimersByTimeAsync(601000);
  expect(child.kill).not.toHaveBeenCalled();
  const lessonId = '33333333-3333-4333-8333-333333333333';
  const answering = worker.answerLesson(sessionId, lessonId, 'Chrome', DesktopLocale.ENGLISH);
  const answer = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  expect(answer.command).toMatchObject({ kind: 'answer', lessonId, message: 'Chrome' });
  child.emit('message', { requestId: answer.requestId, result: { kind: 'accepted', lessonId } });
  expect(await answering).toMatchObject({ kind: 'accepted' });
  child.emit('message', {
    requestId: turn.requestId,
    result: { kind: 'teaching', result: { outcome: 'goal_reached', answer: 'YouTube is open.' } },
  });
  expect(await turning).toMatchObject({ kind: 'teaching', result: { outcome: 'goal_reached' } });
  worker.dispose();
});
