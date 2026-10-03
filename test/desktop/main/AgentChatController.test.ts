import { afterEach, expect, it, vi } from 'vitest';
import { AgentChatController } from '../../../src/desktop/main/AgentChatController.js';
import type {
  AgentChatAuth,
  AgentChatWorker,
  AgentChatPermissions,
  AgentCancelShortcut,
} from '../../../src/desktop/main/AgentChatPorts.js';
import { DesktopPermissionState, PermissionGrant } from '#contracts/DesktopPermissions.js';
import type { ModelCredential } from '#contracts/AuthSession.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

function createController(cancelShortcut?: AgentCancelShortcut) {
  const auth = {
    readSession: vi.fn<AgentChatAuth['readSession']>().mockResolvedValue({
      kind: 'signed-in',
      user: { id: 'student', name: 'Student', email: 'student@example.test' },
    }),
    signInWithGoogle: vi
      .fn<AgentChatAuth['signInWithGoogle']>()
      .mockResolvedValue({ kind: 'pending' }),
    signOut: vi.fn<AgentChatAuth['signOut']>().mockResolvedValue({ kind: 'signed-out' }),
    fetchModelCredential: vi.fn<AgentChatAuth['fetchModelCredential']>(),
  };
  const worker = {
    isRunning: vi.fn<AgentChatWorker['isRunning']>().mockReturnValue(false),
    startCompanion: vi
      .fn<AgentChatWorker['startCompanion']>()
      .mockResolvedValue({ kind: 'started', sessionId: 'companion' }),
    start: vi
      .fn<AgentChatWorker['start']>()
      .mockResolvedValue({ kind: 'started', sessionId: 'teacher' }),
    sendMessage: vi
      .fn<AgentChatWorker['sendMessage']>()
      .mockResolvedValue({ kind: 'completed', completion: { kind: 'response' }, answer: 'Done' }),
    answerLesson: vi
      .fn<NonNullable<AgentChatWorker['answerLesson']>>()
      .mockResolvedValue({ kind: 'accepted', lessonId: '22222222-2222-4222-8222-222222222222' }),
    refreshCredential: vi
      .fn<NonNullable<AgentChatWorker['refreshCredential']>>()
      .mockResolvedValue({ kind: 'started', sessionId: 'teacher' }),
    stop: vi.fn<AgentChatWorker['stop']>().mockResolvedValue({ kind: 'stopped' }),
    dispose: vi.fn<AgentChatWorker['dispose']>(),
  };
  const permissions = {
    readStatus: vi.fn<AgentChatPermissions['readStatus']>().mockResolvedValue({
      kind: DesktopPermissionState.READY,
      accessibility: PermissionGrant.GRANTED,
      screenRecording: PermissionGrant.GRANTED,
    }),
  };
  const controller = new AgentChatController(
    auth,
    worker,
    'https://gateway.example.test',
    permissions,
    cancelShortcut,
  );
  return { auth, worker, permissions, controller };
}

it('does not start an agent after Stop while its model credential is loading', async () => {
  const { auth, worker, controller } = createController();
  let completeCredential: ((value: ModelCredential) => void) | undefined;
  auth.fetchModelCredential.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeCredential = resolve;
      }),
  );
  const task = controller.sendMessage('teacher', 'Show a circle', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(auth.fetchModelCredential).toHaveBeenCalledTimes(1);
  });
  await controller.stopSession('teacher');
  completeCredential?.({ token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' });
  expect(await task).toMatchObject({ kind: 'failed' });
  expect(worker.start).not.toHaveBeenCalled();
  expect(worker.sendMessage).not.toHaveBeenCalled();
});

it('disposes a starting worker and rejects its late ready reply after Stop', async () => {
  const { auth, worker, controller } = createController();
  auth.fetchModelCredential.mockResolvedValue({
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let finishStart: ((value: Awaited<ReturnType<AgentChatWorker['start']>>) => void) | undefined;
  worker.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  );
  const task = controller.sendMessage('teacher', 'Show a circle', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(worker.start).toHaveBeenCalledTimes(1);
  });
  const disposals = worker.dispose.mock.calls.length;
  await controller.stopSession('teacher');
  expect(worker.dispose).toHaveBeenCalledTimes(disposals + 1);
  finishStart?.({ kind: 'started', sessionId: 'teacher' });
  expect(await task).toMatchObject({ kind: 'failed' });
  expect(worker.sendMessage).not.toHaveBeenCalled();
});

