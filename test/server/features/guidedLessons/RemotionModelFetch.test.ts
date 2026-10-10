import OpenAI from 'openai';
import { Agent, Response as UndiciResponse, fetch as fetchUndici } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import { createRemotionModelFetch } from '../../../../src/server/features/guidedLessons/infrastructure/RemotionModelFetch.js';

describe('owned coding model transport', () => {
  it('retains TLS certificate verification and leaves address family selection to the runtime', async () => {
    const agents: Agent[] = [];
    const createAgent = vi.fn((options: Agent.Options) => {
      const agent = new Agent(options);
      agents.push(agent);
      return agent;
    });
    const dispatch = vi.fn<typeof fetchUndici>(() =>
      Promise.resolve(UndiciResponse.json({ status: 'completed' })),
    );
    await createRemotionModelFetch({ dispatch, createAgent })(
      'https://api.openai.com/v1/responses',
      { method: 'POST', body: '{}' },
    );
    expect(createAgent).toHaveBeenCalledExactlyOnceWith({
      connections: 1,
      pipelining: 0,
      connect: { rejectUnauthorized: true },
    });
    expect(dispatch.mock.calls[0]?.[1]?.dispatcher).toBe(agents[0]);
    expect(agents[0]?.closed).toBe(true);
  });

  it('forwards request bytes, headers and status and buffers the response before closing its agent', async () => {
    const agent = new Agent({ connections: 1, pipelining: 0 });
    const events: string[] = [];
    const close = vi.spyOn(agent, 'close');
    const text = '{"error":{"code":"rate_limit"}}';

    async function* readResponse() {
      expect(agent.closed).toBe(false);
      events.push('reading');
      await Promise.resolve();
      yield new TextEncoder().encode(text);
      expect(agent.closed).toBe(false);
      events.push('bodyRead');
    }

    const dispatch = vi.fn<typeof fetchUndici>(() =>
      Promise.resolve(
        new UndiciResponse(readResponse(), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_synthetic' },
        }),
      ),
    );
    const request = new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: '{"input":"Tiếng Việt"}',
      headers: { authorization: 'Bearer synthetic-test-key', 'content-type': 'application/json' },
    });
    const result = await createRemotionModelFetch({ dispatch, createAgent: () => agent })(request);
    const submitted = dispatch.mock.calls[0];
    expect(submitted?.[0]).toBe(request.url);
    expect(submitted?.[1]).toMatchObject({
      method: 'POST',
      dispatcher: agent,
      headers: {
        authorization: 'Bearer synthetic-test-key',
        'content-type': 'application/json',
      },
    });
    const body = submitted?.[1]?.body;
    if (!(body instanceof Uint8Array)) {
      throw new Error('Expected a copied byte body.');
    }
    expect(new TextDecoder().decode(body)).toBe('{"input":"Tiếng Việt"}');
    expect(events).toEqual(['reading', 'bodyRead']);
    expect(close).toHaveBeenCalledWith();
    expect(agent.closed).toBe(true);
    expect(agent.destroyed).toBe(true);
    expect(result.status).toBe(429);
    expect(result.statusText).toBe('Too Many Requests');
    expect(result.headers.get('x-request-id')).toBe('req_synthetic');
    expect(result.headers.get('content-type')).toBe('application/json');
    expect(await result.text()).toBe(text);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('uses a distinct closed agent for consecutive actual SDK calls with no SDK retries', async () => {
    const dispatch = vi.fn<typeof fetchUndici>(() =>
      Promise.resolve(
        UndiciResponse.json({
          id: 'resp_synthetic',
          object: 'response',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        }),
      ),
    );
    const client = new OpenAI({
      apiKey: 'synthetic-test-key',
      maxRetries: 0,
      fetch: createRemotionModelFetch({ dispatch }),
    });
    await client.responses.create({ model: 'synthetic-model', input: 'First synthetic request.' });
    await client.responses.create({ model: 'synthetic-model', input: 'Second synthetic request.' });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const agents = dispatch.mock.calls.map(([, init]) => {
      const agent = init?.dispatcher;
      if (!(agent instanceof Agent)) {
        throw new Error('Expected an owned Agent.');
      }
      expect(agent.closed).toBe(true);
      expect(agent.destroyed).toBe(true);
      return agent;
    });
    expect(agents[0]).not.toBe(agents[1]);
  });

  it('preserves a dispatch failure and destroys the agent without replaying it', async () => {
    const failure = new Error('Synthetic transport failure.', { cause: { code: 'EPIPE' } });
    const agent = new Agent();
    const destroy = vi.spyOn(agent, 'destroy');
    const close = vi.spyOn(agent, 'close');
    const dispatch = vi.fn<typeof fetchUndici>(() => Promise.reject(failure));
    await expect(
      createRemotionModelFetch({ dispatch, createAgent: () => agent })(
        'https://api.openai.com/v1/responses',
        { method: 'POST', body: '{}' },
      ),
    ).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith();
    expect(close).not.toHaveBeenCalled();
    expect(agent.destroyed).toBe(true);
  });

  it('destroys the agent when the response body fails before it can be buffered', async () => {
    const failure = new Error('Synthetic incomplete response body.');
    const agent = new Agent();
    const destroy = vi.spyOn(agent, 'destroy');

    async function* readIncompleteResponse() {
      await Promise.resolve();
      yield new Uint8Array([123]);
      throw failure;
    }

    const dispatch = vi.fn<typeof fetchUndici>(() =>
      Promise.resolve(new UndiciResponse(readIncompleteResponse())),
    );
    await expect(
      createRemotionModelFetch({ dispatch, createAgent: () => agent })(
        'https://api.openai.com/v1/responses',
      ),
    ).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledWith();
    expect(agent.destroyed).toBe(true);
  });

  it('propagates caller cancellation to the matching fetch and destroys its agent', async () => {
    const controller = new AbortController();
    const agent = new Agent();
    const dispatch = vi.fn<typeof fetchUndici>((_input, init) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      const reason: unknown = init?.signal?.reason;
      return Promise.reject(reason instanceof Error ? reason : new Error('Request cancelled.'));
    });
    await expect(
      createRemotionModelFetch({ dispatch, createAgent: () => agent })(
        'https://api.openai.com/v1/responses',
        { signal: controller.signal },
      ),
    ).rejects.toBe(controller.signal.reason);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(agent.destroyed).toBe(true);
  });

  it('does not allocate a dispatcher for an already cancelled request', async () => {
    const createAgent = vi.fn(() => new Agent());
    const dispatch = vi.fn<typeof fetchUndici>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createRemotionModelFetch({ dispatch, createAgent })('https://api.openai.com/v1/responses', {
        signal: controller.signal,
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(createAgent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'HEAD', status: 200 },
    { method: 'GET', status: 204 },
    { method: 'GET', status: 205 },
    { method: 'GET', status: 304 },
  ])('preserves a bodyless $method response with status $status', async ({ method, status }) => {
    const dispatch = vi.fn<typeof fetchUndici>(() =>
      Promise.resolve(new UndiciResponse(null, { status })),
    );
    const response = await createRemotionModelFetch({ dispatch })(
      'https://api.openai.com/v1/responses',
      { method },
    );
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });
});
