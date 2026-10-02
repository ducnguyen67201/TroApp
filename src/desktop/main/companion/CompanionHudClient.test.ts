import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanionHudPhase } from '#contracts/CompanionHud.js';
import { CompanionHudClient } from './CompanionHudClient.js';
const doubles = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: doubles.fork } }));
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
    const client = new CompanionHudClient('/worker');
    const starting = client.start();
    client.showSnapshot({ phase: CompanionHudPhase.LISTENING, locale: 'en', level: 0.5 });
    client.showSnapshot({ phase: CompanionHudPhase.TRANSCRIBING, locale: 'en', level: 0 });
    child.emit('spawn');
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
  it('bounds failed reconnects and kills the independent presentation process on sign-out', async () => {
    vi.useFakeTimers();
    const children: Child[] = [];
    doubles.fork.mockImplementation(() => {
      const child = new Child();
      children.push(child);
      return child;
    });
    const client = new CompanionHudClient('/worker');
    const starting = client.start();
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
