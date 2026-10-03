import { run, MaxTurnsExceededError, type AgentInputItem } from '@openai/agents';
import type { Logger } from 'pino';
import {
  AgentLogRole,
  describeTaskDiagnostics,
  readAgentLogContext,
  withAgentLogContext,
} from './AgentDebugLog.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { createComputerUseAgent } from './CreateComputerUseAgent.js';
import type { LoggedCuaServer } from '../cua/LoggedCuaServer.js';
import type { TaskContext } from '../execution/TaskContext.js';
import type { MainAgentPort, TaskControls } from '../execution/TaskExecutionPorts.js';
import {
  CompletionProposalSchema,
  type CompletionProposal,
} from '../execution/TaskCompletionProposal.js';
import { TaskTermination } from '../execution/TaskCompletionConfig.js';
import { assertContextByteBudget } from '../execution/TaskContextBudget.js';

type TaskAgent = ReturnType<typeof createComputerUseAgent>;

export interface TaskAttempt {
  finalOutput: unknown;
  history: AgentInputItem[];
}

export type RunTaskAgent = (
  agent: TaskAgent,
  input: string | AgentInputItem[],
  task: TaskContext,
  maxTurns: number,
  log?: Logger,
) => Promise<TaskAttempt>;

const runTaskAgent: RunTaskAgent = async (agent, input, task, maxTurns, log) => {
  let attemptModelTurns = 0;
  const result = await run(agent, input, {
    context: task,
    signal: task.abort.signal,
    maxTurns,
    callModelInputFilter: ({ modelData }) => {
      task.admitModelTurn();
      log?.debug(
        {
          ...describeTaskDiagnostics(task),
          ...readAgentLogContext(),
          attemptModelTurns: ++attemptModelTurns,
          maxTurns,
        },
        'agent.model.admitted',
      );
      assertContextByteBudget(modelData, task.config.maximumModelRequestBytes);
      return modelData;
    },
  });
  return { finalOutput: result.finalOutput, history: result.history };
};

/** Sole owner of actor SDK history; no history is shared with the verifier. */
export class MainAgentRunner implements MainAgentPort {
  private history: AgentInputItem[] = [];
  private readonly agent: TaskAgent;
  private attemptNumber = 0;

  constructor(
    server: LoggedCuaServer,
    locale: DesktopLocale,
    private readonly task: TaskContext,
    controls: TaskControls,
    private readonly runAgent: RunTaskAgent = runTaskAgent,
    private readonly log?: Logger,
  ) {
    this.agent = createComputerUseAgent(server, locale, controls);
  }

  runFirstAttempt(): Promise<CompletionProposal | null> {
    return this.runAttempt(this.task.instruction, this.task.config.initialModelTurns);
  }

  continueWithFeedback(feedback: string): Promise<CompletionProposal | null> {
    return this.runAttempt(
      [...structuredClone(this.history), { role: 'user', content: feedback }],
      this.task.config.recoveryModelTurns,
    );
  }

  dispose(): void {
    this.history = [];
  }

  private async runAttempt(
    input: string | AgentInputItem[],
    maxTurns: number,
  ): Promise<CompletionProposal | null> {
    const context = {
      taskId: this.task.id,
      agentRole: AgentLogRole.MAIN,
      attemptNumber: ++this.attemptNumber,
    };
    return withAgentLogContext(context, () => this.executeAttempt(input, maxTurns));
  }

  private async executeAttempt(
    input: string | AgentInputItem[],
    maxTurns: number,
  ): Promise<CompletionProposal | null> {
    this.task.assertActive();
    const startedAt = performance.now();
    this.log?.debug(
      {
        ...describeTaskDiagnostics(this.task),
        ...readAgentLogContext(),
        maxTurns,
        historyItems: this.history.length,
      },
      'agent.run.started',
    );
    try {
      const attempt = await this.runAgent(this.agent, input, this.task, maxTurns, this.log);
      this.task.assertActive();
      this.history = structuredClone(attempt.history);
      const parsed = CompletionProposalSchema.safeParse(attempt.finalOutput);
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          ...readAgentLogContext(),
          durationMs: Math.round(performance.now() - startedAt),
          historyItems: this.history.length,
          proposalValid: parsed.success,
          proposalMode: parsed.success ? parsed.data.mode : null,
          hasVerificationReference: parsed.success && parsed.data.verificationId !== null,
        },
        'agent.run.finished',
      );
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) {
        this.task.stop(TaskTermination.TURN_LIMIT);
      }
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          ...readAgentLogContext(),
          maxTurns,
          durationMs: Math.round(performance.now() - startedAt),
          errorType: error instanceof Error ? error.name : typeof error,
        },
        'agent.run.failed',
      );
      throw error;
    }
  }
}
