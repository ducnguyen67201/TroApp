import { afterEach, expect, it, vi } from 'vitest';
import {
  IdleCursorFollowing,
  type IdleCursorTransport,
} from '../../../../src/desktop/worker/companion/IdleCursorFollowing.js';

function createHarness() {
  vi.useFakeTimers();
  const callToolResult = vi
    .fn<IdleCursorTransport['callToolResult']>()
    .mockImplementation((_name, args) =>
      Promise.resolve({
        content: [],
        structuredContent: { status: 'state', following: args['mode'] === 'follow', active: false },
      }),
    );
  const failure = vi.fn<() => void>();
  const cursor = new IdleCursorFollowing({ callToolResult }, failure);
  return { cursor, callToolResult, failure };
}

afterEach(() => {
  vi.useRealTimers();
});

it('acknowledges hidden after queued renewal and does not renew while suspended', async () => {
  const { cursor, callToolResult } = createHarness();
  await cursor.setEnabled(true);
  await vi.advanceTimersByTimeAsync(15_000);
  await cursor.setEnabled(false);
  expect(callToolResult.mock.calls.at(-1)?.[1]).toEqual({ mode: 'hidden' });
  const calls = callToolResult.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(callToolResult).toHaveBeenCalledTimes(calls);
  await cursor.setEnabled(true);
  expect(callToolResult.mock.calls.at(-1)?.[1]).toEqual({ mode: 'follow', label: 'Tro' });
  cursor.dispose();
});

it('rejects invalid release receipts instead of granting ownership', async () => {
  const { cursor, callToolResult } = createHarness();
  callToolResult.mockResolvedValue({ content: [], structuredContent: { following: true } });
  await expect(cursor.setEnabled(false)).rejects.toThrow('ownership');
  cursor.dispose();
});

it('stops renewal and reports a transport failure once', async () => {
  const { cursor, callToolResult, failure } = createHarness();
  await cursor.setEnabled(true);
  callToolResult.mockRejectedValue(new Error('transport'));
  await vi.advanceTimersByTimeAsync(15_000);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(failure).toHaveBeenCalledOnce();
  cursor.dispose();
});

it('fences queued acquisition when the presentation connection is disposed', async () => {
  const { cursor, callToolResult } = createHarness();
  const acquiring = cursor.setEnabled(true);
  cursor.dispose();
  await expect(acquiring).rejects.toThrow('closed');
  expect(callToolResult).not.toHaveBeenCalled();
});
