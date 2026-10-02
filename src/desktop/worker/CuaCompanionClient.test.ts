import { describe, expect, it, vi, afterEach } from 'vitest';
import { CuaCompanionClient, type CompanionTransport } from './CuaCompanionClient.js';
import type { CallToolResult } from '@openai/agents';

function modeResult(following: boolean): CallToolResult {
  return {
    content: [],
    structuredContent: { status: following ? 'following' : 'hidden', following, active: false },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Cua companion lifecycle', () => {
  it('orders hide after an in-flight renewal and never renews a closed session', async () => {
    vi.useFakeTimers();
    let finishRenewal: ((result: CallToolResult) => void) | undefined;
    const callHostTool = vi
      .fn<CompanionTransport['callHostTool']>()
      .mockResolvedValueOnce(modeResult(true))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRenewal = resolve;
          }),
      )
      .mockResolvedValue(modeResult(false));
    const client = new CuaCompanionClient({ callHostTool });
    await client.startFollowing();
    await vi.advanceTimersByTimeAsync(15_000);
    const closing = client.close();
    expect(callHostTool).toHaveBeenCalledTimes(2);
    finishRenewal?.(modeResult(true));
    await closing;
    expect(callHostTool).toHaveBeenLastCalledWith('set_cursor_companion_mode', { mode: 'hidden' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(callHostTool).toHaveBeenCalledTimes(3);
    await expect(client.startFollowing()).rejects.toThrow('closed');
  });

  it('refuses a native error or malformed mode acknowledgement', async () => {
    const callHostTool = vi
      .fn<CompanionTransport['callHostTool']>()
      .mockResolvedValueOnce({ content: [], isError: true })
      .mockResolvedValueOnce({ content: [], structuredContent: { status: 'following' } });
    const client = new CuaCompanionClient({ callHostTool });
    await expect(client.startFollowing()).rejects.toThrow('unavailable');
    await expect(client.startFollowing()).rejects.toThrow();
  });
  it('pauses following before native actions and stops lease renewal', async () => {
    vi.useFakeTimers();
    const callHostTool = vi
      .fn<CompanionTransport['callHostTool']>()
      .mockResolvedValueOnce(modeResult(true))
      .mockResolvedValueOnce(modeResult(false))
      .mockResolvedValue({ content: [], structuredContent: { enabled: true } });
    const client = new CuaCompanionClient({ callHostTool });
    await client.startFollowing();
    await client.pauseFollowing();
    expect(callHostTool.mock.calls.slice(1)).toEqual([
      ['set_cursor_companion_mode', { mode: 'hidden' }],
      ['set_agent_cursor_enabled', { enabled: true }],
    ]);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(callHostTool).toHaveBeenCalledTimes(3);
  });
});
