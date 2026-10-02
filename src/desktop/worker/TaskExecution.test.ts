import { MCPServerStdio, MaxTurnsExceededError } from '@openai/agents';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { AgentResultSchema } from '#contracts/AgentSession.js';
import { ComputerUseTaskRunner } from './ComputerUseTaskRunner.js';
import type { RunTaskAgent } from './MainAgentRunner.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';
import { TaskHarness } from './TaskHarness.js';
import { TaskCompletionConfig } from './TaskCompletionConfig.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function createServer(): LoggedCuaServer {
  const server = new LoggedCuaServer(
    { name: 'runner fixture', command: 'unused', args: ['mcp'] },
    pino({ level: 'silent' }),
  );
  server.taskEvidence.setReadOnlyTools(['get_window_state']);
  return server;
}

const goal = { summary: 'Open page', criteria: [{ description: 'YouTube is open and visible' }] };

describe('actor-requested sequential task verification', () => {
  it('logs an SDK turn-limit stop and skipped continuation with remaining budget', async () => {
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => lines.push(chunk.toString('utf8')));
    const runAgent: RunTaskAgent = (_agent, _input, task, maxTurns) => {
      task.defineGoal(goal);
      for (let turn = 0; turn < maxTurns; turn += 1) {
        task.admitModelTurn();
      }
      return Promise.reject(new MaxTurnsExceededError('private model state'));
    };
    const runner = new ComputerUseTaskRunner(
      createServer(),
      pino({ level: 'debug' }, output),
      undefined,
      runAgent,
    );
    const result = await runner.runTask(
      'private user request',
      DesktopLocale.ENGLISH,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      kind: 'completed',
      completion: { kind: 'task', outcome: { status: 'unverified' } },
    });
    const logs = lines.join('');
    expect(logs).toContain('agent.run.failed');
    expect(logs).toContain('agent.continuation.skipped');
    expect(logs).toContain('"reason":"turn_limit"');
    expect(logs).toContain('"remainingMainModelTurns":5');
    expect(logs).toContain('"verificationAttempts":0');
    expect(logs).toContain('"continuations":0');
    expect(logs).toContain('"agentRole":"main"');
    expect(logs).not.toContain('private');
  });
  it('retains actor history for one recovery without automatic verification', async () => {
    const verify = vi.spyOn(TaskHarness.prototype, 'requestVerification');
    const driver = vi.spyOn(MCPServerStdio.prototype, 'callToolResult').mockResolvedValue({
      content: [{ type: 'text', text: 'YouTube home loaded' }],
      structuredContent: { pid: 7, window_id: 12 },
    });
    const server = createServer();
    let attempts = 0;
    const runAgent = vi.fn<RunTaskAgent>().mockImplementation(async (agent, input, task, turns) => {
      task.admitModelTurn();
      expect(agent.instructions).toContain('Respond to the user in Vietnamese');
      if (++attempts === 1) {
        task.defineGoal(goal);
        task.admitModelTurn();
        await server.callToolResult('launch_app', {});
        expect(turns).toBe(15);
      } else {
        expect(turns).toBe(5);
        expect(input).toEqual(expect.arrayContaining([{ role: 'user', content: 'Mở YouTube' }]));
        await server.callToolResult('get_window_state', { pid: 7, window_id: 12 });
      }
      return {
        finalOutput: { mode: 'task', answer: 'Done', verificationId: null },
        history: [{ role: 'user', content: 'Mở YouTube' }],
      };
    });
    const runner = new ComputerUseTaskRunner(
      server,
      pino({ level: 'silent' }),
      undefined,
      runAgent,
    );
    const result = AgentResultSchema.parse(
      await runner.runTask('Mở YouTube', DesktopLocale.VIETNAMESE, new AbortController().signal),
    );
    expect(result).toMatchObject({
      kind: 'completed',
      completion: { kind: 'task', outcome: { status: 'unverified' } },
    });
    expect(result).not.toMatchObject({ answer: 'Done' });
    expect(verify).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(driver.mock.calls.map((call) => call[0])).toEqual(['launch_app', 'get_window_state']);
    expect(server.taskEvidence.readSnapshot().observations).toEqual([]);
  });

  it('does not run a verifier or recovery for ordinary conversation', async () => {
    const verify = vi.spyOn(TaskHarness.prototype, 'requestVerification');
    const runAgent = vi.fn<RunTaskAgent>().mockResolvedValue({
      finalOutput: { mode: 'response', answer: 'Hello!', verificationId: null },
      history: [],
    });
    const runner = new ComputerUseTaskRunner(
      createServer(),
      pino({ level: 'silent' }),
      undefined,
      runAgent,
    );
    expect(await runner.runTask('Hi', DesktopLocale.ENGLISH, new AbortController().signal)).toEqual(
      { kind: 'completed', answer: 'Hello!', completion: { kind: 'response' } },
    );
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not accept response mode as a desktop success bypass', async () => {
    const runAgent: RunTaskAgent = (_agent, _input, task) => {
      if (!task.goal) {
        task.defineGoal(goal);
      }
      task.admitModelTurn();
      return Promise.resolve({
        finalOutput: { mode: 'response', answer: 'Done!', verificationId: null },
        history: [],
      });
    };
    const runner = new ComputerUseTaskRunner(
      createServer(),
      pino({ level: 'silent' }),
      undefined,
      runAgent,
    );
    const result = await runner.runTask(
      'Open page',
      DesktopLocale.ENGLISH,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      kind: 'completed',
      completion: { kind: 'task', outcome: { status: 'unverified' } },
    });
    expect(result).not.toMatchObject({ answer: 'Done!' });
  });

  it.each([false, true])(
    'rejects response mode after read-only desktop use, including failed reads: %s',
    async (fails) => {
      const server = createServer();
      const driver = vi.spyOn(MCPServerStdio.prototype, 'callToolResult');
      if (fails) {
        driver.mockRejectedValue(new Error('Synthetic permission failure'));
      } else {
        driver.mockResolvedValue({ content: [{ type: 'text', text: 'YouTube page' }] });
      }
      const runAgent = vi.fn<RunTaskAgent>().mockImplementation(async (_agent, _input, task) => {
        task.admitModelTurn();
        try {
          await server.callToolResult('get_window_state', { pid: 7, window_id: 12 });
        } catch {
          /* The actor still proposes an unsupported success after a failed read. */
        }
        expect(task.hasUsedDesktopTools).toBe(true);
        return {
          finalOutput: { mode: 'response', answer: 'YouTube is open.', verificationId: null },
          history: [],
        };
      });
      const runner = new ComputerUseTaskRunner(
        server,
        pino({ level: 'silent' }),
        undefined,
        runAgent,
      );
      expect(
        await runner.runTask('Open YouTube', DesktopLocale.ENGLISH, new AbortController().signal),
      ).toMatchObject({ kind: 'failed' });
      expect(runAgent).toHaveBeenCalledTimes(2);
    },
  );

  it('returns stopped on cancellation and allows a subsequent fresh task', async () => {
    const user = new AbortController();
    const runAgent = vi
      .fn<RunTaskAgent>()
      .mockImplementationOnce((_agent, _input, task) => {
        user.abort();
        task.abort.signal.throwIfAborted();
        return Promise.resolve({ finalOutput: null, history: [] });
      })
      .mockResolvedValue({
        finalOutput: { mode: 'response', answer: 'Hello', verificationId: null },
        history: [],
      });
    const runner = new ComputerUseTaskRunner(
      createServer(),
      pino({ level: 'silent' }),
      undefined,
      runAgent,
    );
    expect(await runner.runTask('Open page', DesktopLocale.ENGLISH, user.signal)).toEqual({
      kind: 'stopped',
    });
    expect(
      await runner.runTask('Hi', DesktopLocale.ENGLISH, new AbortController().signal),
    ).toMatchObject({ kind: 'completed', completion: { kind: 'response' } });
  });

  it('returns unverified at a safety budget without invoking a verifier', async () => {
    const verify = vi.spyOn(TaskHarness.prototype, 'requestVerification');
    const runAgent: RunTaskAgent = (_agent, _input, task) => {
      task.defineGoal(goal);
      task.admitToolCall(false);
      return Promise.resolve({ finalOutput: null, history: [] });
    };
    const runner = new ComputerUseTaskRunner(
      createServer(),
      pino({ level: 'silent' }),
      undefined,
      runAgent,
      {
        ...TaskCompletionConfig,
        maximumToolCalls: 1,
      },
    );
    expect(
      await runner.runTask('Open page', DesktopLocale.ENGLISH, new AbortController().signal),
    ).toMatchObject({
      kind: 'completed',
      completion: { kind: 'task', outcome: { status: 'unverified' } },
    });
    expect(verify).not.toHaveBeenCalled();
  });
});
