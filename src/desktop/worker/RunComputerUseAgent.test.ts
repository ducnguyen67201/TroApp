import {
  Agent,
  MCPServerStdio,
  Usage,
  setTracingDisabled,
  type Model,
  type ModelRequest,
} from '@openai/agents';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorCompanionTool } from '#contracts/CursorCompanion.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { createTeachingAgent } from './CreateComputerUseAgent.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';
import { runComputerUseAgent } from './RunComputerUseAgent.js';
import { TeachingReplyKind, TeachingReplySchema } from './TeachingReply.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('structured teaching replies through the real SDK', () => {
  it.each([
    {
      message: 'Làm sao dùng ChatGPT Codex ở đây vậy?',
      locale: DesktopLocale.VIETNAMESE,
      guide: true,
      kind: TeachingReplyKind.GUIDE,
      answer: 'Ô nhập, cuộc trò chuyện mới và dự án đã được khoanh lần lượt.',
    },
    {
      message: 'What is a variable?',
      locale: DesktopLocale.ENGLISH,
      guide: false,
      kind: TeachingReplyKind.EXPLANATION,
      answer: 'A variable gives a value a name you can use in your program.',
    },
  ])('observes first, releases tool choice and preserves $kind output', async (reply) => {
    setTracingDisabled(true);
    vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(
      ['get_desktop_state', CursorCompanionTool.SHOW_SEQUENCE].map((name) => ({
        name,
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: true,
        },
      })),
    );
    const captureId = 'synthetic-codex-capture';
    const taskEpoch = '11111111-1111-4111-8111-111111111111';
    const imageData = 'aW1hZ2U=';
    const steps = [0.2, 0.4, 0.6].map((x) => ({
      kind: 'circle',
      center: { x, y: 0.5 },
      radius: 0.04,
      duration_ms: 600,
    }));
    const native = vi
      .spyOn(MCPServerStdio.prototype, 'callToolResult')
      .mockImplementation(async (name) => {
        await Promise.resolve();
        if (name === 'get_desktop_state') {
          return {
            content: [
              { type: 'text', text: 'Codex: message input, new chat and projects are visible.' },
              { type: 'image', data: imageData, mimeType: 'image/png' },
            ],
            structuredContent: { capture_id: captureId, width: 1000, height: 800 },
          };
        }
        if (name === CursorCompanionTool.SHOW_SEQUENCE) {
          return {
            content: [],
            structuredContent: {
              status: 'completed',
              following: true,
              active: false,
              receipt: {
                presentation_version: 2,
                task_epoch: taskEpoch,
                sequence_id: '22222222-2222-4222-8222-222222222222',
                completed_steps: steps.length,
              },
            },
          };
        }
        throw new Error('Unexpected synthetic tool call');
      });
    const server = new LoggedCuaServer(
      { name: 'Synthetic teaching desktop', command: 'unused' },
      pino({ level: 'silent' }),
    );
    const terminal = vi.fn<() => void>();
    server.beginTeachingTask(taskEpoch, terminal);
    const requests: ModelRequest[] = [];
    const model: Model = {
      async getResponse(request) {
        requests.push(request);
        await Promise.resolve();
        if (requests.length === 1) {
          return {
            output: [
              { type: 'function_call', name: 'get_desktop_state', arguments: '{}', callId: 'read' },
            ],
            usage: new Usage(),
          };
        }
        if (reply.guide && requests.length === 2) {
          return {
            output: [
              {
                type: 'function_call',
                name: CursorCompanionTool.SHOW_SEQUENCE,
                arguments: JSON.stringify({
                  presentation_version: 2,
                  capture_id: captureId,
                  steps,
                }),
                callId: 'show',
              },
            ],
            usage: new Usage(),
          };
        }
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({ kind: reply.kind, answer: reply.answer }),
                },
              ],
            },
          ],
          usage: new Usage(),
        };
      },
      getStreamedResponse() {
        throw new Error('This test does not use streaming.');
      },
    };
    const agent = createTeachingAgent(server, reply.locale);
    agent.model = model;
    const result = await runComputerUseAgent(agent, reply.message, new AbortController().signal, 3);
    expect(requests[0]?.modelSettings.toolChoice).toBe('get_desktop_state');
    expect(
      requests.slice(1).every((request) => request.modelSettings.toolChoice === undefined),
    ).toBe(true);
    expect(JSON.stringify(requests[1]?.input)).toContain(captureId);
    expect(JSON.stringify(requests[1]?.input)).toContain('data:image/png;base64,' + imageData);
    expect(native.mock.calls.map(([name]) => name)).toEqual(
      reply.guide
        ? ['get_desktop_state', CursorCompanionTool.SHOW_SEQUENCE]
        : ['get_desktop_state'],
    );
    if (reply.guide) {
      expect(native.mock.calls[1]?.[1]).toEqual({
        presentation_version: 2,
        capture_id: captureId,
        steps,
      });
      expect(JSON.stringify(requests[2]?.input)).toContain('completed_steps');
    }
    expect(result).toMatchObject({ answer: reply.answer, replyKind: reply.kind });
    expect(server.taskEvidence.readTeachingResult(result.answer ?? '', result.replyKind)).toEqual({
      outcome: reply.guide ? 'demonstrated' : 'explained',
      answer: reply.answer,
    });
    expect(terminal).not.toHaveBeenCalled();
    server.endTeachingTask();
  });

  it.each(Object.values(TeachingReplyKind))('validates and preserves a %s reply', async (kind) => {
    setTracingDisabled(true);
    const answer = 'Open the app and enter your first question.';
    const getResponse = vi.fn<Model['getResponse']>().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify({ kind, answer }) }],
        },
      ],
      usage: new Usage(),
    });
    const model: Model = {
      getResponse,
      getStreamedResponse() {
        throw new Error('This test does not use streaming.');
      },
    };
    const agent = new Agent({
      name: 'Synthetic teaching assistant',
      model,
      outputType: TeachingReplySchema,
    });
    const result = await runComputerUseAgent(
      agent,
      'How do I use ChatGPT?',
      new AbortController().signal,
      1,
    );
    expect(result).toMatchObject({ answer, replyKind: kind });
    expect(result.history).toHaveLength(2);
    expect(getResponse).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'demonstrated', answer: 'Done' },
    { kind: 'explanation', answer: ' ' },
    { answer: 'Here are some instructions.' },
  ])('rejects malformed reply metadata or empty instructions', (reply) => {
    expect(TeachingReplySchema.safeParse(reply).success).toBe(false);
  });
});
