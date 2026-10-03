import {
  MCPServerStdio,
  OpenAIProvider,
  setDefaultModelProvider,
  setTracingDisabled,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type AgentOutputItem,
} from '@openai/agents';
import pino from 'pino';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkerResponseSchema } from '#contracts/AgentSession.js';
import { VoiceEventSchema } from '#contracts/VoiceInput.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { ComputerUseTaskRunner } from '../../../../src/desktop/worker/agent/ComputerUseTaskRunner.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';

let fixtureModel: Model | null = null;

/* The SDK's default Runner caches its first provider. Keep the provider stable
   while selecting each test's model, so later fixtures cannot reuse old outputs. */
const fixtureProvider = {
  getModel: (): Model => {
    if (!fixtureModel) {
      throw new Error('No synthetic model is active.');
    }
    return fixtureModel;
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  fixtureModel = null;
  setDefaultModelProvider(new OpenAIProvider());
});

function callTool(name: string, args: Record<string, unknown>, callId: string): AgentOutputItem {
  return { type: 'function_call', name, arguments: JSON.stringify(args), callId };
}

function finalOutput(value: unknown): AgentOutputItem {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify(value) }],
  };
}

/** Real SDK runs with synthetic MCP and model ports; no credentials or live desktop writes. */
describe('SDK actor to read-only verifier to public completion contract', () => {
  it.each([false, true])(
    'verifies a second-display result; verifier needs a fresh read: %s',
    async (needsFreshRead) => {
      setTracingDisabled(true);
      const tools = ['launch_app', 'get_window_state', 'list_windows'].map((name) => ({
        name,
        description: name,
        annotations: { readOnlyHint: name !== 'launch_app' },
        inputSchema: {
          type: 'object' as const,
          properties: {},
          required: [],
          additionalProperties: true,
        },
      }));
      vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(tools);
      const driver = vi
        .spyOn(MCPServerStdio.prototype, 'callToolResult')
        .mockImplementation((name) =>
          Promise.resolve(
            name === 'get_window_state'
              ? {
                  content: [
                    { type: 'text', text: 'YouTube home, loaded video grid' },
                    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
                  ],
                  structuredContent: { pid: 7, window_id: 12 },
                }
              : name === 'list_windows'
                ? {
                    content: [],
                    structuredContent: {
                      windows: [
                        {
                          pid: 7,
                          window_id: 12,
                          is_on_screen: true,
                          on_current_space: null,
                          bounds: { x: 2300, y: 0, width: 1000, height: 900 },
                        },
                      ],
                    },
                  }
                : { content: [], structuredContent: { launch_state: { window_ready: true } } },
          ),
        );
      const pageId = needsFreshRead ? 'evidence-call-3-1' : 'evidence-call-2-1';
      const windowId = needsFreshRead ? 'evidence-call-2-1' : 'evidence-call-3-1';
      const verdict = {
        summary: 'Đã mở YouTube.',
        decision: 'confirmed',
        missingRequirements: [],
        criteria: [
          {
            criterionId: 'criterion-1',
            state: 'satisfied',
            evidenceIds: [pageId],
            explanation: 'Trang YouTube đã tải.',
          },
          {
            criterionId: 'criterion-2',
            state: 'satisfied',
            evidenceIds: [windowId],
            explanation: 'Cửa sổ đang hiển thị trên màn hình ngoài.',
          },
        ],
      };
      const actorObservations = needsFreshRead
        ? [callTool('list_windows', { on_screen_only: false }, 'windows')]
        : [
            callTool('get_window_state', { pid: 7, window_id: 12 }, 'page'),
            callTool('list_windows', { on_screen_only: false }, 'windows'),
          ];
      const outputs: AgentOutputItem[][] = [
        [
          callTool(
            'define_task_goal',
            {
              summary: 'Mở YouTube',
              criteria: [
                { description: 'YouTube loaded' },
                { description: 'Browser window visible on the external monitor' },
              ],
            },
            'goal',
          ),
        ],
        [callTool('launch_app', { url: 'https://www.youtube.com/' }, 'open')],
        actorObservations,
        [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Unsupported actor success claim' }],
          },
          callTool('verify_task', {}, 'verify'),
        ],
        ...(needsFreshRead
          ? [[callTool('get_window_state', { pid: 7, window_id: 12 }, 'verifier-read')]]
          : []),
        [finalOutput(verdict)],
        [finalOutput({ mode: 'task', answer: 'Đã mở YouTube.', verificationId: 'verification-1' })],
      ];
      const requests: ModelRequest[] = [];
      const model: Model = {
        getResponse(request): Promise<ModelResponse> {
          requests.push(request);
          const output = outputs.shift();
          if (!output) {
            throw new Error('Unexpected additional model call.');
          }
          return Promise.resolve({ output, usage: new Usage() });
        },
        getStreamedResponse() {
          throw new Error('Streaming is not enabled in this fixture.');
        },
      };
      fixtureModel = model;
      setDefaultModelProvider(fixtureProvider);
      const output = new PassThrough();
      const lines: string[] = [];
      output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
      const log = pino({ level: 'debug' }, output);
      const server = new LoggedCuaServer(
        { name: 'synthetic MCP', command: 'unused', args: ['mcp'] },
        log,
      );
      const runner = new ComputerUseTaskRunner(server, log);
      const result = await runner.runTask(
        'Mở YouTube trên màn hình ngoài',
        DesktopLocale.VIETNAMESE,
        new AbortController().signal,
      );
      const reply = AgentWorkerResponseSchema.parse({
        requestId: '11111111-1111-4111-8111-111111111111',
        result,
      });
      expect(reply.result).toMatchObject({
        kind: 'completed',
        answer: 'Đã mở YouTube.',
        completion: { kind: 'task', outcome: { status: 'succeeded', supportedCriteriaCount: 2 } },
      });
      expect(
        VoiceEventSchema.parse({
          kind: 'result',
          captureId: '22222222-2222-4222-8222-222222222222',
          sessionId: '33333333-3333-4333-8333-333333333333',
          result,
        }).kind,
      ).toBe('result');
      expect(requests).toHaveLength(needsFreshRead ? 7 : 6);
      expect(requests[0]?.systemInstructions).toContain('Respond to the user in Vietnamese');
      expect(requests[0]?.outputType).toMatchObject({ type: 'json_schema' });
      expect(requests[4]?.systemInstructions).toContain('read-only task verification agent');
      expect(requests[4]?.systemInstructions).toContain('Vietnamese');
      expect(JSON.stringify(requests[4]?.input)).toContain('Mở YouTube trên màn hình ngoài');
      expect(JSON.stringify(requests[4]?.input)).toContain('Tro observation references');
      expect(JSON.stringify(requests[4]?.input)).not.toContain('Unsupported actor success claim');
      expect(JSON.stringify(requests[4]?.tools)).not.toMatch(
        /launch_app|define_task_goal|verify_task/,
      );
      expect(JSON.stringify(requests[4]?.tools)).toContain('get_window_state');
      expect(JSON.stringify(requests.at(-1)?.input)).toContain('verification-1');
      if (!needsFreshRead) {
        expect(JSON.stringify(requests[4]?.input)).toContain('aW1hZ2U=');
      }
      expect(driver.mock.calls.map((call) => call[0])).toEqual(
        needsFreshRead
          ? ['launch_app', 'list_windows', 'get_window_state']
          : ['launch_app', 'get_window_state', 'list_windows'],
      );
      expect(JSON.stringify(reply)).not.toMatch(/elements|bounds|evidence-call|verification-1/);
      const logs = lines.join('');
      expect(logs.match(/"msg":"agent.model.admitted"/g)).toHaveLength(requests.length);
      expect(logs).toContain('"agentRole":"main"');
      expect(logs).toContain('"agentRole":"verifier"');
      expect(logs).toContain('agent.verification.finished');
      expect(logs).toContain('"status":"succeeded"');
      expect(logs).not.toMatch(
        /Mở YouTube|YouTube home, loaded video grid|aW1hZ2U=|Unsupported actor success claim/,
      );
    },
  );
});
