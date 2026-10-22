import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkerRequestSchema } from '#contracts/AgentSession.js';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { DesktopDriverPort } from '../../../src/desktop/main/DesktopDriverPort.js';
import { AgentWorkerClient } from '../../../src/desktop/main/AgentWorkerClient.js';
import { ContextFailure } from '#contracts/StudyContext.js';

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

type ActivityContext = Parameters<AgentWorkerClient['setContextController']>[0];

async function prepareObservedWorker(child: Child, pause: ActivityContext['pause']) {
  doubles.fork.mockReturnValue(child);
  const worker = new AgentWorkerClient('/worker', false, {
    start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection),
  });
  const resume = vi.fn<ActivityContext['resume']>().mockResolvedValue();
  const readScope = vi.fn<ActivityContext['readScope']>().mockReturnValue({
    enabled: true,
    available: true,
    generation: 4,
    sessionId,
  });
  const execute = vi.fn<ActivityContext['execute']>().mockResolvedValue({
    kind: 'failed',
    code: ContextFailure.UNAVAILABLE,
  });
  worker.setContextController({
    readScope,
    pause,
    resume,
    execute,
  });
  const preparing = worker.prepare();
  await vi.advanceTimersByTimeAsync(0);
  child.emit('spawn');
  await vi.advanceTimersByTimeAsync(0);
  const request = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  if (request.command.kind !== 'prepare') {
    throw new Error('Expected a preparation command.');
  }
  child.emit('message', {
    requestId: request.requestId,
    result: { kind: 'started', sessionId: request.command.sessionId },
  });
  await preparing;
  return { worker, resume, readScope, execute };
}

it('admits context only for its pending turn and rejects a switched account with the same generation', async () => {
  vi.useFakeTimers();
  const child = new Child();
  const pause = vi.fn<ActivityContext['pause']>().mockResolvedValue();
  const { worker, readScope, execute } = await prepareObservedWorker(child, pause);
  const asking = worker.sendMessage(sessionId, 'What was my assignment?', DesktopLocale.ENGLISH);
  await vi.advanceTimersByTimeAsync(0);
  const turn = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  const request = {
    kind: 'context-request',
    requestId: group,
    taskRequestId: turn.requestId,
    command: { kind: 'resolve', generation: 4, query: 'assignment', cursor: null },
  };
  child.emit('message', request);
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).toHaveBeenCalledOnce();
  expect(child.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    kind: 'context-response',
    requestId: group,
  });
  readScope.mockReturnValue({
    enabled: true,
    available: true,
    generation: 4,
    sessionId: '33333333-3333-4333-8333-333333333333',
  });
  const messagesBeforeSwitchRequest = child.postMessage.mock.calls.length;
  child.emit('message', request);
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).toHaveBeenCalledOnce();
  expect(child.postMessage.mock.calls).toHaveLength(messagesBeforeSwitchRequest);
  worker.dispose();
  expect(await asking).toMatchObject({ kind: 'failed' });
});

