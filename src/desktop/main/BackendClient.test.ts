import { describe, expect, it, vi } from 'vitest';
import { fetchServiceStatus } from './BackendClient.js';
import { readDesktopEnv } from './Env.js';
import { isTrustedFrameUrl } from './TrustedFrame.js';

const desktopEnvSource = {
  environment: {},
  bundledAppEnvironment: undefined,
  isPackaged: false,
};

describe('desktop network boundary', () => {
  it('rejects an invalid successful HTTP response', async () => {
    const fetchResponse = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ service: 'wrong', database: 'ready' })));

    await expect(fetchServiceStatus('http://127.0.0.1:3000', fetchResponse)).rejects.toThrow();
    expect(fetchResponse).toHaveBeenCalledTimes(1);
  });

  it('retries one network failure before returning a validated status', async () => {
    const fetchResponse = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ service: 'tro-api', database: 'ready' })),
      );

    await expect(fetchServiceStatus('https://api.example.test', fetchResponse)).resolves.toEqual({
      service: 'tro-api',
      database: 'ready',
    });
    expect(fetchResponse).toHaveBeenCalledTimes(2);
  });

  it('retries a temporary gateway failure but not a client error', async () => {
    const gatewayFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ service: 'tro-api', database: 'ready' })),
      );

    await expect(fetchServiceStatus('https://api.example.test', gatewayFetch)).resolves.toEqual({
      service: 'tro-api',
      database: 'ready',
    });
    expect(gatewayFetch).toHaveBeenCalledTimes(2);

    const clientErrorFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));

    await expect(fetchServiceStatus('https://api.example.test', clientErrorFetch)).rejects.toThrow(
      'The backend is unavailable.',
    );
    expect(clientErrorFetch).toHaveBeenCalledTimes(1);
  });

  it('uses the fixed endpoint with a timeout and refuses redirects', async () => {
    const fetchResponse = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ service: 'tro-api', database: 'ready' })));

    await fetchServiceStatus('https://api.example.test', fetchResponse);

    const call = fetchResponse.mock.calls[0];

    if (!call) {
      throw new Error('The backend request was not made.');
    }

    expect(call[0]).toEqual(new URL('https://api.example.test/api/v1/system/status'));
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(call[1]?.redirect).toBe('error');
  });

  it('rejects non-local plaintext URLs and embedded credentials', () => {
    expect(() =>
      readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: 'http://example.test' }),
    ).toThrow('Desktop configuration is invalid.');
    expect(() =>
      readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: 'https://user:password@example.test' }),
    ).toThrow('Desktop configuration is invalid.');
  });

  it('uses the local API by default', () => {
    expect(readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: undefined }).API_BASE_URL).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('defaults to dev locally and prod when packaged, with an explicit stage mode', () => {
    expect(readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: undefined }).APP_ENV).toBe('dev');
    expect(
      readDesktopEnv({ ...desktopEnvSource, bundledApiUrl: undefined, isPackaged: true }).APP_ENV,
    ).toBe('prod');
    expect(
      readDesktopEnv({
        ...desktopEnvSource,
        bundledApiUrl: undefined,
        bundledAppEnvironment: 'stage',
        isPackaged: true,
      }).APP_ENV,
    ).toBe('stage');
    expect(() =>
      readDesktopEnv({
        ...desktopEnvSource,
        bundledApiUrl: undefined,
        bundledAppEnvironment: 'test',
      }),
    ).toThrow('Desktop configuration is invalid.');
  });
});

describe('IPC document boundary', () => {
  it('rejects a foreign document even on the same origin', () => {
    expect(isTrustedFrameUrl('http://127.0.0.1:5173/foreign', 'http://127.0.0.1:5173/')).toBe(
      false,
    );
    expect(isTrustedFrameUrl('https://example.test/', 'http://127.0.0.1:5173/')).toBe(false);
    expect(isTrustedFrameUrl('file:///tmp/foreign.html', 'file:///app/index.html')).toBe(false);
  });

  it('permits hash changes in the application document', () => {
    expect(isTrustedFrameUrl('file:///app/index.html#settings', 'file:///app/index.html')).toBe(
      true,
    );
  });
});
