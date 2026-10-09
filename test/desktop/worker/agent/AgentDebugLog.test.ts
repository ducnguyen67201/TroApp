import { enableAgentExchangeLog } from '../../../../src/desktop/worker/agent/AgentExchangeLog.js';
import OpenAI from 'openai';
import { z } from 'zod';
import { ModelRequestTraceHeader, ModelRequestTraceSchema } from '#contracts/ModelGatewayError.js';
import {
  isTaskContextBudgetError,
  TaskContextBudgetError,
} from '../../../../src/desktop/worker/execution/TaskContextBudget.js';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createLoggedModelFetch,
  createAgentDebugLogger,
  describeModelRequest,
  describeModelResponse,
  AgentLogRole,
  readAgentLogContext,
  withAgentLogContext,
} from '../../../../src/desktop/worker/agent/AgentDebugLog.js';
import {
  describeCuaArguments,
  describeCuaResult,
} from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { describeTeachingFailure } from '../../../../src/desktop/worker/teaching/TeachingFailure.js';

const ModelLogEventSchema = z.object({
  msg: z.string(),
  modelRequestId: ModelRequestTraceSchema,
  traceMatched: z.boolean().nullable().optional(),
  gatewayRequestId: z.string().nullable().optional(),
});

function createCapturedModelLog() {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  return {
    log: pino({ level: 'debug' }, output),
    readRawLog: () => chunks.join(''),
    readEvents: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .map((line) => {
          const value: unknown = JSON.parse(line);
          return ModelLogEventSchema.parse(value);
        }),
  };
}

