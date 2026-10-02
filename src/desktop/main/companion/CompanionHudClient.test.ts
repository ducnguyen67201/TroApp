import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionHudPhase } from '#contracts/CompanionHud.js';
import type { DesktopDriverPort } from '../DesktopDriverPort.js';
import { CompanionHudClient } from './CompanionHudClient.js';
const doubles = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: doubles.fork } }));
const connection = {
  command: '/tro/cua-driver',
  args: ['mcp', '--embedded', '--socket', '/private/tro.sock'],
  env: { CUA_DRIVER_EMBEDDED: '1' },
};
const driver = { start: vi.fn<DesktopDriverPort['start']>().mockResolvedValue(connection) };
class Child extends EventEmitter {
  postMessage = vi.fn<(message: unknown) => void>();
  kill = vi.fn<() => void>(() => {
    this.emit('exit');
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('persistent HUD presentation connection', () => {
  it('replays only the latest snapshot when the connection becomes ready', async () => {
    vi.useFakeTimers();
    const child = new Child();
    doubles.fork.mockReturnValue(child);
    const client = new CompanionHudClient('/worker', driver);
    const starting = client.start();
    await Promise.resolve();
    client.showSnapshot({ phase: CompanionHudPhase.LISTENING, locale: 'en', level: 0.5 });
    client.showSnapshot({ phase: CompanionHudPhase.TRANSCRIBING, locale: 'en', level: 0 });
    child.emit('spawn');
    expect(child.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ desktopDriver: connection });
    child.emit('message', { ready: true });
    await starting;
    expect(child.postMessage.mock.calls.at(-1)?.[0]).toEqual({
      kind: 'snapshot',
      snapshot: { phase: CompanionHudPhase.TRANSCRIBING, locale: 'en', level: 0 },
    });
    await client.start();
    expect(doubles.fork).toHaveBeenCalledTimes(1);
    client.dispose();
    vi.advanceTimersByTime(60_000);
    expect(doubles.fork).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect a disposed HUD while the host is starting', async () => {
    let finishConnection: (value: typeof connection) => void = () => {};
    const slowDriver = {
      start: vi.fn<DesktopDriverPort['start']>().mockReturnValue(
        new Promise((resolve) => {
          finishConnection = resolve;
        }),
      ),
    };
    const client = new CompanionHudClient('/worker', slowDriver);
    const starting = client.start();
    client.dispose();
    finishConnection(connection);
    await starting;
    expect(doubles.fork).not.toHaveBeenCalled();
  });
  it('bounds failed reconnects and kills the independent presentation process on sign-out', async () => {
    vi.useFakeTimers();
    const children: Child[] = [];
    doubles.fork.mockImplementation(() => {
      const child = new Child();
      children.push(child);
      return child;
    });
    const client = new CompanionHudClient('/worker', driver);
    const starting = client.start();
    await Promise.resolve();
    children[0]?.emit('exit');
    await starting;
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(5000);
      children.at(-1)?.emit('exit');
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(4);
    client.dispose();
  });
});
