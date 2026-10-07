import { expect, it, vi } from 'vitest';
import type { PracticeShortcutEvent } from '#contracts/PracticeShortcut.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

const electron = vi.hoisted(() => ({
  expose: vi.fn<(name: string, bridge: DesktopBridge) => void>(),
  on: vi.fn<(channel: string, listener: (event: unknown, raw: unknown) => void) => void>(),
  removeListener:
    vi.fn<(channel: string, listener: (event: unknown, raw: unknown) => void) => void>(),
  invoke: vi.fn<(channel: string, command: unknown) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

it('routes a validated lesson answer over the registered agent IPC and rejects malformed replies', async () => {
  await import('../../../src/desktop/preload/Preload.js');
  const bridge = electron.expose.mock.calls[0]?.[1];
  if (!bridge) {
    throw new Error('Missing preload bridge');
  }
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const lessonId = '22222222-2222-4222-8222-222222222222';
  electron.invoke.mockResolvedValue({ kind: 'accepted', lessonId });
  expect(
    await bridge.answerTeachingLesson(sessionId, lessonId, 'Sales', DesktopLocale.ENGLISH),
  ).toEqual({ kind: 'accepted', lessonId });
  expect(electron.invoke).toHaveBeenCalledWith('tro:agent-command', {
    kind: 'answer',
    sessionId,
    lessonId,
    message: 'Sales',
    locale: DesktopLocale.ENGLISH,
  });
  await expect(
    bridge.answerTeachingLesson(sessionId, 'foreign', 'Sales', DesktopLocale.ENGLISH),
  ).rejects.toThrow();
  expect(electron.invoke).toHaveBeenCalledOnce();
  electron.invoke.mockResolvedValue({ kind: 'accepted', lessonId: 'invalid' });
  await expect(
    bridge.answerTeachingLesson(sessionId, lessonId, 'Sales', DesktopLocale.ENGLISH),
  ).rejects.toThrow();
});

it('validates saved-account operations and rejects credential-bearing metadata', async () => {
  await import('../../../src/desktop/preload/Preload.js');
  electron.invoke.mockClear();
  const bridge = electron.expose.mock.calls[0]?.[1];
  if (!bridge?.readSavedAccounts || !bridge.switchAccount) {
    throw new Error('Missing account bridge');
  }
  const accountId = '11111111-1111-4111-8111-111111111111';
  electron.invoke.mockResolvedValue({ kind: 'accounts', accounts: [], activeAccountId: null });
  expect(await bridge.readSavedAccounts()).toEqual({
    kind: 'accounts',
    accounts: [],
    activeAccountId: null,
  });
  expect(electron.invoke).toHaveBeenCalledWith('tro:account-command', { kind: 'list' });
  const calls = electron.invoke.mock.calls.length;
  expect((await bridge.switchAccount('not-an-id')).kind).toBe('failed');
  expect(electron.invoke.mock.calls).toHaveLength(calls);
  electron.invoke.mockResolvedValue({
    kind: 'signed-in',
    user: { id: 'test-user', name: 'Test', email: 'test@example.test' },
  });
  expect((await bridge.switchAccount(accountId)).kind).toBe('signed-in');
  electron.invoke.mockResolvedValue({
    kind: 'accounts',
    accounts: [
      {
        id: accountId,
        user: { id: 'test-user', name: 'Test', email: 'test@example.test' },
        role: 'student',
        requiresSignIn: false,
        cookie: 'must-not-cross-preload',
      },
    ],
    activeAccountId: accountId,
  });
  expect((await bridge.readSavedAccounts()).kind).toBe('failed');
});

it('validates practice shortcut navigation events and removes its listener', async () => {
  await import('../../../src/desktop/preload/Preload.js');
  const bridge = electron.expose.mock.calls[0]?.[1];
  if (!bridge?.subscribePracticeShortcut || !bridge.readPracticeShortcutAvailable) {
    throw new Error('Missing practice shortcut bridge');
  }
  const listen = vi.fn<(event: PracticeShortcutEvent) => void>();
  const dispose = bridge.subscribePracticeShortcut(listen);
  const receive = electron.on.mock.calls.find(
    ([channel]) => channel === 'tro:practice-shortcut',
  )?.[1];
  const id = '11111111-1111-4111-8111-111111111111';
  const intent = {
    requestId: id,
    classId: id,
    participationId: id,
    activityId: id,
    attemptId: id,
    contextVersion: 1,
  };
  receive?.({}, { ...intent, evidence: 'must not cross' });
  expect(listen).not.toHaveBeenCalled();
  receive?.({}, intent);
  expect(listen).toHaveBeenCalledWith(intent);
  dispose();
  expect(electron.removeListener).toHaveBeenCalledWith('tro:practice-shortcut', receive);
  electron.invoke.mockResolvedValue('true');
  expect(await bridge.readPracticeShortcutAvailable()).toBe(false);
});