describe('local agent debug summaries', () => {
  it('keeps operational errors enabled when verbose desktop debugging is disabled', () => {
    const logger = createAgentDebugLogger(false);
    expect(logger.isLevelEnabled('error')).toBe(true);
    expect(logger.isLevelEnabled('debug')).toBe(false);
  });

  it('does not serialize unknown SDK exceptions carrying sensitive messages or causes', () => {
    const error = new Error('private screenshot and credential', {
      cause: { request: 'private prompt', token: 'private token' },
    });
    const diagnostics = describeTeachingFailure(error);
    expect(diagnostics).toEqual({
      errorType: 'Error',
      errorCode: 'unexpected_error',
      errorMessageAvailable: false,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private');
  });

  it('identifies output-contract mismatches without logging native prose or private fields', () => {
    const summary = describeCuaResult({
      isError: true,
      content: [{ type: 'text', text: 'private native error' }],
      structuredContent: {
        code: 'typed_output_mismatch',
        execution_state: 'unknown',
        detail: 'unknown field `guidance`, expected one of `status`, `following`, `active`',
        request: 'private screenshot',
      },
    });
    expect(summary).toMatchObject({
      reasonCode: 'typed_output_mismatch',
      diagnosticSource: 'structured',
      executionState: 'unknown',
      contractError: 'Native companion output contract rejects its guidance metadata.',
    });
    expect(JSON.stringify(summary)).not.toContain('private');
    const unrecognized = describeCuaResult({
      isError: true,
      content: [],
      structuredContent: { code: 'typed_output_mismatch', detail: 'private unknown field' },
    });
    expect(unrecognized).not.toHaveProperty('contractError');
    expect(JSON.stringify(unrecognized)).not.toContain('private');
  });

  it('describes following acknowledgements without logging lesson ownership IDs', () => {
    const summary = describeCuaResult({
      content: [],
      structuredContent: {
        status: 'following',
        following: true,
        active: false,
        guidance: {
          task_epoch: '11111111-1111-4111-8111-111111111111',
          reason: null,
          input_revision: 4,
        },
      },
    });
    expect(summary).toMatchObject({
      following: true,
      active: false,
      guidancePresent: true,
      inputRevision: 4,
    });
    expect(JSON.stringify(summary)).not.toContain('11111111');
  });
  it('shows model exchange structure without text, screenshots, or tool arguments', () => {
    const request = describeModelRequest({
      model: 'gpt-5.4',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'private classroom question' },
            { type: 'input_image', image_url: 'data:image/png;base64,private-screen' },
          ],
        },
      ],
      tools: [{ type: 'function', name: 'browser_click' }],
    });
    const response = describeModelResponse({
      output: [
        { type: 'function_call', name: 'browser_click', arguments: '{"text":"private"}' },
        { type: 'message', content: [{ type: 'output_text', text: 'private answer' }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    expect(request).toEqual({
      model: 'gpt-5.4',
      inputItems: 1,
      textChars: 26,
      imageParts: 1,
      toolNames: ['browser_click'],
      toolSchemaBytes: Buffer.byteLength(
        JSON.stringify([{ type: 'function', name: 'browser_click' }]),
      ),
    });
    expect(response).toEqual({
      outputTypes: ['function_call', 'message'],
      toolCalls: ['browser_click'],
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(JSON.stringify({ request, response })).not.toMatch(/private|base64/);
  });

  it('counts tool-result text and images without exposing their content', () => {
    const summary = describeModelRequest({
      input: [
        { type: 'function_call_output', output: 'private tool result' },
        {
          type: 'function_call_output',
          output: [
            { type: 'input_text', text: 'private observed text' },
            { type: 'input_image', image_url: 'private-image' },
          ],
        },
      ],
    });
    expect(summary).toMatchObject({
      inputItems: 2,
      textChars: 40,
      imageParts: 1,
      toolSchemaBytes: 2,
    });
    expect(JSON.stringify(summary)).not.toContain('private');
  });

  it('restores the actor context after nested verification and isolates simultaneous tasks', async () => {
    const main = { taskId: 'task-one', agentRole: AgentLogRole.MAIN, attemptNumber: 1 };
    const verifier = { ...main, agentRole: AgentLogRole.VERIFIER };
    await Promise.all([
      withAgentLogContext(main, async () => {
        expect(readAgentLogContext()).toEqual(main);
        await withAgentLogContext(verifier, async () => {
          await Promise.resolve();
          expect(readAgentLogContext()).toEqual(verifier);
        });
        expect(readAgentLogContext()).toEqual(main);
      }),
      withAgentLogContext({ ...main, taskId: 'task-two' }, async () => {
        await Promise.resolve();
        expect(readAgentLogContext()?.taskId).toBe('task-two');
      }),
    ]);
    expect(readAgentLogContext()).toBeUndefined();
  });

  it('shows Cua argument and result kinds without values', () => {
    const request = describeCuaArguments({
      target_id: 'private-target',
      text: 'private password',
      x: 400,
    });
    const response = describeCuaResult({
      content: [
        { type: 'text', text: 'private page content' },
        { type: 'image', data: 'private-screenshot' },
      ],
      isError: false,
      structuredContent: { code: 'bring_to_front_exact_window_verified', status: 'satisfied' },
    });

    expect(request).toEqual({
      target_id: { type: 'string', length: 14 },
      text: { type: 'string', length: 16 },
      x: { type: 'number' },
    });
    expect(response).toEqual({
      isError: false,
      contentTypes: ['text', 'image'],
      textChars: 20,
      hasStructuredContent: true,
      code: 'bring_to_front_exact_window_verified',
      status: 'satisfied',
    });
    expect(JSON.stringify({ request, response })).not.toMatch(/private|screenshot/);
  });

  it('logs a model exchange without changing its response or printing its content', async () => {
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => {
      lines.push(chunk.toString('utf8'));
    });
    const log = pino({ level: 'debug' }, output);
    const responseBody = {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'private answer' }] }],
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-tro-request-id': 'req-123' },
      }),
    );

    try {
      const response = await withAgentLogContext(
        { taskId: 'synthetic-task', agentRole: AgentLogRole.MAIN, attemptNumber: 1 },
        () =>
          createLoggedModelFetch(log)('https://api.example.test/model', {
            method: 'POST',
            body: JSON.stringify({ model: 'gpt-5.4', input: 'private question' }),
          }),
      );
      expect(response.status).toBe(200);
      const parsed: unknown = await response.json();
      expect(parsed).toEqual(responseBody);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(lines.join('')).toContain('openai.request');
      expect(lines.join('')).toContain('openai.response');
      expect(lines.join('')).toContain('"gatewayRequestId":"req-123"');
      expect(lines.join('')).toContain('"taskId":"synthetic-task"');
      expect(lines.join('').match(/"modelCallId":"model-1"/g)).toHaveLength(2);
      expect(lines.join('')).not.toContain('private');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('logs a safe cause when rejecting oversized input before network dispatch', async () => {
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        withAgentLogContext(
          { taskId: 'oversize-task', agentRole: AgentLogRole.VERIFIER, attemptNumber: 2 },
          () =>
            createLoggedModelFetch(pino({ level: 'debug' }, output), 3)('https://example.test', {
              method: 'POST',
              body: 'private',
            }),
        ),
      ).rejects.toThrow(TaskContextBudgetError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines.join('')).toContain('openai.request.rejected');
      expect(lines.join('')).toContain('"agentRole":"verifier"');
      expect(lines.join('')).toContain('"reason":"context_limit"');
      expect(lines.join('')).not.toContain('private');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    {
      result: {
        isError: true,
        content: [{ type: 'text', text: 'target_invalidated' }],
        structuredContent: { status: 'failed', code: 'target_invalidated' },
      },
      expected: {
        code: 'target_invalidated',
        status: 'failed',
        reasonCode: 'target_invalidated',
        diagnosticSource: 'structured',
        reasonAvailable: true,
      },
    },
    {
      result: {
        content: [],
        structuredContent: {
          status: 'refused',
          refusal: { code: 'browser_requires_setup', message: 'private browser title' },
        },
      },
      expected: {
        reasonCode: 'browser_requires_setup',
        diagnosticSource: 'structured',
        reasonAvailable: true,
      },
    },
    {
      result: {
        content: [],
        structuredContent: {
          effect: 'refused',
          error: { code: 'browser_tab_required', hint: 'private tab' },
        },
      },
      expected: {
        reasonCode: 'browser_tab_required',
        diagnosticSource: 'structured',
        reasonAvailable: true,
      },
    },
    {
      result: {
        isError: true,
        content: [],
        structuredContent: {
          code: 'bring_to_front_exact_window_unverified',
          exact_window_effect: {
            request_accepted: true,
            process_activated: true,
            focused: false,
            front_in_process_on_display: false,
            title: 'private title',
          },
        },
      },
      expected: {
        reasonCode: 'bring_to_front_exact_window_unverified',
        focusDiagnostics: {
          request_accepted: true,
          process_activated: true,
          focused: false,
          front_in_process_on_display: false,
        },
      },
    },
    {
      result: {
        isError: true,
        content: [{ type: 'text', text: 'private error browser_binding_stale' }],
      },
      expected: { reasonCode: 'browser_binding_stale', diagnosticSource: 'text' },
    },
    {
      result: {
        isError: true,
        content: [],
        structuredContent: {
          status: 'refused',
          error: { code: 'snapshot_id_required', message: 'private detail', retryable: true },
        },
      },
      expected: {
        reasonCode: 'snapshot_id_required',
        diagnosticSource: 'structured',
        retryable: true,
      },
    },
    {
      result: {
        isError: true,
        content: [{ type: 'text', text: 'private detail: stale_element_token' }],
      },
      expected: { reasonCode: 'stale_element_token', diagnosticSource: 'text' },
    },
    {
      result: {
        content: [],
        structuredContent: {
          status: 'refused',
          reason: 'private unrecognized reason',
          escalation: { recommended: 'foreground' },
        },
      },
      expected: {
        reasonAvailable: false,
        diagnosticSource: 'unavailable',
        recommendedDeliveryMode: 'foreground',
      },
    },
    {
      result: {
        content: [],
        structuredContent: {
          degraded: true,
          degraded_reason: 'background_unavailable',
          escalation: { recommended: 'foreground' },
        },
      },
      expected: {
        reasonCode: 'background_unavailable',
        diagnosticSource: 'structured',
        degraded: true,
        recommendedDeliveryMode: 'foreground',
      },
    },
    {
      result: {
        isError: true,
        content: [{ type: 'text', text: 'private: not_snapshot_id_required_extra' }],
      },
      expected: { reasonAvailable: false, diagnosticSource: 'unavailable' },
    },
  ])(
    'keeps only recognized driver refusal codes and safe delivery hints: %j',
    ({ result, expected }) => {
      const summary = describeCuaResult(result);
      expect(summary).toMatchObject(expected);
      expect(JSON.stringify(summary)).not.toContain('private');
    },
  );
  it('enforces UTF-8 request bytes with debug logging disabled and preserves Request input', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      const guardedFetch = createLoggedModelFetch(pino({ level: 'silent' }), 3);
      await expect(
        guardedFetch('https://api.example.test/model', { method: 'POST', body: 'éé' }),
      ).rejects.toThrow(TaskContextBudgetError);
      expect(fetchMock).not.toHaveBeenCalled();
      const request = new Request('https://api.example.test/model', {
        method: 'POST',
        body: 'abc',
      });
      await guardedFetch(request);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request.bodyUsed).toBe(false);
      expect(await request.text()).toBe('abc');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('uses the actual OpenAI transport without sending or retrying an oversized request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected network dispatch'));
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(createLoggedModelFetch(pino({ level: 'silent' }), 20));
    const client = new OpenAI({
      apiKey: 'synthetic-test-token',
      baseURL: 'https://api.example.test',
      fetch: guardedFetch,
      maxRetries: 0,
    });
    try {
      let failure: unknown;
      try {
        await client.responses.create({ model: 'gpt-5.4', input: 'Synthetic input' });
      } catch (error) {
        failure = error;
      }
      expect(isTaskContextBudgetError(failure)).toBe(true);
      expect(guardedFetch).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });
});

