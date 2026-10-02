import { CompanionHudTool, type AgentProgressPhase } from '#contracts/CompanionHud.js';
import type { AgentInputItem } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { DesktopDriverConnection } from '#contracts/DesktopDriver.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { createComputerUseAgent } from './CreateComputerUseAgent.js';
import { TaskIssue } from './CuaTaskEvidence.js';
import { LoggedCuaServer } from './LoggedCuaServer.js';
import { AgentTaskMode, GuidanceReason, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { CuaCompanionClient, GuidanceTaskError } from './CuaCompanionClient.js';
import { runComputerUseAgent } from './RunComputerUseAgent.js';

type TaskResult = Extract<AgentResult, { kind: 'completed' | 'failed' | 'teaching' }>;

function describeIncompleteTask(issue: TaskIssue): string {
  if (issue === TaskIssue.GUIDANCE_FAILED) {
    return 'Tro could not finish the visual guide.';
  }
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
  private readonly companion: CuaCompanionClient | null;

  constructor(
    private readonly desktopServer: LoggedCuaServer,
    private readonly log: Logger,
    private readonly runAgent: typeof runComputerUseAgent = runComputerUseAgent,
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
  ): Promise<TaskResult> {
    if (
      mode === AgentTaskMode.TEACH &&
      (!this.companion || !this.desktopServer.hasGuidanceTools())
    ) {
      return {
        kind: 'teaching',
        result: { outcome: TeachingOutcome.FAILED, reason: GuidanceReason.UNSUPPORTED_VERSION },
      };
    }
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
    const agent = createComputerUseAgent(this.desktopServer, locale, mode);
    this.desktopServer.taskEvidence.reset();
    if (mode === AgentTaskMode.TEACH) {
      this.desktopServer.beginTeachingTask(taskEpoch, () => {
        teachingAbort.abort();
      });
    }
    this.log.debug({ messageChars: message.length }, 'agent.task.started');
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
      let result = await this.runAgent(agent, message, taskSignal, 15);
      signal.throwIfAborted();
      if (mode === AgentTaskMode.TEACH) {
        guidanceEnded = true;
        await this.companion?.endGuidanceTask(taskEpoch);
        signal.throwIfAborted();
        return {
          kind: 'teaching',
          result: this.desktopServer.taskEvidence.readTeachingResult(
            result.answer ??
              (locale === DesktopLocale.VIETNAMESE
                ? 'Hướng dẫn trực quan đã hoàn tất.'
                : 'The visual guide finished.'),
          ),
        };
      }
      let issue = this.desktopServer.taskEvidence.readIssue();
      if (issue !== null) {
        /* One bounded continuation gives the same task a chance to recover.
           History is kept only inside this task, never for the next message. */
        this.log.debug({ issue }, 'agent.task.retrying');
        result = await this.runAgent(agent, [...result.history, askAgentToFinishTask()], signal, 5);
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
        result.answer ??
        (locale === DesktopLocale.VIETNAMESE
          ? 'Tôi chưa thể hoàn tất yêu cầu này.'
          : 'I could not complete that request.');
      this.log.debug(
        { answerChars: answer.length, durationMs: Math.round(performance.now() - startedAt) },
        'agent.task.completed',
      );
      return { kind: 'completed', answer };
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
    }
  }

  async close(): Promise<void> {
    try {
      await this.companion?.close();
    } finally {
      await this.desktopServer.close();
    }
  }
}
