import { run, type AgentInputItem } from '@openai/agents';
import type { Logger } from 'pino';
import type { AgentResult } from '#contracts/AgentSession.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { createComputerUseAgent } from './CreateComputerUseAgent.js';
import { chooseCuaDriverCommand, startCuaDriverApp } from './ChooseCuaDriverCommand.js';
import { TaskIssue } from './CuaTaskEvidence.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

type TaskResult = Extract<AgentResult, { kind: 'completed' | 'failed' }>;

function describeIncompleteTask(issue: TaskIssue): string {
  if (issue === TaskIssue.VERIFICATION_FAILED) {
    return 'Tro could not verify that the requested desktop change completed.';
  }
  if (issue === TaskIssue.OBSERVATION_MISSING) {
    return 'Tro did not inspect the desktop after its last action.';
  }
  return 'A desktop action failed and Tro could not verify recovery.';
}

function askAgentToFinishTask(): AgentInputItem {
  return {
    role: 'user',
    content:
      'A Cua action was not followed by a fresh state observation, a tool call failed, or verification did not satisfy the requested result. Inspect the current state with Cua before another action. For app or browser work, search windows across all Spaces before launching or navigating again. Correct any remaining failure and compare the observed result with the actual goal. If it cannot be confirmed, explain the limitation instead of claiming completion.',
  };
}

/** Owns the private Cua MCP transport; each message runs as a fresh task. */
export class ComputerUseTaskRunner {
  private constructor(
    private readonly desktopServer: LoggedCuaServer,
    private readonly log: Logger,
  ) {}

  static async connect(log: Logger): Promise<ComputerUseTaskRunner> {
    const installation = await chooseCuaDriverCommand();
    await startCuaDriverApp(installation);
    const desktopServer = new LoggedCuaServer(
      {
        name: 'Cua Driver',
        command: installation.command,
        args: ['mcp'],
        cacheToolsList: true,
      },
      log,
    );

    try {
      /* Discover the server before reporting desktop tools as ready. */
      await desktopServer.connect();
      const tools = await desktopServer.listTools();
      if (tools.length === 0) {
        throw new Error('Cua Driver did not expose desktop tools.');
      }
      log.debug({ toolCount: tools.length }, 'cua.connected');
      return new ComputerUseTaskRunner(desktopServer, log);
    } catch (error) {
      await desktopServer.close();
      throw error;
    }
  }

  async runTask(message: string, locale: DesktopLocale, signal: AbortSignal): Promise<TaskResult> {
    const startedAt = performance.now();
    const agent = createComputerUseAgent(this.desktopServer, locale);
    this.desktopServer.taskEvidence.reset();
    this.log.debug({ messageChars: message.length }, 'agent.task.started');
    try {
      let result = await run(agent, message, {
        signal,
        maxTurns: 15,
      });
      signal.throwIfAborted();
      let issue = this.desktopServer.taskEvidence.readIssue();
      if (issue !== null) {
        /* One bounded continuation gives the same task a chance to recover.
           History is kept only inside this task, never for the next message. */
        this.log.debug({ issue }, 'agent.task.retrying');
        result = await run(agent, [...result.history, askAgentToFinishTask()], {
          signal,
          maxTurns: 5,
        });
        signal.throwIfAborted();
        issue = this.desktopServer.taskEvidence.readIssue();
      }
      if (issue !== null) {
        this.log.debug(
          { issue, durationMs: Math.round(performance.now() - startedAt) },
          'agent.task.incomplete',
        );
        return { kind: 'failed', message: describeIncompleteTask(issue) };
      }

      const answer =
        result.finalOutput ??
        (locale === DesktopLocale.VIETNAMESE
          ? 'Tôi chưa thể hoàn tất yêu cầu này.'
          : 'I could not complete that request.');
      this.log.debug(
        { answerChars: answer.length, durationMs: Math.round(performance.now() - startedAt) },
        'agent.task.completed',
      );
      return { kind: 'completed', answer };
    } catch (error) {
      this.log.debug(
        {
          errorType: error instanceof Error ? error.name : typeof error,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'agent.task.failed',
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.desktopServer.close();
  }
}
