import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';

const doubles = vi.hoisted(() => {
  const exposed: { bridge: DesktopBridge | null } = { bridge: null };
  const listeners = new Map<string, (event: unknown, raw: unknown) => void>();
  return {
    exposed,
    listeners,
    invoke: vi.fn<(channel: string, command: unknown) => Promise<unknown>>(),
    exposeInMainWorld: (name: string, bridge: DesktopBridge) => {
      if (name === 'tro') {
        exposed.bridge = bridge;
      }
    },
    on: (name: string, listener: (event: unknown, raw: unknown) => void) => {
      listeners.set(name, listener);
    },
    removeListener: (name: string) => {
      listeners.delete(name);
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: doubles.exposeInMainWorld },
  ipcRenderer: { invoke: doubles.invoke, on: doubles.on, removeListener: doubles.removeListener },
}));

await import('./Preload.js');

function readBridge(): DesktopBridge {
  if (!doubles.exposed.bridge) {
    throw new Error('Preload bridge is missing');
  }
  return doubles.exposed.bridge;
}

beforeEach(() => {
  doubles.invoke.mockReset();
  doubles.listeners.clear();
});

describe('update preload boundary', () => {
  it('exposes only named update operations and validates replies', async () => {
    doubles.invoke.mockResolvedValue({
      kind: 'ok',
      snapshot: { revision: 2, status: { state: 'available', version: '0.2.0' } },
    });
    const bridge = readBridge();
    expect((await bridge.readAppUpdate()).status.state).toBe('available');
    await bridge.checkAppUpdate();
    await bridge.downloadAppUpdate();
    await bridge.restartForAppUpdate();
    expect(doubles.invoke.mock.calls).toEqual([
      ['tro:update-command', { kind: 'status' }],
      ['tro:update-command', { kind: 'check' }],
      ['tro:update-command', { kind: 'download' }],
      ['tro:update-command', { kind: 'restart' }],
    ]);
    doubles.invoke.mockResolvedValue({
      kind: 'ok',
      snapshot: { revision: 3, status: { state: 'ready', version: 123 } },
    });
    expect(await bridge.downloadAppUpdate()).toEqual({ kind: 'failed', reason: 'unavailable' });
  });

  it('drops invalid progress and releases exactly its event subscription', () => {
    const bridge = readBridge();
    const receive = vi.fn<Parameters<DesktopBridge['subscribeAppUpdate']>[0]>();
    const unsubscribe = bridge.subscribeAppUpdate(receive);
    const rawListener = doubles.listeners.get('tro:update-event');
    rawListener?.(
      {},
      { revision: 2, status: { state: 'downloading', version: '0.2.0', percent: 48 } },
    );
    expect(receive).toHaveBeenCalledOnce();
    rawListener?.(
      {},
      { revision: 3, status: { state: 'downloading', version: '0.2.0', percent: 101 } },
    );
    rawListener?.(
      {},
      { revision: 3, status: { state: 'available', version: '0.2.0', url: 'https://evil.test' } },
    );
    expect(receive).toHaveBeenCalledOnce();
    unsubscribe();
    expect(doubles.listeners.has('tro:update-event')).toBe(false);
  });
});
