import { PassThrough } from 'node:stream';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createLoggedModelFetch,
  describeModelRequest,
  describeModelResponse,
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
    });
    expect(response).toEqual({
      outputTypes: ['function_call', 'message'],
      toolCalls: ['browser_click'],
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(JSON.stringify({ request, response })).not.toMatch(/private|base64/);
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
      hasStructuredContent: false,
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
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const response = await createLoggedModelFetch(log)('https://api.example.test/model', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.4', input: 'private question' }),
      });
      expect(response.status).toBe(200);
      const parsed: unknown = await response.json();
      expect(parsed).toEqual(responseBody);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(lines.join('')).toContain('openai.request');
      expect(lines.join('')).toContain('openai.response');
      expect(lines.join('')).not.toContain('private');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
