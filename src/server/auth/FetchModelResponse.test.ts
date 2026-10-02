import { describe, expect, it, vi } from 'vitest';
import { fetchModelResponse } from './FetchModelResponse.js';

describe('bounded model-only socket recovery', () => {
  it.each(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'])(
    'retries %s once with the same model request',
    async (code) => {
      const response = new Response('{}');
      const provider = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('private network detail', { cause: { code } }))
        .mockResolvedValueOnce(response);
      const reportRetry = vi.fn<(error: unknown) => void>().mockReturnValue(undefined);
      try {
        expect(
          await fetchModelResponse(
            'private-provider-key',
            'private-model-input',
            new AbortController().signal,
            reportRetry,
          ),
        ).toBe(response);
        expect(provider).toHaveBeenCalledTimes(2);
        expect(provider.mock.calls[0]).toEqual(provider.mock.calls[1]);
        expect(reportRetry).toHaveBeenCalledOnce();
      } finally {
        provider.mockRestore();
      }
    },
  );

  it('stops after one retry when the connection fails again', async () => {
    const failure = new TypeError('private', { cause: { code: 'UND_ERR_SOCKET' } });
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    const reportRetry = vi.fn<(error: unknown) => void>().mockReturnValue(undefined);
    try {
      await expect(
        fetchModelResponse('private-key', '{}', new AbortController().signal, reportRetry),
      ).rejects.toBe(failure);
      expect(provider).toHaveBeenCalledTimes(2);
      expect(reportRetry).toHaveBeenCalledOnce();
    } finally {
      provider.mockRestore();
    }
  });

  it.each(['ENOTFOUND', 'CERT_HAS_EXPIRED', 'ETIMEDOUT', 'UNKNOWN'])(
    'does not retry other network failures: %s',
    async (code) => {
      const failure = new TypeError('private', { cause: { code } });
      const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
      const reportRetry = vi.fn<(error: unknown) => void>();
      try {
        await expect(
          fetchModelResponse('private-key', '{}', new AbortController().signal, reportRetry),
        ).rejects.toBe(failure);
        expect(provider).toHaveBeenCalledOnce();
        expect(reportRetry).not.toHaveBeenCalled();
      } finally {
        provider.mockRestore();
      }
    },
  );

  it('cancels during the retry delay without reporting a retry or dispatching again', async () => {
    const cancellation = new AbortController();
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('private', { cause: { code: 'UND_ERR_SOCKET' } }));
    const reportRetry = vi.fn<(error: unknown) => void>();
    try {
      const attempt = fetchModelResponse('private-key', '{}', cancellation.signal, reportRetry);
      const rejection = expect(attempt).rejects.toThrow();
      await Promise.resolve();
      cancellation.abort();
      await rejection;
      expect(provider).toHaveBeenCalledOnce();
      expect(reportRetry).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });

  it('does not retry a provider response, even when its body later fails', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('private body'));
        },
      }),
    );
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const reportRetry = vi.fn<(error: unknown) => void>();
    try {
      expect(
        await fetchModelResponse('private-key', '{}', new AbortController().signal, reportRetry),
      ).toBe(response);
      await expect(response.text()).rejects.toThrow();
      expect(provider).toHaveBeenCalledOnce();
      expect(reportRetry).not.toHaveBeenCalled();
    } finally {
      provider.mockRestore();
    }
  });
});
