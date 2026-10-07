import { expect, it, vi } from 'vitest';
import { PracticeCheckApiClient } from '../../../../src/desktop/main/classroom/PracticeCheckApiClient.js';
import { randomUUID } from 'node:crypto';
const command = {
  kind: 'history' as const,
  participationId: randomUUID(),
  deviceId: randomUUID(),
  activityId: randomUUID(),
};
it('attaches credentials in main and fences replies from another account', async () => {
  let cookie: string | null = 'private-cookie';
  const request = vi.fn<typeof fetch>().mockImplementation(() => {
    cookie = 'other-cookie';
    return Promise.resolve(
      new Response(JSON.stringify({ kind: 'history', checks: [], submissions: [] })),
    );
  });
  const api = new PracticeCheckApiClient('http://127.0.0.1:3000', () => cookie, request);
  expect(await api.execute(command)).toEqual({ kind: 'failed', code: 'stale' });
  expect(request.mock.calls[0]?.[1]?.headers).toEqual({
    cookie: 'private-cookie',
    'content-type': 'application/json',
  });
  cookie = null;
  expect(await api.execute(command)).toEqual({ kind: 'failed', code: 'forbidden' });
  expect(request).toHaveBeenCalledOnce();
});
it('rejects malformed provider replies at the main boundary', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ kind: 'history', checks: [{ secret: 'private' }], submissions: [] }),
      ),
    );
  expect(
    await new PracticeCheckApiClient('http://localhost', () => 'cookie', request).execute(command),
  ).toEqual({ kind: 'failed', code: 'unavailable' });
});
