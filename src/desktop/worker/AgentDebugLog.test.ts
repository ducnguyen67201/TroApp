import OpenAI from 'openai';
import { isTaskContextBudgetError, TaskContextBudgetError } from './TaskContextBudget.js';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createLoggedModelFetch,
  describeModelRequest,
  describeModelResponse,
  AgentLogRole,
  readAgentLogContext,
  withAgentLogContext,
} from './AgentDebugLog.js';
import { describeCuaArguments, describeCuaResult } from './LoggedCuaServer.js';

describe('local agent debug summaries', () => {
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
