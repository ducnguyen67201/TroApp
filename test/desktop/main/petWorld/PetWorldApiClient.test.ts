import { describe, expect, it, vi } from 'vitest';
import { PetWorldCommandKind, PetWorldFailure } from '#contracts/PetWorld.js';
import { PetWorldApiClient } from '../../../../src/desktop/main/petWorld/PetWorldApiClient.js';

describe('pet world authenticated transport', () => {
  it('requires a cookie and rejects malformed replies without exposing transport data', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'catalog',
          catalog: { revision: '1', items: [], secret: 'unexpected' },
        }),
      ),
    );
    const signedOut = new PetWorldApiClient('https://api.example.test', () => null, request);
    expect(await signedOut.execute({ kind: PetWorldCommandKind.CATALOG })).toEqual({
      kind: 'failed',
      code: PetWorldFailure.UNAUTHORIZED,
    });
    expect(request).not.toHaveBeenCalled();
    const signedIn = new PetWorldApiClient(
      'https://api.example.test',
      () => 'session=cookie',
      request,
    );
    expect(await signedIn.execute({ kind: PetWorldCommandKind.CATALOG })).toEqual({
      kind: 'failed',
      code: PetWorldFailure.UNAVAILABLE,
    });
    expect(request).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/pet-world/command',
      expect.objectContaining({
        method: 'POST',
        headers: { cookie: 'session=cookie', 'content-type': 'application/json' },
      }),
    );
  });

  it('fences replies if the account cookie changes during the request', async () => {
    let cookie = 'old';
    const request = vi.fn<typeof fetch>().mockImplementation(() => {
      cookie = 'new';
      return Promise.resolve(
        new Response(JSON.stringify({ kind: 'catalog', catalog: { revision: '1', items: [] } })),
      );
    });
    const client = new PetWorldApiClient('https://api.example.test', () => cookie, request);
    expect(await client.execute({ kind: PetWorldCommandKind.CATALOG })).toEqual({
      kind: 'failed',
      code: PetWorldFailure.UNAVAILABLE,
    });
  });
});
