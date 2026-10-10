import { channel } from 'node:diagnostics_channel';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createBenchmarkModelFetch,
  readGuidedLessonBenchmarkOptions,
  sumBenchmarkModelUsage,
  type BenchmarkModelMeasurement,
} from '../../scripts/GuidedLessonBenchmarkMeasurements.js';

describe('manual guided lesson benchmark measurement', () => {
  it('records provider subsets without adding them to total tokens or consuming the response', async () => {
    const response = {
      id: 'resp_example',
      model: 'example-model',
      status: 'completed',
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        total_tokens: 130,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 10 },
      },
      output_text: 'PRIVATE GENERATED MATERIAL',
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(response, { headers: { 'x-request-id': 'req_example' } }));
    const measurements: BenchmarkModelMeasurement[] = [];
    const observedFetch = createBenchmarkModelFetch(
      () => 'draft',
      (measurement) => measurements.push(measurement),
      request,
    );
    const returned = await observedFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'example-model', instructions: 'PRIVATE PROMPT' }),
      headers: { authorization: 'Bearer PRIVATE KEY' },
    });
    const returnedBody: unknown = await returned.json();
    expect(returnedBody).toEqual(response);
    expect(measurements[0]).toMatchObject({
      stage: 'draft',
      kind: 'generation',
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 20,
      reasoningOutputTokens: 10,
      requestId: 'req_example',
    });
    expect(sumBenchmarkModelUsage(measurements)).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 20,
      reasoningOutputTokens: 10,
      unknownGenerationRequests: 0,
      unknownCachedInputRequests: 0,
      unknownCacheWriteRequests: 0,
      unknownReasoningRequests: 0,
    });
    expect(JSON.stringify(measurements)).not.toContain('PRIVATE');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forwards the original transport input, headers, body and options without reconstructing a Request', async () => {
    const controller = new AbortController();
    const input = new URL('https://api.openai.com/v1/responses');
    const options = {
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer PRIVATE KEY', 'x-example': 'preserved' }),
      body: JSON.stringify({ instructions: 'PRIVATE PROMPT' }),
      signal: controller.signal,
      credentials: 'omit',
    } satisfies RequestInit;
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'completed' }));
    const measurements: BenchmarkModelMeasurement[] = [];
    const returned = await createBenchmarkModelFetch(
      () => 'remotionCoding',
      (measurement) => measurements.push(measurement),
      request,
      { observeTransport: true },
    )(input, options);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(input);
    expect(request.mock.calls[0]?.[1]).toBe(options);
    expect(options.headers.get('x-example')).toBe('preserved');
    expect(options.signal).toBe(controller.signal);
    expect(await returned.json()).toEqual({ status: 'completed' });
    expect(measurements[0]).toMatchObject({
      aborted: false,
      transport: { transportObserved: false },
    });
    expect(JSON.stringify(measurements)).not.toContain('PRIVATE');
  });

  it('forwards cancellation to the injected transport and retains its original rejection without retrying', async () => {
    const controller = new AbortController();
    const cancellation = new Error('PRIVATE cancellation reason');
    const request = vi.fn<typeof fetch>((_input, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error('The fixture requires a cancellation signal.');
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(cancellation);
          },
          { once: true },
        );
      });
    });
    const measurements: BenchmarkModelMeasurement[] = [];
    const pending = createBenchmarkModelFetch(
      () => 'remotionCoding',
      (measurement) => measurements.push(measurement),
      request,
      { observeTransport: true },
    )('https://api.openai.com/v1/responses', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBe(cancellation);
    expect(request).toHaveBeenCalledTimes(1);
    expect(measurements[0]).toMatchObject({ aborted: true, status: 'unknown' });
    expect(JSON.stringify(measurements)).not.toContain('PRIVATE');
  });

  it('retains bounded native socket evidence without request content or raw errors', async () => {
    const socket = new Socket();
    const failure = Object.assign(new Error('PRIVATE SOCKET DETAILS'), { code: 'EPIPE' });
    const request = vi.fn<typeof fetch>(() => {
      const nativeRequest = {};
      channel('undici:request:create').publish({ request: nativeRequest });
      channel('undici:client:sendHeaders').publish({ request: nativeRequest, socket });
      socket.emit('error', failure);
      channel('undici:request:error').publish({ request: nativeRequest });
      return Promise.reject(failure);
    });
    const measurements: BenchmarkModelMeasurement[] = [];
    try {
      await expect(
        createBenchmarkModelFetch(
          () => 'remotionCoding',
          (measurement) => measurements.push(measurement),
          request,
          { observeTransport: true },
        )('https://api.openai.com/v1/responses', { body: 'PRIVATE INPUT', method: 'POST' }),
      ).rejects.toBe(failure);
      expect(request).toHaveBeenCalledTimes(1);
      expect(measurements[0]).toMatchObject({
        status: 'unknown',
        transport: {
          transportObserved: true,
          socketAssigned: true,
          providerHeadersReceived: false,
        },
        socketFailure: { socketErrorCode: 'EPIPE', socketErrorFamily: 'system' },
      });
      expect(JSON.stringify(measurements)).not.toContain('PRIVATE');
    } finally {
      socket.destroy();
    }
  });

  it('separates input counting from generation, including usage for truncated responses', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ input_tokens: 50 }))
      .mockResolvedValueOnce(
        Response.json({
          id: 'resp_incomplete',
          status: 'incomplete',
          usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
        }),
      );
    const measurements: BenchmarkModelMeasurement[] = [];
    const observedFetch = createBenchmarkModelFetch(
      () => 'review',
      (measurement) => measurements.push(measurement),
      request,
    );
    await observedFetch('https://api.openai.com/v1/responses/input_tokens');
    await observedFetch('https://api.openai.com/v1/responses');
    expect(measurements[0]).toMatchObject({ kind: 'inputCount', countedInputTokens: 50 });
    expect(measurements[1]).toMatchObject({ status: 'incomplete', totalTokens: 70 });
    expect(sumBenchmarkModelUsage(measurements)).toMatchObject({ totalTokens: 70 });
  });

  it('preserves an unknown outcome without replaying a failed request or logging its error', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('PRIVATE NETWORK DETAILS'));
    const measurements: BenchmarkModelMeasurement[] = [];
    const observedFetch = createBenchmarkModelFetch(
      () => 'visualReview',
      (measurement) => measurements.push(measurement),
      request,
    );
    await expect(observedFetch('https://api.openai.com/v1/responses')).rejects.toThrow();
    expect(measurements[0]).toMatchObject({ status: 'unknown', totalTokens: null });
    expect(sumBenchmarkModelUsage(measurements)).toMatchObject({
      totalTokens: 0,
      unknownGenerationRequests: 1,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(measurements)).not.toContain('PRIVATE');
  });

  it('distinguishes unavailable usage subsets from provider-reported zero', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: 'completed',
          usage: {
            input_tokens: 100,
            output_tokens: 30,
            total_tokens: 130,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      );
    const measurements: BenchmarkModelMeasurement[] = [];
    const observedFetch = createBenchmarkModelFetch(
      () => 'draft',
      (measurement) => measurements.push(measurement),
      request,
    );
    await observedFetch('https://api.openai.com/v1/responses');
    await observedFetch('https://api.openai.com/v1/responses');

    expect(measurements[0]).toMatchObject({
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      reasoningOutputTokens: null,
    });
    expect(measurements[1]).toMatchObject({
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(sumBenchmarkModelUsage(measurements)).toMatchObject({
      totalTokens: 260,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      unknownGenerationRequests: 0,
      unknownCachedInputRequests: 1,
      unknownCacheWriteRequests: 1,
      unknownReasoningRequests: 1,
    });
  });

  it.each([
    { input_tokens: -1, output_tokens: 3, total_tokens: 2 },
    { input_tokens: 10, output_tokens: 3, total_tokens: 100 },
    {
      input_tokens: 10,
      output_tokens: 3,
      total_tokens: 13,
      output_tokens_details: { reasoning_tokens: 4 },
    },
  ])('does not present malformed provider usage as measured billing evidence', async (usage) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { status: 'completed', usage },
          { headers: { 'x-request-id': 'invalid id' } },
        ),
      );
    const measurements: BenchmarkModelMeasurement[] = [];
    await createBenchmarkModelFetch(
      () => 'draft',
      (measurement) => measurements.push(measurement),
      request,
    )('https://api.openai.com/v1/responses');
    expect(measurements[0]).toMatchObject({ requestId: null, totalTokens: null });
    expect(sumBenchmarkModelUsage(measurements).unknownGenerationRequests).toBe(1);
  });

  it('defaults to one short run and rejects unsupported run options', () => {
    expect(readGuidedLessonBenchmarkOptions([])).toEqual({
      language: 'en',
      seconds: 30,
      runs: 1,
      help: false,
    });
    expect(
      readGuidedLessonBenchmarkOptions(['--language', 'vi', '--seconds', '120', '--runs', '3']),
    ).toMatchObject({ language: 'vi', seconds: 120, runs: 3 });
    expect(() => readGuidedLessonBenchmarkOptions(['--runs', '4'])).toThrow();
    expect(() => readGuidedLessonBenchmarkOptions(['--seconds', '10'])).toThrow();
    expect(() => readGuidedLessonBenchmarkOptions(['--unknown'])).toThrow();
  });
});
