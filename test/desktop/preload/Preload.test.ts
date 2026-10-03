import { expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';

const electron = vi.hoisted(() => ({
  expose: vi.fn<(name: string, bridge: DesktopBridge) => void>(),
  invoke: vi.fn<(channel: string, command: unknown) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke },
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
