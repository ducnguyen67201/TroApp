import { CompanionHudTool, type AgentProgressPhase } from '#contracts/CompanionHud.js';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { DesktopDriverConnection } from '#contracts/DesktopDriver.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { createTeachingAgent } from './CreateComputerUseAgent.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';
import { AgentTaskMode, GuidanceReason, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { CuaCompanionClient, GuidanceTaskError } from './CuaCompanionClient.js';
import { runComputerUseAgent } from './RunComputerUseAgent.js';

import { describeTaskDiagnostics } from './AgentDebugLog.js';
import { TaskContext } from './TaskContext.js';
import { TaskCompletionConfig, type TaskBudgetConfig } from './TaskCompletionConfig.js';
import { MainAgentRunner, type RunTaskAgent } from './MainAgentRunner.js';
import { TaskHarness } from './TaskHarness.js';
import { TaskVerifier } from './TaskVerifier.js';

/** Owns the private Cua MCP transport; each message runs as a fresh task. */
export class ComputerUseTaskRunner {
  private active = false;
  private readonly companion: CuaCompanionClient | null;

  constructor(
    private readonly desktopServer: LoggedCuaServer,
    private readonly log: Logger,
    private readonly runAgent: typeof runComputerUseAgent = runComputerUseAgent,
    private readonly runExecutionAgent?: RunTaskAgent,
    private readonly config: TaskBudgetConfig = TaskCompletionConfig,
  ) {
    this.companion = desktopServer.hasCompanionTools()
      ? new CuaCompanionClient(desktopServer)
      : null;
  }

  static async connect(
    log: Logger,
    connection: DesktopDriverConnection,
    requiresCompanion = false,
    hudGroup?: string,
  ): Promise<ComputerUseTaskRunner> {
    const desktopServer = new LoggedCuaServer(
      {
        name: 'Cua Driver',
        ...connection,
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
      const runner = new ComputerUseTaskRunner(desktopServer, log);
      if (requiresCompanion && !runner.companion) {
        throw new Error('Cua Driver did not expose companion tools.');
      }
      if (hudGroup) {
        await desktopServer
          .callHostTool(CompanionHudTool.BIND_CURSOR, { group: hudGroup })
          .catch(() => {});
      }
      await runner.companion?.startFollowing();
      return runner;
    } catch (error) {
      await desktopServer.close();
      throw error;
    }
  }

  async runTask(
    message: string,
    locale: DesktopLocale,
    signal: AbortSignal,
    mode: AgentTaskMode = AgentTaskMode.EXECUTE,
    receiveProgress?: (phase: AgentProgressPhase) => void,
  ): Promise<AgentResult> {
    if (this.active) {
      throw new Error('Wait for the current task to finish.');
    }
    if (
      mode === AgentTaskMode.TEACH &&
      (!this.companion || !this.desktopServer.hasGuidanceTools())
    ) {
      return {
        kind: 'teaching',
        result: { outcome: TeachingOutcome.FAILED, reason: GuidanceReason.UNSUPPORTED_VERSION },
      };
    }
    this.active = true;
    this.desktopServer.setTaskMode(mode);
    this.desktopServer.setProgressListener(receiveProgress ?? null);
    const cancelGuidance = (): void => {
      void this.desktopServer.close().catch(() => {});
    };
    signal.addEventListener('abort', cancelGuidance, { once: true });
    const startedAt = performance.now();
    const taskEpoch = randomUUID();
    let guidanceStarted = false;
    let guidanceEnded = false;
    const teachingAbort = new AbortController();
    const taskSignal =
      mode === AgentTaskMode.TEACH ? AbortSignal.any([signal, teachingAbort.signal]) : signal;
    this.desktopServer.taskEvidence.reset();
    if (mode === AgentTaskMode.TEACH) {
      this.desktopServer.beginTeachingTask(taskEpoch, () => {
        teachingAbort.abort();
      });
    }
    this.log.debug({ mode, locale, messageChars: message.length }, 'agent.task.admitted');
    try {
      signal.throwIfAborted();
      if (this.companion) {
        if (mode === AgentTaskMode.TEACH) {
          await this.companion.startFollowing();
          await this.companion.beginGuidanceTask(taskEpoch);
          guidanceStarted = true;
        } else {
          await this.companion.pauseFollowing();
        }
      }
      signal.throwIfAborted();
      if (mode === AgentTaskMode.EXECUTE) {
        return await this.runExecutionTask(message, locale, signal);
      }
      const agent = createTeachingAgent(this.desktopServer, locale);
      const result = await this.runAgent(agent, message, taskSignal, 15);
      signal.throwIfAborted();
      guidanceEnded = true;
      await this.companion?.endGuidanceTask(taskEpoch);
      signal.throwIfAborted();
      const teachingResult = this.desktopServer.taskEvidence.readTeachingResult(
        result.answer ?? '',
        result.replyKind,
      );
      this.log.debug(
        {
          taskId: taskEpoch,
          mode,
          outcome: teachingResult.outcome,
          reason: 'reason' in teachingResult ? teachingResult.reason : null,
          replyKind: result.replyKind ?? null,
          hasAnswer: result.answer !== null,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'agent.teaching.settled',
      );
      return {
        kind: 'teaching',
        result: teachingResult,
      };
    } catch (error) {
      if (mode === AgentTaskMode.TEACH) {
        if (signal.aborted) {
          this.desktopServer.taskEvidence.cancelGuidance(GuidanceReason.EXPLICIT_STOP);
        } else if (error instanceof GuidanceTaskError && error.canceled) {
          this.desktopServer.taskEvidence.cancelGuidance(error.reason);
        } else if (!this.desktopServer.taskEvidence.hasTerminalGuidance()) {
          this.desktopServer.taskEvidence.failGuidance(
            error instanceof GuidanceTaskError ? error.reason : GuidanceReason.TRANSPORT_FAILED,
          );
        }
        return { kind: 'teaching', result: this.desktopServer.taskEvidence.readTeachingResult('') };
      }
      this.log.debug(
        {
          errorType: error instanceof Error ? error.name : typeof error,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'agent.task.failed',
      );
      throw error;
    } finally {
      await this.desktopServer.settleCalls();
      this.desktopServer.setProgressListener(null);
      signal.removeEventListener('abort', cancelGuidance);
      if (mode === AgentTaskMode.TEACH) {
        this.desktopServer.endTeachingTask();
        if (!signal.aborted && guidanceStarted && !guidanceEnded) {
          await this.companion?.endGuidanceTask(taskEpoch).catch(() => {});
        }
      } else {
        await this.companion?.cancelSequence().catch(() => {});
      }
      if (!signal.aborted) {
        await this.companion?.startFollowing().catch(() => {});
      }
      this.active = false;
    }
  }

  private async runExecutionTask(
    message: string,
    locale: DesktopLocale,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const startedAt = performance.now();
    const task = new TaskContext(
      this.desktopServer.taskEvidence,
      signal,
      this.config,
      undefined,
      message,
    );
    const taskLog = this.log.child({ taskId: task.id });
    taskLog.debug(
      { ...describeTaskDiagnostics(task), locale, limits: this.config },
      'agent.task.started',
    );
    this.desktopServer.bindTask(task);
    const harness = new TaskHarness(
      task,
      locale,
      () => this.desktopServer.settleCalls(),
      new TaskVerifier(task, this.desktopServer, locale, undefined, taskLog),
      taskLog,
    );
    const main = new MainAgentRunner(
      this.desktopServer,
      locale,
      task,
      harness,
      this.runExecutionAgent,
      taskLog,
    );
    try {
      const result = await harness.run(main);
      taskLog.debug(
        {
          ...describeTaskDiagnostics(task),
          resultKind: result.kind,
          outcome:
            result.kind === 'completed' && result.completion.kind === 'task'
              ? result.completion.outcome.status
              : null,
        },
        'agent.task.settled',
      );
      return result;
    } finally {
      await this.desktopServer.settleCalls();
      taskLog.debug(
        { ...describeTaskDiagnostics(task), durationMs: Math.round(performance.now() - startedAt) },
        'agent.task.finished',
      );
      this.desktopServer.bindTask(null);
    }
  }

  async close(): Promise<void> {
    await this.desktopServer.settleCalls();
    try {
      await this.companion?.close();
    } finally {
      await this.desktopServer.close();
    }
  }
}