it('does not forward a delayed context result after its admitted account changes', async () => {
  vi.useFakeTimers();
  const child = new Child();
  const pause = vi.fn<ActivityContext['pause']>().mockResolvedValue();
  const { worker, readScope, execute } = await prepareObservedWorker(child, pause);
  let finishReply: (reply: Awaited<ReturnType<ActivityContext['execute']>>) => void = () => {};
  execute.mockReturnValueOnce(
    new Promise((resolve) => {
      finishReply = resolve;
    }),
  );
  const asking = worker.sendMessage(sessionId, 'What was my assignment?', DesktopLocale.ENGLISH);
  await vi.advanceTimersByTimeAsync(0);
  const turn = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  const messagesBeforeRequest = child.postMessage.mock.calls.length;
  child.emit('message', {
    kind: 'context-request',
    requestId: group,
    taskRequestId: turn.requestId,
    command: { kind: 'resolve', generation: 4, query: 'assignment', cursor: null },
  });
  expect(execute).toHaveBeenCalledOnce();
  readScope.mockReturnValue({
    enabled: true,
    available: true,
    generation: 4,
    sessionId: '33333333-3333-4333-8333-333333333333',
  });
  finishReply({
    kind: 'source',
    sourceId: group,
    text: 'Synthetic private source.',
    nextOffset: null,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(child.postMessage.mock.calls).toHaveLength(messagesBeforeRequest);
  worker.dispose();
  expect(await asking).toMatchObject({ kind: 'failed' });
});

it('does not authorize context requests through preparation or startup request identities', async () => {
  vi.useFakeTimers();
  const child = new Child();
  doubles.fork.mockReturnValue(child);
  const worker = new AgentWorkerClient('/worker', false, {
    start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection),
  });
  const execute = vi.fn<ActivityContext['execute']>().mockResolvedValue({
    kind: 'failed',
    code: ContextFailure.UNAVAILABLE,
  });
  worker.setContextController({
    readScope: () => ({ enabled: true, available: true, generation: 4, sessionId }),
    pause: vi.fn<ActivityContext['pause']>().mockResolvedValue(),
    resume: vi.fn<ActivityContext['resume']>().mockResolvedValue(),
    execute,
  });
  const preparing = worker.prepare();
  await vi.advanceTimersByTimeAsync(0);
  child.emit('spawn');
  await vi.advanceTimersByTimeAsync(0);
  const preparation = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  child.emit('message', {
    kind: 'context-request',
    requestId: group,
    taskRequestId: preparation.requestId,
    command: { kind: 'resolve', generation: 4, query: 'assignment', cursor: null },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).not.toHaveBeenCalled();
  child.emit('message', {
    requestId: preparation.requestId,
    result: { kind: 'started', sessionId: preparation.command.sessionId },
  });
  await preparing;
  const starting = worker.start(sessionId, 'synthetic-token', 'https://gateway.example.test');
  await vi.advanceTimersByTimeAsync(0);
  const startup = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  child.emit('message', {
    kind: 'context-request',
    requestId: group,
    taskRequestId: startup.requestId,
    command: { kind: 'resolve', generation: 4, query: 'assignment', cursor: null },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).not.toHaveBeenCalled();
  child.emit('message', { requestId: startup.requestId, result: { kind: 'started', sessionId } });
  await starting;
  worker.dispose();
});

it.each(['disposal', 'timeout'] as const)(
  'resumes the same context account after %s confirms worker retirement without delaying the result',
  async (failure) => {
    vi.useFakeTimers();
    const child = new Child();
    child.kill.mockImplementation(() => {});
    const pause = vi.fn<ActivityContext['pause']>().mockResolvedValue();
    const { worker, resume } = await prepareObservedWorker(child, pause);
    const asking = worker.sendMessage(sessionId, 'Why is the score wrong?', DesktopLocale.ENGLISH);
    await vi.advanceTimersByTimeAsync(0);
    if (failure === 'timeout') {
      await vi.advanceTimersByTimeAsync(120_000);
    } else {
      worker.dispose();
    }
    expect(await asking).toMatchObject({ kind: 'failed' });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
    child.emit('exit');
    await vi.advanceTimersByTimeAsync(0);
    expect(resume).toHaveBeenCalledOnce();
  },
);

it('does not let a retiring older Ask resume collection while a newer Ask owns its pause', async () => {
  vi.useFakeTimers();
  const child = new Child();
  child.kill.mockImplementation(() => {});
  let finishNewPause = (): void => {};
  const newPause = new Promise<void>((resolve) => {
    finishNewPause = resolve;
  });
  const pause = vi
    .fn<ActivityContext['pause']>()
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(newPause);
  const { worker, resume } = await prepareObservedWorker(child, pause);
  const oldAsk = worker.sendMessage(sessionId, 'Why is the score wrong?', DesktopLocale.ENGLISH);
  await vi.advanceTimersByTimeAsync(0);
  worker.dispose();
  expect(await oldAsk).toMatchObject({ kind: 'failed' });
  const newAsk = worker.sendMessage(sessionId, 'What was my assignment?', DesktopLocale.ENGLISH);
  expect(pause).toHaveBeenCalledTimes(2);
  child.emit('exit');
  await vi.advanceTimersByTimeAsync(0);
  expect(resume).not.toHaveBeenCalled();
  finishNewPause();
  expect(await newAsk).toMatchObject({ kind: 'failed' });
  await vi.advanceTimersByTimeAsync(0);
  expect(resume).toHaveBeenCalledOnce();
});

it('fences a superseded context admission before dispatch or collection resume', async () => {
  vi.useFakeTimers();
  const child = new Child();
  let finishOldPause = (): void => {};
  const oldPause = new Promise<void>((resolve) => {
    finishOldPause = resolve;
  });
  const pause = vi
    .fn<ActivityContext['pause']>()
    .mockReturnValueOnce(oldPause)
    .mockResolvedValueOnce(undefined);
  const { worker, resume } = await prepareObservedWorker(child, pause);
  const oldAsk = worker.sendMessage(sessionId, 'Why is the score wrong?', DesktopLocale.ENGLISH);
  const newAsk = worker.sendMessage(sessionId, 'What was my assignment?', DesktopLocale.ENGLISH);
  await vi.advanceTimersByTimeAsync(0);
  const turn = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  expect(turn.command).toMatchObject({ kind: 'turn', message: 'What was my assignment?' });
  child.emit('message', {
    requestId: turn.requestId,
    result: { kind: 'failed', message: 'Synthetic settlement.' },
  });
  expect(await newAsk).toMatchObject({ kind: 'failed' });
  const dispatchedRequests = child.postMessage.mock.calls.length;
  finishOldPause();
  expect(await oldAsk).toMatchObject({ kind: 'failed' });
  expect(child.postMessage.mock.calls).toHaveLength(dispatchedRequests);
  expect(resume).toHaveBeenCalledOnce();
  worker.dispose();
});

it('retrieves context using the actual question before dispatching the task', async () => {
  const child = new Child();
  let notifyFork = (): void => {};
  const forked = new Promise<void>((resolve) => {
    notifyFork = resolve;
  });
  doubles.fork.mockImplementation(() => {
    notifyFork();
    return child;
  });
  const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
  const worker = new AgentWorkerClient('/worker', false, driver);
  type ActivityContext = Parameters<AgentWorkerClient['setContextController']>[0];
  const pause = vi.fn<ActivityContext['pause']>().mockResolvedValue();
  const resume = vi.fn<ActivityContext['resume']>().mockResolvedValue();
  worker.setContextController({
    readScope: () => ({ enabled: true, available: true, generation: 4, sessionId }),
    pause,
    resume,
    execute: vi
      .fn<ActivityContext['execute']>()
      .mockResolvedValue({ kind: 'failed', code: ContextFailure.UNAVAILABLE }),
  });
  const preparing = worker.prepare();
  await forked;
  child.emit('spawn');
  await Promise.resolve();
  const prepared = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  if (prepared.command.kind !== 'prepare') {
    throw new Error('Expected a preparation command.');
  }
  child.emit('message', {
    requestId: prepared.requestId,
    result: { kind: 'started', sessionId: prepared.command.sessionId },
  });
  await preparing;
  const asking = worker.sendMessage(
    sessionId,
    'Why does my Python loop never finish?',
    DesktopLocale.ENGLISH,
  );
  await vi.waitFor(() => {
    expect(
      AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]).command.kind,
    ).toBe('turn');
  });
  expect(pause).toHaveBeenCalledWith('Why does my Python loop never finish?');
  const turn = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  expect(turn.command).toMatchObject({ activityContext: { generation: 4 } });
  child.emit('message', {
    requestId: turn.requestId,
    result: { kind: 'failed', message: 'Synthetic settlement.' },
  });
  await asking;
  expect(resume).toHaveBeenCalledOnce();
  worker.dispose();
});

it('does not dispatch or resume an older Ask after its context identity changes', async () => {
  type ActivityContext = Parameters<AgentWorkerClient['setContextController']>[0];
  let finishPause = (): void => {};
  const paused = new Promise<void>((resolve) => {
    finishPause = resolve;
  });
  let contextSession = sessionId;
  const pause = vi.fn<ActivityContext['pause']>().mockReturnValue(paused);
  const resume = vi.fn<ActivityContext['resume']>().mockResolvedValue();
  const worker = new AgentWorkerClient('/worker', false, {
    start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection),
  });
  worker.setContextController({
    readScope: () => ({ enabled: true, available: true, generation: 1, sessionId: contextSession }),
    pause,
    resume,
    execute: vi
      .fn<ActivityContext['execute']>()
      .mockResolvedValue({ kind: 'failed', code: ContextFailure.UNAVAILABLE }),
  });
  const asking = worker.sendMessage(sessionId, 'Help me debug.', DesktopLocale.ENGLISH);
  contextSession = '33333333-3333-4333-8333-333333333333';
  finishPause();
  expect(await asking).toMatchObject({ kind: 'failed' });
  expect(resume).not.toHaveBeenCalled();
  expect(doubles.fork).not.toHaveBeenCalled();
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
    const starting = worker.prepare();
    await forked;
    child.emit('spawn');
    await Promise.resolve();
    const initial = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
    expect(initial.command).toMatchObject({
      kind: 'prepare',
      desktopDriver: connection,
      hudGroup: group,
    });
    child.emit('message', {
      requestId: initial.requestId,
      result: { kind: 'started', sessionId: initial.command.sessionId },
    });
    await starting;
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
    const starting = worker.prepare();
    await Promise.resolve();
    worker.dispose();
    finishConnection(connection);
    await expect(starting).rejects.toThrow('Could not prepare');
    expect(doubles.fork).not.toHaveBeenCalled();
  });
});

