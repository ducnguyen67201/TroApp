import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  CuaCompanionClient,
  type CompanionTransport,
} from '../../../../src/desktop/worker/cua/CuaCompanionClient.js';
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
    await expect(client.startFollowing()).rejects.toMatchObject({ code: 'companion_mode_failed' });
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

describe('host-only V3 negotiation', () => {
  const epoch = '11111111-1111-4111-8111-111111111111';
  const capabilities = {
    presentation_versions: [3],
    task_lifecycle: true,
    paired_presentation: true,
    display_scope: 'primary',
    gestures: ['scribble'],
    max_strokes: 3,
    max_points_per_stroke: 32,
    max_duration_ms: 15000,
  };

  it('refuses unsupported drivers without beginning a legacy task', async () => {
    const callHostTool = vi.fn<CompanionTransport['callHostTool']>().mockResolvedValue({
      content: [],
      structuredContent: { ...capabilities, presentation_versions: [2] },
    });
    const client = new CuaCompanionClient({ callHostTool });
    await expect(client.beginGuidanceTask(epoch)).rejects.toThrow('unsupported_version');
    expect(callHostTool).toHaveBeenCalledOnce();
  });

  it('requires the current epoch and retains native takeover during finalization', async () => {
    const callHostTool = vi
      .fn<CompanionTransport['callHostTool']>()
      .mockResolvedValueOnce({ content: [], structuredContent: capabilities })
      .mockResolvedValueOnce({
        content: [],
        structuredContent: {
          status: 'task_ready',
          task_epoch: epoch,
          following: true,
          active: false,
        },
      })
      .mockResolvedValueOnce({
        content: [],
        isError: true,
        structuredContent: {
          status: 'canceled',
          task_epoch: epoch,
          sequence_id: null,
          following: true,
          active: false,
          reason: 'user_takeover',
        },
      });
    const client = new CuaCompanionClient({ callHostTool });
    await client.beginGuidanceTask(epoch);
    expect(callHostTool).toHaveBeenNthCalledWith(2, 'begin_cursor_guidance_task', {
      task_epoch: epoch,
      presentation_version: 3,
    });
    await expect(client.endGuidanceTask(epoch)).rejects.toMatchObject({
      reason: 'user_takeover',
      canceled: true,
    });
  });
});

it('latches failed following renewal, interrupts the active segment, and never silently restarts it', async () => {
  vi.useFakeTimers();
  const transport: CompanionTransport = {
    callHostTool: vi
      .fn<CompanionTransport['callHostTool']>()
      .mockResolvedValueOnce(modeResult(true))
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: 'private native error' }],
        structuredContent: {
          code: 'typed_output_mismatch',
          execution_state: 'unknown',
          detail: 'unknown field `guidance`, expected one of `status`, `following`, `active`',
        },
      })
      .mockResolvedValue(modeResult(false)),
  };
  const failure = vi.fn<() => void>();
  const companion = new CuaCompanionClient(transport);
  companion.setFollowingFailureListener(failure);
  try {
    await companion.startFollowing();
    await vi.advanceTimersByTimeAsync(15000);
    expect(failure).toHaveBeenCalledOnce();
    expect(() => {
      companion.assertFollowingAvailable();
    }).toThrow('could not renew');
    await expect(companion.startFollowing()).rejects.toMatchObject({
      code: 'companion_renewal_failed',
      reason: 'session_lost',
      details: {
        toolName: 'set_cursor_companion_mode',
        requestedMode: 'follow',
        nativeResult: {
          reasonCode: 'typed_output_mismatch',
          executionState: 'unknown',
          contractError: 'Native companion output contract rejects its guidance metadata.',
        },
      },
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(failure).toHaveBeenCalledOnce();
  } finally {
    await companion.close();
  }
});
