import { expect, it, vi } from 'vitest';
import { AgentChatController } from './AgentChatController.js';
import type { AgentChatAuth, AgentChatWorker, AgentChatPermissions } from './AgentChatPorts.js';
import { DesktopPermissionState, PermissionGrant } from '#contracts/DesktopPermissions.js';
import type { ModelCredential } from '#contracts/AuthSession.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

function createController() {
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
      .mockResolvedValue({ kind: 'completed', answer: 'Done' }),
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