it('keeps a teaching request alive past ten minutes while accepting a separate lesson answer', async () => {
  vi.useFakeTimers();
  const child = new Child();
  doubles.fork.mockReturnValue(child);
  const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
  const worker = new AgentWorkerClient('/worker', false, driver);
  const starting = worker.prepare();
  await vi.advanceTimersByTimeAsync(0);
  child.emit('spawn');
  await vi.advanceTimersByTimeAsync(0);
  const initial = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  child.emit('message', {
    requestId: initial.requestId,
    result: { kind: 'started', sessionId: initial.command.sessionId },
  });
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

it('deduplicates preparation and rebinds tasks without forking again', async () => {
  vi.useFakeTimers();
  const child = new Child();
  doubles.fork.mockReturnValue(child);
  const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
  const worker = new AgentWorkerClient('/worker', false, driver);
  const first = worker.prepare();
  expect(worker.prepare()).toBe(first);
  await vi.advanceTimersByTimeAsync(0);
  child.emit('spawn');
  await vi.advanceTimersByTimeAsync(0);
  const prepared = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
  child.emit('message', {
    requestId: prepared.requestId,
    result: { kind: 'started', sessionId: prepared.command.sessionId },
  });
  await first;
  for (const id of [sessionId, group]) {
    const starting = worker.start(id, 'token', 'https://gateway.example.test');
    await vi.advanceTimersByTimeAsync(0);
    const start = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
    expect(start.command.kind).toBe('start');
    child.emit('message', {
      requestId: start.requestId,
      result: { kind: 'started', sessionId: id },
    });
    await starting;
    const finishing = worker.finish(id);
    const finish = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
    child.emit('message', { requestId: finish.requestId, result: { kind: 'stopped' } });
    await finishing;
  }
  expect(doubles.fork).toHaveBeenCalledOnce();
  expect(child.kill).not.toHaveBeenCalled();
  worker.dispose();
});

it('bounds driver startup and fences its late completion before forking', async () => {
  vi.useFakeTimers();
  let finish: (value: typeof connection) => void = () => {};
  const driver = {
    start: vi.fn<DesktopDriverPort['start']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const worker = new AgentWorkerClient('/worker', false, driver);
  const rejection = expect(worker.prepare()).rejects.toThrow('Could not prepare');
  await vi.advanceTimersByTimeAsync(10_000);
  await rejection;
  finish(connection);
  await vi.advanceTimersByTimeAsync(0);
  expect(doubles.fork).not.toHaveBeenCalled();
});

it('waits for the retiring process to exit and ignores its late startup before replacing it', async () => {
  vi.useFakeTimers();
  const oldChild = new Child();
  oldChild.kill.mockImplementation(() => {});
  const currentChild = new Child();
  doubles.fork.mockReturnValueOnce(oldChild).mockReturnValueOnce(currentChild);
  const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
  const worker = new AgentWorkerClient('/worker', false, driver);
  const oldStart = expect(worker.prepare()).rejects.toThrow('Could not prepare');
  await vi.advanceTimersByTimeAsync(0);
  worker.dispose();
  const currentStart = worker.prepare();
  await vi.advanceTimersByTimeAsync(0);
  expect(doubles.fork).toHaveBeenCalledOnce();
  oldChild.emit('exit');
  await vi.advanceTimersByTimeAsync(0);
  expect(doubles.fork).toHaveBeenCalledTimes(2);
  currentChild.emit('spawn');
  await vi.advanceTimersByTimeAsync(0);
  const prepared = AgentWorkerRequestSchema.parse(currentChild.postMessage.mock.calls.at(-1)?.[0]);
  currentChild.emit('message', {
    requestId: prepared.requestId,
    result: { kind: 'started', sessionId: prepared.command.sessionId },
  });
  await currentStart;
  await oldStart;
  expect(currentChild.kill).not.toHaveBeenCalled();
  worker.dispose();
});

it.each(['stopped', 'failed', 'timeout'] as const)(
  'confirms exit after %s cleanup before returning cursor ownership',
  async (cleanup) => {
    vi.useFakeTimers();
    const child = new Child();
    child.kill.mockImplementation(() => {});
    doubles.fork.mockReturnValue(child);
    const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
    const worker = new AgentWorkerClient('/worker', false, driver);
    const preparing = worker.prepare();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('spawn');
    await vi.advanceTimersByTimeAsync(0);
    const prepare = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
    child.emit('message', {
      requestId: prepare.requestId,
      result: { kind: 'started', sessionId: prepare.command.sessionId },
    });
    await preparing;
    let settled = false;
    const stopping = worker.stop(sessionId).then((result) => {
      settled = true;
      return result;
    });
    const stop = AgentWorkerRequestSchema.parse(child.postMessage.mock.calls.at(-1)?.[0]);
    if (cleanup === 'timeout') {
      await vi.advanceTimersByTimeAsync(2000);
    } else {
      child.emit('message', {
        requestId: stop.requestId,
        result:
          cleanup === 'stopped'
            ? { kind: 'stopped' }
            : { kind: 'failed', message: 'Not connected' },
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    child.emit('exit');
    expect(await stopping).toEqual({ kind: 'stopped' });
  },
);

it('does not confirm cancellation when the retiring child fails to exit', async () => {
  vi.useFakeTimers();
  const child = new Child();
  child.kill.mockImplementation(() => {});
  doubles.fork.mockReturnValue(child);
  const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
  const worker = new AgentWorkerClient('/worker', false, driver);
  const preparing = expect(worker.prepare()).rejects.toThrow('Could not prepare');
  await vi.advanceTimersByTimeAsync(0);
  worker.dispose();
  child.emit('spawn');
  await preparing;
  const stopping = worker.stop(sessionId);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await stopping).toMatchObject({ kind: 'failed' });
  child.emit('exit');
});
