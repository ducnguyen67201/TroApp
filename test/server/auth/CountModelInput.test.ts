import { afterEach, expect, it, vi } from 'vitest';
import { createModelInputCounter } from '../../../src/server/auth/CountModelInput.js';
import { registerModelGateway } from '../../../src/server/auth/RegisterModelGateway.js';
import { readServerEnv } from '../../../src/server/Env.js';
import { ModelCredentialSchema } from '#contracts/AuthSession.js';
import Fastify from 'fastify';
afterEach(() => vi.restoreAllMocks());
it('counts tools, schema and visual history while excluding response-only fields', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{"input_tokens":1234}'));
  const request = {
    model: 'gpt-5.4',
    instructions: 'Teach',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,synthetic' }],
      },
    ],
    tools: [{ type: 'function', name: 'read' }],
    text: { format: { type: 'text' } },
    stream: true,
    max_output_tokens: 4096,
    store: false,
  };
  expect(await createModelInputCounter('synthetic-key')(request, AbortSignal.timeout(1000))).toBe(
    1234,
  );
  expect(fetch.mock.calls[0]?.[1]?.body).toContain('input_image');
  expect(fetch.mock.calls[0]?.[1]?.body).toContain('tools');
  expect(fetch.mock.calls[0]?.[1]?.body).not.toContain('max_output_tokens');
});
it('refuses oversized input before response generation and fails closed when counting fails', async () => {
  const api = Fastify();
  const env = readServerEnv({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    AUTH_SECRET: 'synthetic-secret-only-with-32-characters',
    OPENAI_API_KEY: 'synthetic-provider-key-only-0000',
    MODEL_CONTEXT_TOKENS: '8192',
  });
  const count = vi.fn<ReturnType<typeof createModelInputCounter>>().mockResolvedValue(8192);
  registerModelGateway(api, () => Promise.resolve('student'), env, api.log, count);
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    const credential = await api.inject('/api/v1/model/credential');
    const token = ModelCredentialSchema.parse(credential.json()).token;
    const send = () =>
      api.inject({
        method: 'POST',
        url: '/api/v1/model/responses',
        headers: { authorization: `Bearer ${token}` },
        payload: { model: 'gpt-5.4', input: 'hello' },
      });
    expect((await send()).statusCode).toBe(413);
    count.mockRejectedValue(new Error('Private provider body'));
    const failed = await send();
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('Private');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await api.close();
  }
});