it.each(['capture_binding_failed', 'capture_refresh_failed', 'capture_decode_failed'])(
  'reports the owned %s boundary code without private error prose',
  (code) => {
    const summary = describeCuaResult({
      isError: true,
      content: [{ type: 'text', text: `Private screen title: ${code}` }],
    });
    expect(summary).toMatchObject({ reasonCode: code, diagnosticSource: 'text' });
    expect(JSON.stringify(summary)).not.toContain('Private screen');
  },
);

it('pairs actual model messages and function output in readable development exchanges', async () => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        output: [
          {
            type: 'function_call',
            name: 'present_teaching_step',
            arguments: JSON.stringify({
              instruction: 'Move your pointer to the bottom edge.',
              cue: {
                drawing: {
                  strokes: [
                    {
                      points: [
                        { x: 0.5, y: 0.9 },
                        { x: 0.6, y: 0.98 },
                      ],
                      closed: false,
                    },
                  ],
                },
              },
            }),
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  try {
    const log = pino({ level: 'debug' }, stream);
    enableAgentExchangeLog(log);
    await createLoggedModelFetch(log)('https://api.example.test', {
      method: 'POST',
      headers: { authorization: 'Bearer synthetic-secret' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Open YouTube' },
              { type: 'input_image', image_url: 'data:image/png;base64,c2NyZWVu' },
            ],
          },
        ],
      }),
    });
    const trace = chunks.join('');
    expect(trace).toContain('Open YouTube');
    expect(trace).toContain('Move your pointer to the bottom edge.');
    expect(trace).toContain('agent.debug.exchange');
    expect(trace).not.toContain('synthetic-secret');
    expect(trace).not.toContain('c2NyZWVu');
  } finally {
    fetchMock.mockRestore();
  }
});

