import type { StudentActivity } from '#contracts/StudentActivity.js';
import type { ClassroomTeachingSession } from '../teaching/ClassroomTeachingTools.js';
import { logAgentExchange } from './AgentExchangeLog.js';
import { CompanionHudTool, type AgentProgressPhase } from '#contracts/CompanionHud.js';
import type { Logger } from 'pino';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { DesktopDriverConnection } from '#contracts/DesktopDriver.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { LoggedCuaServer } from '../cua/LoggedCuaServer.js';
import { AgentTaskMode, GuidanceReason, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { CuaCompanionClient } from '../cua/CuaCompanionClient.js';
import { runComputerUseAgent } from './RunComputerUseAgent.js';
import { TeachingTaskRunner, type ReceiveTeachingStep } from '../teaching/TeachingTaskRunner.js';

import { describeTaskDiagnostics } from './AgentDebugLog.js';
import { TaskContext } from '../execution/TaskContext.js';
import { TaskCompletionConfig, type TaskBudgetConfig } from '../execution/TaskCompletionConfig.js';
import { MainAgentRunner, type RunTaskAgent } from './MainAgentRunner.js';
import { TaskHarness } from '../execution/TaskHarness.js';
import { TaskVerifier } from '../execution/TaskVerifier.js';

/** Owns the private Cua MCP transport; each message runs as a fresh task. */
export class ComputerUseTaskRunner {
  private active = false;
  private teachingRunner: TeachingTaskRunner | null = null;

  submitTeachingAnswer(lessonId: string, answer: string): boolean {
    return this.teachingRunner?.submitAnswer(lessonId, answer) ?? false;
  }

  updateTeachingLocale(locale: DesktopLocale): boolean {
    return this.teachingRunner?.updateLocale(locale) ?? false;
  }
  recordStudentActivity(activity: StudentActivity): void {
    this.teachingRunner?.recordStudentActivity(activity);
  }

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
        desktopServer.setHudGroup(hudGroup);
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
    receiveTeachingStep?: ReceiveTeachingStep,
    classroom?: ClassroomTeachingSession,
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
    this.desktopServer.taskEvidence.reset();
    this.log.debug({ mode, locale, messageChars: message.length }, 'agent.task.admitted');
    logAgentExchange(this.log, {
      operation: 'task.admitted',
      input: { request: message, mode, locale },
      output: { admitted: true },
    });
    try {
      signal.throwIfAborted();
      if (this.companion) {
        if (mode === AgentTaskMode.EXECUTE) {
          await this.companion.pauseFollowing();
        }
      }
      signal.throwIfAborted();
      if (mode === AgentTaskMode.EXECUTE) {
        return await this.runExecutionTask(message, locale, signal);
      }
      if (!this.companion) {
        throw new Error('Teaching companion is unavailable.');
      }
      this.teachingRunner = new TeachingTaskRunner(
        this.desktopServer,
        this.companion,
        this.log,
        this.runAgent,
      );
      const result = await this.teachingRunner.run(
        message,
        locale,
        signal,
        receiveTeachingStep,
        classroom,
      );
      this.log.debug(
        {
          mode,
          outcome: result.outcome,
          reason: 'reason' in result ? result.reason : null,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'agent.teaching.settled',
      );
      return { kind: 'teaching', result };
    } catch (error) {
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
      if (mode === AgentTaskMode.EXECUTE) {
        await this.companion?.cancelSequence().catch(() => {});
      }
      if (!signal.aborted) {
        await this.companion?.startFollowing().catch(() => {});
      }
      this.teachingRunner = null;
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