it('starts one local companion without a model credential or task', async () => {
  const { auth, worker, controller } = createController();
  const first = controller.startCursorCompanion();
  const second = controller.startCursorCompanion();
  expect(second).toBe(first);
  expect(await first).toMatchObject({ kind: 'started' });
  expect(worker.startCompanion).toHaveBeenCalledTimes(1);
  expect(auth.fetchModelCredential).not.toHaveBeenCalled();
  expect(worker.start).not.toHaveBeenCalled();
  expect(worker.sendMessage).not.toHaveBeenCalled();
  controller.dispose();
});

it('keeps the companion off until sign-in and both desktop grants are verified', async () => {
  const { auth, worker, permissions, controller } = createController();
  auth.readSession.mockResolvedValueOnce({ kind: 'signed-out' });
  expect(await controller.startCursorCompanion()).toMatchObject({ kind: 'failed' });
  permissions.readStatus.mockResolvedValue({
    kind: 'unknown',
    accessibility: 'unknown',
    screenRecording: 'unknown',
  });
  expect(await controller.startCursorCompanion()).toMatchObject({ kind: 'failed' });
  expect(worker.startCompanion).not.toHaveBeenCalled();
  expect(auth.fetchModelCredential).not.toHaveBeenCalled();
  controller.dispose();
});

it('rejects late companion startup after sign-out without reconnecting', async () => {
  const { worker, controller } = createController();
  let finishStart:
    ((result: Awaited<ReturnType<AgentChatWorker['startCompanion']>>) => void) | undefined;
  worker.startCompanion.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  );
  const following = controller.startCursorCompanion();
  await vi.waitFor(() => {
    expect(worker.startCompanion).toHaveBeenCalledTimes(1);
  });
  await controller.signOut();
  finishStart?.({ kind: 'started', sessionId: 'companion' });
  expect(await following).toMatchObject({ kind: 'failed' });
  expect(worker.startCompanion).toHaveBeenCalledTimes(1);
  controller.dispose();
});

it('releases idle ownership before starting a credentialed task and restores it after Stop', async () => {
  const { auth, worker, controller } = createController();
  worker.startCompanion.mockImplementation((sessionId) => {
    worker.isRunning.mockReturnValue(true);
    return Promise.resolve({ kind: 'started', sessionId });
  });
  worker.stop.mockImplementation(() => {
    worker.isRunning.mockReturnValue(false);
    return Promise.resolve({ kind: 'stopped' });
  });
  worker.start.mockImplementation((sessionId) => {
    worker.isRunning.mockReturnValue(true);
    return Promise.resolve({ kind: 'started', sessionId });
  });
  auth.fetchModelCredential.mockResolvedValue({
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await controller.startCursorCompanion();
  expect(
    await controller.sendMessage('teacher', 'Show a circle', DesktopLocale.ENGLISH, 'teach'),
  ).toMatchObject({ kind: 'completed' });
  const stopOrder = worker.stop.mock.invocationCallOrder[0];
  const taskStartOrder = worker.start.mock.invocationCallOrder[0];
  expect(stopOrder).toBeDefined();
  expect(taskStartOrder).toBeDefined();
  expect(stopOrder).toBeLessThan(taskStartOrder ?? 0);
  await controller.stopSession('teacher');
  expect(worker.startCompanion).toHaveBeenCalledTimes(2);
  expect(auth.fetchModelCredential).toHaveBeenCalledTimes(1);
  controller.dispose();
});

it('Esc cancels a teaching request during credential loading and suppresses later startup', async () => {
  const shortcut = {
    enable: vi.fn<AgentCancelShortcut['enable']>().mockReturnValue(true),
    disable: vi.fn<AgentCancelShortcut['disable']>(),
  };
  const { auth, worker, controller } = createController(shortcut);
  let finishCredential: ((value: ModelCredential) => void) | undefined;
  auth.fetchModelCredential.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCredential = resolve;
      }),
  );
  const turning = controller.sendMessage('teacher', 'Open YouTube', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(auth.fetchModelCredential).toHaveBeenCalledOnce();
  });
  shortcut.enable.mock.calls[0]?.[0]();
  finishCredential?.({ token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' });
  expect(await turning).toEqual({
    kind: 'teaching',
    result: { outcome: 'canceled', reason: 'explicit_stop' },
  });
  expect(worker.start).not.toHaveBeenCalled();
  expect(worker.sendMessage).not.toHaveBeenCalled();
  expect(shortcut.disable).toHaveBeenCalled();
});

