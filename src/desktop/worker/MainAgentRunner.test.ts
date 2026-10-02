import type { AgentInputItem } from '@openai/agents';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { MainAgentRunner, type RunTaskAgent } from './MainAgentRunner.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';
import { TaskContext } from './TaskContext.js';

describe('actor SDK history ownership', () => {
  it('keeps an independent continuation history and never puts it in task state', async () => {
    const server = new LoggedCuaServer(
      { name: 'history fixture', command: 'unused' },
      pino({ level: 'silent' }),
    );
    const task = new TaskContext(server.taskEvidence, new AbortController().signal);
    const history: AgentInputItem[] = [{ role: 'user', content: 'Original input' }];
    const runAgent = vi.fn<RunTaskAgent>().mockResolvedValue({
      finalOutput: { mode: 'response', answer: 'Hello', verificationId: null },
      history,
    });
    const main = new MainAgentRunner(
      server,
      DesktopLocale.ENGLISH,
      task,
      {
        defineGoal: (input) => task.defineGoal(input),
        requestVerification: () => Promise.resolve(null),
      },
      runAgent,
    );
    try {
      await main.runFirstAttempt();
      history.push({ role: 'user', content: 'Late mutation' });
      await main.continueWithFeedback('Review the result');
      expect(runAgent.mock.calls[1]?.[1]).toEqual([
        { role: 'user', content: 'Original input' },
        { role: 'user', content: 'Review the result' },
      ]);
    } finally {
      main.dispose();
      task.dispose();
    }
  });
});
