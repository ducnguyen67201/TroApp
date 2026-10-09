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

it('exposes only validated feature commands and narrow parent export identity', async () => {
  await import('../../../src/desktop/preload/Preload.js');
  electron.invoke.mockClear();
  const bridge = electron.expose.mock.calls[0]?.[1];
  if (!bridge?.controlClassroomInsights || !bridge.exportParentReport) {
    throw new Error('Missing insight bridge');
  }
  const id = '11111111-1111-4111-8111-111111111111';
  electron.invoke.mockResolvedValue({
    kind: 'status',
    enabled: false,
    teacher: true,
    students: [],
    activities: [],
    plans: [],
    mappings: [],
  });
  expect((await bridge.controlClassroomInsights({ kind: 'status', classId: id })).kind).toBe(
    'status',
  );
  expect(electron.invoke).toHaveBeenCalledWith('tro:classroom-insights', {
    kind: 'status',
    classId: id,
  });
  const calls = electron.invoke.mock.calls.length;
  expect(
    await bridge.exportParentReport({ classId: '/private', reportId: id, expectedVersion: 1 }),
  ).toEqual({ saved: false, code: 'unavailable' });
  expect(electron.invoke.mock.calls).toHaveLength(calls);
  electron.invoke.mockResolvedValue({ saved: true, code: null, path: '/private' });
  expect(
    await bridge.exportParentReport({ classId: id, reportId: id, expectedVersion: 1 }),
  ).toEqual({ saved: false, code: 'unavailable' });
  electron.invoke.mockResolvedValue({ kind: 'status', enabled: true, cookie: 'secret' });
  expect(await bridge.controlClassroomInsights({ kind: 'status', classId: id })).toEqual({
    kind: 'failed',
    code: 'unavailable',
  });
});

it('routes a validated lesson answer over the registered agent IPC and rejects malformed replies', async () => {
  await import('../../../src/desktop/preload/Preload.js');
  electron.invoke.mockClear();
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

it('validates preview IDs and permits only original-file or failure replies', async () => {
  await import('../../../src/desktop/preload/Preload.js');
  electron.invoke.mockClear();
  const bridge = electron.expose.mock.calls[0]?.[1];
  if (!bridge?.previewClassMaterial) {
    throw new Error('Missing preview bridge');
  }
  const classId = '11111111-1111-4111-8111-111111111111';
  const materialId = '22222222-2222-4222-8222-222222222222';
  expect((await bridge.previewClassMaterial(classId, '/private/file.pdf')).kind).toBe('failed');
  expect(electron.invoke).not.toHaveBeenCalled();
  const original = { kind: 'download', name: 'Lesson.pdf', data: 'cGRm' };
  electron.invoke.mockResolvedValue(original);
  expect(await bridge.previewClassMaterial(classId, materialId)).toEqual(original);
  expect(electron.invoke).toHaveBeenCalledWith('tro:class-material-preview', {
    kind: 'download',
    classId,
    materialId,
  });
  electron.invoke.mockResolvedValue({ ...original, name: '../Private.pdf' });
  expect((await bridge.previewClassMaterial(classId, materialId)).kind).toBe('failed');
  electron.invoke.mockResolvedValue({ kind: 'collection', collection: {} });
  expect((await bridge.previewClassMaterial(classId, materialId)).kind).toBe('failed');
});

it('validates narrow practice capture requests and rejects native window IDs in replies', async () => {
  await import('../../../src/desktop/preload/Preload.js');
  electron.invoke.mockClear();
  const bridge = electron.expose.mock.calls[0]?.[1];
  if (!bridge?.controlPracticeCapture) {
    throw new Error('Missing capture bridge');
  }
  electron.invoke.mockResolvedValue({
    kind: 'windows',
    windows: [{ id: 'native:123', name: 'Scratch' }],
  });
  expect(await bridge.controlPracticeCapture({ kind: 'list' })).toMatchObject({ kind: 'failed' });
  expect(electron.invoke).toHaveBeenCalledWith('tro:practice-capture', { kind: 'list' });
  electron.invoke.mockResolvedValue({ kind: 'discarded' });
  expect(await bridge.controlPracticeCapture({ kind: 'discard' })).toEqual({ kind: 'discarded' });
});
