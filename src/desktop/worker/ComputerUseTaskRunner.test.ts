import { MCPServerStdio, type CallToolResult } from '@openai/agents';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { AgentTaskMode, CursorCompanionTool } from '#contracts/CursorCompanion.js';
import { ComputerUseTaskRunner } from './ComputerUseTaskRunner.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';
import { runComputerUseAgent } from './RunComputerUseAgent.js';
import { TeachingReplyKind } from './TeachingReply.js';

async function createRunner() {
  let epoch = '';
  vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue(
    Object.values(CursorCompanionTool).map((name) => ({
      name,
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    })),
  );
  const native = vi
    .spyOn(MCPServerStdio.prototype, 'callToolResult')
    .mockImplementation(async (name, args): Promise<CallToolResult> => {
      await Promise.resolve();
      if (name === CursorCompanionTool.READ_CAPABILITIES) {
        return {
          content: [],
          structuredContent: {
            presentation_versions: [1, 2],
            task_lifecycle: true,
            display_scope: 'primary',
            gestures: ['circle'],
            max_steps: 8,
            max_duration_ms: 15000,
          },
        };
      }
      if (name === CursorCompanionTool.BEGIN_TASK) {
        const supplied: unknown = args?.task_epoch;
        if (typeof supplied !== 'string') {
          throw new Error('Missing epoch');
        }
        epoch = supplied;
        return {
          content: [],
          structuredContent: {
            status: 'task_ready',
            task_epoch: epoch,
            following: true,
            active: false,
          },
        };
      }
      if (name === CursorCompanionTool.END_TASK) {
        return {
          content: [],
          structuredContent: {
            status: 'task_ended',
            task_epoch: epoch,
            following: true,
            active: false,
          },
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
              task_epoch: epoch,
              sequence_id: '22222222-2222-4222-8222-222222222222',
              completed_steps: 1,
            },
          },
        };
      }
      if (name === CursorCompanionTool.SET_MODE && args?.mode === 'hidden') {
        return {
          content: [],
          structuredContent: { status: 'hidden', following: false, active: false },
        };
      }
      return {
        content: [],
        structuredContent: { status: 'following', following: true, active: false },
      };
    });
  const server = new LoggedCuaServer(
    { name: 'Test', command: 'unused' },
    pino({ level: 'silent' }),
  );
  await server.listTools();
  const runAgent = vi.fn<typeof runComputerUseAgent>();
  const runner = new ComputerUseTaskRunner(server, pino({ level: 'silent' }), runAgent);
  return { server, runner, runAgent, native, readEpoch: () => epoch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('starts companion following on the main-owned endpoint without a model run', async () => {
  vi.useFakeTimers();
  vi.spyOn(MCPServerStdio.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(MCPServerStdio.prototype, 'close').mockResolvedValue(undefined);
  const { native } = await createRunner();
  const runner = await ComputerUseTaskRunner.connect(
    pino({ level: 'silent' }),
    {
      command: '/tro/cua-driver',
      args: ['mcp', '--embedded', '--socket', '/private/tro.sock'],
      env: { CUA_DRIVER_EMBEDDED: '1' },
    },
    true,
  );
  expect(native).toHaveBeenCalledWith(CursorCompanionTool.SET_MODE, {
    mode: 'follow',
    label: 'Tro',
  });
  await runner.close();
  expect(native).toHaveBeenCalledWith(CursorCompanionTool.SET_MODE, { mode: 'hidden' });
});

it('closes the host transport when required companion tools are absent', async () => {
  vi.spyOn(MCPServerStdio.prototype, 'connect').mockResolvedValue(undefined);
  const close = vi.spyOn(MCPServerStdio.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(MCPServerStdio.prototype, 'listTools').mockResolvedValue([
    {
      name: 'get_desktop_state',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  ]);
  await expect(
    ComputerUseTaskRunner.connect(
      pino({ level: 'silent' }),
      {
        command: '/tro/cua-driver',
        args: ['mcp', '--embedded'],
        env: {},
      },
      true,
    ),
  ).rejects.toThrow('companion tools');
  expect(close).toHaveBeenCalledOnce();
});

describe('teaching task completion and cancellation', () => {
  it('requires a demonstrated sequence and does not retry a prose-only answer', async () => {
    vi.useFakeTimers();
    const { runner, runAgent } = await createRunner();
    runAgent.mockResolvedValue({ answer: 'Done, I showed you', history: [] });
    expect(
      await runner.runTask(
        'Show me',
        DesktopLocale.ENGLISH,
        new AbortController().signal,
        AgentTaskMode.TEACH,
      ),
    ).toEqual({ kind: 'teaching', result: { outcome: 'needs_input', reason: 'no_demonstration' } });
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it.each([
    {
      message: 'How do I use ChatGPT?',
      replyKind: TeachingReplyKind.EXPLANATION,
      answer: 'Open ChatGPT and enter a first question, such as Help me write a short email.',
      outcome: 'explained',
    },
    {
      message: 'Show me where to type in ChatGPT',
      replyKind: TeachingReplyKind.NEEDS_INPUT,
      answer: 'Open ChatGPT on the primary display, then describe the screen you see.',
      outcome: 'needs_input',
    },
  ])('preserves useful $replyKind text without calling it demonstrated', async (reply) => {
    vi.useFakeTimers();
    const { runner, runAgent, native } = await createRunner();
    runAgent.mockResolvedValue({ answer: reply.answer, replyKind: reply.replyKind, history: [] });
    expect(
      await runner.runTask(
        reply.message,
        DesktopLocale.ENGLISH,
        new AbortController().signal,
        AgentTaskMode.TEACH,
      ),
    ).toEqual({
      kind: 'teaching',
      result: {
        outcome: reply.outcome,
        answer: reply.answer,
        ...(reply.outcome === 'needs_input' ? { reason: 'no_demonstration' } : {}),
      },
    });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(native.mock.calls.some(([name]) => name === CursorCompanionTool.SHOW_SEQUENCE)).toBe(
      false,
    );
  });

  it('does not turn a claimed guide into an explanation without native receipts', async () => {
    vi.useFakeTimers();
    const { runner, runAgent } = await createRunner();
    runAgent.mockResolvedValue({
      answer: 'Done, I showed you',
      replyKind: TeachingReplyKind.GUIDE,
      history: [],
    });
    expect(
      await runner.runTask(
        'Show me',
        DesktopLocale.ENGLISH,
        new AbortController().signal,
        AgentTaskMode.TEACH,
      ),
    ).toEqual({ kind: 'teaching', result: { outcome: 'needs_input', reason: 'no_demonstration' } });
  });

  it('commits demonstrated only after receipt validation and host release', async () => {
    vi.useFakeTimers();
    const { runner, server, runAgent, native } = await createRunner();
    runAgent.mockImplementation(async () => {
      await server.callToolResult(CursorCompanionTool.SHOW_SEQUENCE, {
        presentation_version: 2,
        steps: [{ kind: 'circle' }],
        capture_id: 'capture',
      });
      return { answer: 'Follow this circle', history: [] };
    });
    expect(
      await runner.runTask(
        'Show me',
        DesktopLocale.ENGLISH,
        new AbortController().signal,
        AgentTaskMode.TEACH,
      ),
    ).toEqual({
      kind: 'teaching',
      result: { outcome: 'demonstrated', answer: 'Follow this circle' },
    });
    expect(native.mock.calls.some(([name]) => name === CursorCompanionTool.END_TASK)).toBe(true);
  });

  it('stops the SDK and never enters execution recovery after takeover', async () => {
    vi.useFakeTimers();
    const { runner, server, runAgent, native, readEpoch } = await createRunner();
    const implementation = native.getMockImplementation();
    native.mockImplementation(async (name, args, meta, options) => {
      if (name === CursorCompanionTool.SHOW_SEQUENCE) {
        return {
          content: [],
          isError: true,
          structuredContent: {
            status: 'canceled',
            task_epoch: readEpoch(),
            sequence_id: '22222222-2222-4222-8222-222222222222',
            following: true,
            active: false,
            reason: 'user_takeover',
          },
        };
      }
      if (!implementation) {
        throw new Error('Missing transport');
      }
      return implementation(name, args, meta, options);
    });
    runAgent.mockImplementation(async (_agent, _message, signal) => {
      await server.callToolResult(CursorCompanionTool.SHOW_SEQUENCE, {
        presentation_version: 2,
        steps: [{ kind: 'circle' }],
        capture_id: 'capture',
      });
      expect(signal.aborted).toBe(true);
      throw new Error('SDK aborted');
    });
    expect(
      await runner.runTask(
        'Show me',
        DesktopLocale.ENGLISH,
        new AbortController().signal,
        AgentTaskMode.TEACH,
      ),
    ).toEqual({ kind: 'teaching', result: { outcome: 'canceled', reason: 'user_takeover' } });
    expect(runAgent).toHaveBeenCalledOnce();
    expect(
      native.mock.calls.filter(([name]) => name === CursorCompanionTool.SHOW_SEQUENCE),
    ).toHaveLength(1);
  });
});

it('switches between harness execution and native teaching on the same transport with HUD progress', async () => {
  vi.useFakeTimers();
  const { server, runAgent, native } = await createRunner();
  const progress: string[] = [];
  const execution = vi
    .fn<import('./MainAgentRunner.js').RunTaskAgent>()
    .mockImplementation(async (_agent, _input, task) => {
      if (!task.goal) {
        task.defineGoal({
          summary: 'Inspect desktop',
          criteria: [{ description: 'Describe the current desktop' }],
        });
      }
      task.admitModelTurn();
      await server.callToolResult('get_desktop_state', {});
      return { finalOutput: { mode: 'task', answer: 'Done', verificationId: null }, history: [] };
    });
  const runner = new ComputerUseTaskRunner(server, pino({ level: 'silent' }), runAgent, execution);
  const result = await runner.runTask(
    'Inspect desktop',
    DesktopLocale.ENGLISH,
    new AbortController().signal,
    AgentTaskMode.EXECUTE,
    (phase) => progress.push(phase),
  );
  expect(result).toMatchObject({
    kind: 'completed',
    completion: { kind: 'task', outcome: { status: 'unverified' } },
  });
  expect(execution).toHaveBeenCalledTimes(2);
  expect(runAgent).not.toHaveBeenCalled();
  expect(progress).toEqual(['working', 'thinking', 'working', 'thinking']);
  expect(
    native.mock.calls.some(
      ([name, args]) => name === CursorCompanionTool.SET_MODE && args?.mode === 'hidden',
    ),
  ).toBe(true);
  expect(server.taskEvidence.readSnapshot().observations).toEqual([]);
  progress.length = 0;
  runAgent.mockImplementation(async () => {
    await server.callToolResult(CursorCompanionTool.SHOW_SEQUENCE, {
      presentation_version: 2,
      capture_id: 'capture',
      steps: [{ kind: 'circle' }],
    });
    return { answer: 'Follow this circle', history: [] };
  });
  expect(
    await runner.runTask(
      'Show me',
      DesktopLocale.VIETNAMESE,
      new AbortController().signal,
      AgentTaskMode.TEACH,
      (phase) => progress.push(phase),
    ),
  ).toEqual({
    kind: 'teaching',
    result: { outcome: 'demonstrated', answer: 'Follow this circle' },
  });
  expect(progress).toEqual(['showing', 'thinking']);
  expect(execution).toHaveBeenCalledTimes(2);
  expect(runAgent).toHaveBeenCalledOnce();
  await runner.close();
});