it('Esc stops an active teaching worker and discards a late successful answer', async () => {
  const shortcut = {
    enable: vi.fn<AgentCancelShortcut['enable']>().mockReturnValue(true),
    disable: vi.fn<AgentCancelShortcut['disable']>(),
  };
  const { auth, worker, controller } = createController(shortcut);
  auth.fetchModelCredential.mockResolvedValue({
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let finishTurn:
    ((result: Awaited<ReturnType<AgentChatWorker['sendMessage']>>) => void) | undefined;
  worker.start.mockImplementation(async () => {
    await Promise.resolve();
    worker.isRunning.mockReturnValue(true);
    return { kind: 'started', sessionId: 'teacher' };
  });
  worker.sendMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishTurn = resolve;
      }),
  );
  const turning = controller.sendMessage('teacher', 'Open YouTube', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(worker.sendMessage).toHaveBeenCalledOnce();
  });
  shortcut.enable.mock.calls[0]?.[0]();
  await vi.waitFor(() => {
    expect(worker.stop).toHaveBeenCalledWith('teacher');
  });
  finishTurn?.({ kind: 'teaching', result: { outcome: 'demonstrated', answer: 'Late guide' } });
  expect(await turning).toEqual({
    kind: 'teaching',
    result: { outcome: 'canceled', reason: 'explicit_stop' },
  });
  controller.dispose();
});

afterEach(() => {
  vi.useRealTimers();
});

it('routes typed and voice answers into the active lesson and fences foreign questions', async () => {
  const { auth, worker, controller } = createController();
  auth.fetchModelCredential.mockResolvedValue({
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let finish: ((result: Awaited<ReturnType<AgentChatWorker['sendMessage']>>) => void) | undefined;
  worker.sendMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const running = controller.sendMessage(
    'teacher',
    'Design an ERD',
    DesktopLocale.ENGLISH,
    'teach',
  );
  await vi.waitFor(() => {
    expect(worker.sendMessage).toHaveBeenCalledOnce();
  });
  const lessonId = '22222222-2222-4222-8222-222222222222';
  controller.receiveProgress({
    kind: 'progress',
    requestId: lessonId,
    sessionId: 'teacher',
    lessonId,
    phase: 'needs_input',
    teachingStep: 'Which database?',
  });
  expect(controller.isBusy()).toBe(false);
  expect(await controller.startTaskSession()).toEqual({ kind: 'started', sessionId: 'teacher' });
  expect(
    await controller.answerLesson('other', lessonId, 'Sales', DesktopLocale.ENGLISH),
  ).toMatchObject({ kind: 'failed' });
  expect(
    await controller.sendMessage('teacher', 'Sales', DesktopLocale.ENGLISH, 'teach'),
  ).toMatchObject({ kind: 'accepted' });
  expect(worker.answerLesson).toHaveBeenCalledWith(
    'teacher',
    lessonId,
    'Sales',
    DesktopLocale.ENGLISH,
  );
  expect(worker.sendMessage).toHaveBeenCalledOnce();
  finish?.({ kind: 'teaching', result: { outcome: 'goal_reached', answer: 'ERD finished.' } });
  expect(await running).toMatchObject({ kind: 'teaching', result: { outcome: 'goal_reached' } });
  controller.dispose();
});

it('renews expiring model access during a long lesson without replacing its worker or goal', async () => {
  vi.useFakeTimers();
  const { auth, worker, controller } = createController();
  auth.fetchModelCredential
    .mockResolvedValueOnce({
      token: 'initial',
      expiresAt: new Date(Date.now() + 90000).toISOString(),
    })
    .mockResolvedValue({
      token: 'renewed',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
  worker.sendMessage.mockImplementation(() => new Promise(() => {}));
  void controller.sendMessage('teacher', 'Open YouTube', DesktopLocale.ENGLISH, 'teach');
  await vi.advanceTimersByTimeAsync(30000);
  expect(worker.refreshCredential).toHaveBeenCalledWith(
    'teacher',
    'renewed',
    'https://gateway.example.test',
  );
  expect(worker.start).toHaveBeenCalledOnce();
  controller.dispose();
  await vi.advanceTimersByTimeAsync(120000);
  expect(worker.refreshCredential).toHaveBeenCalledOnce();
});
