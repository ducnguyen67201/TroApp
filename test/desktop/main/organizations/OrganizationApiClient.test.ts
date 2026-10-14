import { expect, it, vi } from 'vitest';
import { OrganizationAction, OrganizationFailure } from '#contracts/Organizations.js';
import { OrganizationApiClient } from '../../../../src/desktop/main/organizations/OrganizationApiClient.js';

it('keeps the session cookie in main and never sends classroom delegation authority', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ kind: 'home', organizations: [], isAdmin: false }));
  const client = new OrganizationApiClient(
    'https://api.example.test',
    () => 'session=secret',
    request,
  );
  expect(await client.execute({ kind: OrganizationAction.HOME })).toEqual({
    kind: 'home',
    organizations: [],
    isAdmin: false,
  });
  expect(request).toHaveBeenCalledOnce();
  const [url, options] = request.mock.calls[0] ?? [];
  expect(url).toBe('https://api.example.test/api/v1/organizations/command');
  expect(options?.method).toBe('POST');
  expect(options?.headers).toEqual({
    cookie: 'session=secret',
    'content-type': 'application/json',
  });
  expect(options?.body).toBe(JSON.stringify({ kind: OrganizationAction.HOME }));
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

it('does not fetch without a session and rejects malformed or secret-bearing replies', async () => {
  const request = vi.fn<typeof fetch>();
  expect(
    await new OrganizationApiClient('https://api.example.test', () => null, request).execute({
      kind: OrganizationAction.HOME,
    }),
  ).toEqual({ kind: 'failed', code: OrganizationFailure.UNAUTHORIZED });
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue(
    Response.json({ kind: 'home', organizations: [], isAdmin: false, cookie: 'secret' }),
  );
  expect(
    await new OrganizationApiClient(
      'https://api.example.test',
      () => 'session=secret',
      request,
    ).execute({ kind: OrganizationAction.HOME }),
  ).toEqual({ kind: 'failed', code: OrganizationFailure.UNAVAILABLE });
});
