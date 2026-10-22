import { expect, it, vi } from 'vitest';
import { ContextApiClient } from '../../../../src/desktop/main/context/ContextApiClient.js';
import { ContextFailure } from '../../../../src/contracts/StudyContext.js';

it('keeps cookies in main and returns unavailable for malformed API replies', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ kind: 'accepted', revision: 1 })));
  const client = new ContextApiClient('https://example.test', () => 'synthetic-cookie', request);
  expect(await client.execute({ kind: 'preferences' })).toEqual({ kind: 'accepted', revision: 1 });
  expect(request.mock.calls[0]?.[1]?.headers).toEqual({
    cookie: 'synthetic-cookie',
    'content-type': 'application/json',
  });
  const anonymous = new ContextApiClient('https://example.test', () => null, request);
  expect(await anonymous.execute({ kind: 'preferences' })).toEqual({
    kind: 'failed',
    code: ContextFailure.UNAUTHORIZED,
  });
  request.mockResolvedValueOnce(new Response('{}'));
  expect(await client.execute({ kind: 'preferences' })).toEqual({
    kind: 'failed',
    code: ContextFailure.UNAVAILABLE,
  });
});