it('preserves gateway diagnostics through the real SDK and JSON logs without raw provider text', async () => {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  const diagnostics = {
    gatewayRequestId: 'req-test',
    reason: 'provider_network_failed',
    networkCode: 'EPIPE',
    attemptNumber: 2,
    durationMs: 444,
    timedOut: false,
  };
  const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        message: 'The model service could not complete the request.',
        diagnostics,
        error: {
          message: 'The model service could not complete the request.',
          type: 'api_error',
          code: 'tro_model_gateway_failed',
          diagnostics,
        },
      }),
      {
        status: 502,
        headers: { 'content-type': 'application/json', 'x-tro-request-id': 'req-test' },
      },
    ),
  );
  const client = new OpenAI({
    apiKey: 'synthetic-test-token',
    baseURL: 'https://api.example.test',
    maxRetries: 0,
    fetch: createLoggedModelFetch(pino({ level: 'debug' }, stream)),
  });
  try {
    let failure: unknown;
    try {
      await client.responses.create({ model: 'gpt-5.4', input: 'Synthetic input' });
    } catch (error) {
      failure = error;
    }
    expect(describeTeachingFailure(failure)).toMatchObject({
      httpStatus: 502,
      gatewayFailure: diagnostics,
    });
    expect(chunks.join('')).toContain('"networkCode":"EPIPE"');
    expect(chunks.join('')).toContain('"gatewayRequestId":"req-test"');
    expect(chunks.join('')).not.toContain('synthetic-test-token');
    expect(provider).toHaveBeenCalledOnce();
  } finally {
    provider.mockRestore();
  }
});

