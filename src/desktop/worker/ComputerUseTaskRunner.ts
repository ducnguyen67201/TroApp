import { MCPServerStdio, run } from '@openai/agents';
import type { Logger } from 'pino';
import { createComputerUseAgent } from './CreateComputerUseAgent.js';
import { chooseCuaDriverCommand, startCuaDriverApp } from './ChooseCuaDriverCommand.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';

/** Owns the private Cua MCP transport; each message runs as a fresh task. */
export class ComputerUseTaskRunner {
  private readonly agent;

  private constructor(
    private readonly desktopServer: MCPServerStdio,
    private readonly log: Logger,
  ) {
    this.agent = createComputerUseAgent(desktopServer);
  }

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

  async runTask(message: string, signal: AbortSignal): Promise<string> {
    const startedAt = performance.now();
    this.log.debug({ messageChars: message.length }, 'agent.task.started');
    try {
      const result = await run(this.agent, message, {
        signal,
        maxTurns: 15,
      });
      signal.throwIfAborted();
      const answer = result.finalOutput ?? 'I could not complete that request.';
      this.log.debug(
        { answerChars: answer.length, durationMs: Math.round(performance.now() - startedAt) },
        'agent.task.completed',
      );
      return answer;
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