describe('model request trace correlation', () => {
  it('sends a distinct trace per call, preserves supplied headers and correlates each echoed response', async () => {
    const capture = createCapturedModelLog();
    const suppliedHeaders = new Headers({
      authorization: 'Bearer private-token',
      'content-type': 'application/json',
      'x-client-metadata': 'private-header',
      [ModelRequestTraceHeader]: '11111111-1111-4111-8111-111111111111',
    });
    const receivedIds: string[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const headers = new Headers(init?.headers);
      const modelRequestId = ModelRequestTraceSchema.parse(headers.get(ModelRequestTraceHeader));
      receivedIds.push(modelRequestId);
      expect(headers.get('authorization')).toBe('Bearer private-token');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('x-client-metadata')).toBe('private-header');
      return Promise.resolve(
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            [ModelRequestTraceHeader]: modelRequestId,
            'x-tro-request-id': 'req-synthetic',
          },
        }),
      );
    });

    try {
      const guardedFetch = createLoggedModelFetch(capture.log);
      for (let index = 0; index < 2; index += 1) {
        await guardedFetch(new URL('https://api.example.test/private-resource'), {
          method: 'POST',
          headers: suppliedHeaders,
          body: JSON.stringify({ model: 'gpt-5.4', input: 'private prompt' }),
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new Set(receivedIds).size).toBe(2);
      expect(suppliedHeaders.get(ModelRequestTraceHeader)).toBe(
        '11111111-1111-4111-8111-111111111111',
      );
      const events = capture.readEvents();
      for (const modelRequestId of receivedIds) {
        expect(events.filter((event) => event.modelRequestId === modelRequestId)).toEqual([
          { msg: 'openai.request', modelRequestId },
          {
            msg: 'openai.response',
            modelRequestId,
            traceMatched: true,
            gatewayRequestId: 'req-synthetic',
          },
        ]);
      }
      expect(capture.readRawLog()).not.toContain('private');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('retains Request headers, body and explicit cancellation while adding the trace to a copy', async () => {
    const capture = createCapturedModelLog();
    const abort = new AbortController();
    const request = new Request('https://api.example.test/private-resource', {
      method: 'POST',
      headers: { authorization: 'Bearer private-token', 'content-type': 'application/json' },
      body: 'private prompt',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      expect(input).toBe(request);
      expect(init?.signal).toBe(abort.signal);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer private-token');
      expect(headers.get('content-type')).toBe('application/json');
      const modelRequestId = ModelRequestTraceSchema.parse(headers.get(ModelRequestTraceHeader));
      return Promise.resolve(
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            [ModelRequestTraceHeader]: modelRequestId,
          },
        }),
      );
    });

    try {
      await createLoggedModelFetch(capture.log)(request, { signal: abort.signal });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(request.headers.has(ModelRequestTraceHeader)).toBe(false);
      expect(request.bodyUsed).toBe(false);
      expect(await request.text()).toBe('private prompt');
      expect(capture.readEvents().find((event) => event.msg === 'openai.response')).toMatchObject({
        traceMatched: true,
      });
      expect(capture.readRawLog()).not.toContain('private');
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    { responseTrace: '22222222-2222-4222-8222-222222222222', traceMatched: false },
    { responseTrace: 'private-returned-header', traceMatched: null },
  ])(
    'reports an untrusted response trace as $traceMatched without logging it',
    async ({ responseTrace, traceMatched }) => {
      const capture = createCapturedModelLog();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', {
          headers: { 'content-type': 'application/json', [ModelRequestTraceHeader]: responseTrace },
        }),
      );

      try {
        await createLoggedModelFetch(capture.log)('https://api.example.test/private-resource');
        expect(capture.readEvents().find((event) => event.msg === 'openai.response')).toMatchObject(
          {
            traceMatched,
          },
        );
        expect(capture.readRawLog()).not.toContain(responseTrace);
        expect(capture.readRawLog()).not.toContain('private');
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it('keeps the dispatched trace when local fetch fails before returning gateway headers', async () => {
    const capture = createCapturedModelLog();
    const originalError = new TypeError('private transport failure', {
      cause: { request: 'private input', token: 'private token' },
    });
    let dispatchedTrace: string | null = null;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      dispatchedTrace = ModelRequestTraceSchema.parse(
        new Headers(init?.headers).get(ModelRequestTraceHeader),
      );
      return Promise.reject<Response>(originalError);
    });

    try {
      await expect(
        createLoggedModelFetch(capture.log)('https://api.example.test/private-resource', {
          method: 'POST',
          headers: { authorization: 'Bearer private-token' },
          body: JSON.stringify({ model: 'gpt-5.4', input: 'private prompt' }),
        }),
      ).rejects.toBe(originalError);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(capture.readEvents()).toEqual([
        { msg: 'openai.request', modelRequestId: dispatchedTrace },
        { msg: 'openai.failed', modelRequestId: dispatchedTrace },
      ]);
      expect(capture.readRawLog()).not.toContain('private');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
