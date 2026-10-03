import type { Logger } from 'pino';
import { describeTaskDiagnostics } from '../agent/AgentDebugLog.js';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { TaskContext } from './TaskContext.js';
import type { DefineTaskGoalInput, TaskGoal } from './TaskGoal.js';
import type { MainAgentPort, TaskControls, VerificationPort } from './TaskExecutionPorts.js';
import { createVerificationEvidencePacket } from './TaskEvidencePacket.js';
import {
  assessVerificationOutput,
  createUnverifiedAssessment,
  readCompletionAssessment,
} from './CompletionGate.js';
import { createTaskResult } from './TaskResult.js';
import { TaskTermination } from './TaskCompletionConfig.js';
import { isTaskContextBudgetError } from './TaskContextBudget.js';

/** One foreground task. SDK runs may reenter its controls; no task-wide lock. */
export class TaskHarness implements TaskControls {
  private running = false;

  constructor(
    private readonly task: TaskContext,
    private readonly locale: DesktopLocale,
    private readonly settleCalls: () => Promise<void>,
    private readonly verifier: VerificationPort,
    private readonly log?: Logger,
  ) {}

  defineGoal(input: DefineTaskGoalInput): TaskGoal {
    const goal = this.task.defineGoal(input);
    this.log?.debug({ ...describeTaskDiagnostics(this.task) }, 'agent.goal.defined');
    return goal;
  }

  async requestVerification(): Promise<unknown> {
    this.task.assertActive();
    if (!this.task.canVerify()) {
      this.task.admitToolCall(false);
      this.log?.debug(
        { ...describeTaskDiagnostics(this.task), reason: 'verification_attempts_exhausted' },
        'agent.verification.rejected',
      );
      return {
        error:
          'Verification attempts are exhausted. Return the latest verdict or acknowledge that the result is unverified.',
        verificationId: this.task.latestVerification?.id ?? null,
      };
    }
    /* Synchronous before awaiting Cua: concurrent writes/verification cannot slip in. */
    let id: string;
    try {
      id = this.task.beginVerification();
    } catch (error) {
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          errorType: error instanceof Error ? error.name : typeof error,
        },
        'agent.verification.rejected',
      );
      throw error;
    }
    const startedAt = this.task.readTimeMs();
    this.log?.debug(
      { ...describeTaskDiagnostics(this.task), verificationId: id },
      'agent.verification.started',
    );
    try {
      await this.settleCalls();
      this.task.assertActive();
      const packet = createVerificationEvidencePacket(this.task, this.locale);
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          verificationId: id,
          locale: this.locale,
          packetBytes: Buffer.byteLength(JSON.stringify(packet)),
          packetObservationCount: packet.observations.length,
          imageParts: packet.content.filter(({ part }) => part.type === 'image').length,
          textParts: packet.content.filter(({ part }) => part.type === 'text').length,
          oldestCaptureAgeMs: Math.round(
            Math.max(
              0,
              ...packet.observations.map((item) => this.task.readTimeMs() - item.capturedAtMs),
            ),
          ),
        },
        'agent.verification.context',
      );
      const output = await this.verifier.verifyCurrentTask(packet);
      await this.settleCalls();
      this.task.assertActive();
      /* Refresh after verifier reads; retain raw observations for future attempts. */
      createVerificationEvidencePacket(this.task, this.locale);
      const { assessment, evidenceIds } = assessVerificationOutput(this.task, output);
      const snapshot = this.task.evidence.readSnapshot();
      const verification = Object.freeze({
        ...assessment,
        missingCriteria: Object.freeze([...assessment.missingCriteria]),
        id,
        taskId: this.task.id,
        revision: snapshot.revision,
        evidenceVersion: snapshot.version,
        verifiedAtMs: this.task.readTimeMs(),
        evidenceIds: Object.freeze([...evidenceIds]),
      });
      this.task.saveVerification(verification);
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          verificationId: id,
          durationMs: Math.round(this.task.readTimeMs() - startedAt),
          status: assessment.status,
          supported: assessment.supported,
          required: assessment.required,
          needsRecovery: assessment.needsRecovery,
          diagnosticReason: assessment.diagnosticReason ?? null,
          citedEvidenceCount: evidenceIds.length,
        },
        'agent.verification.finished',
      );
      return verification;
    } catch (error) {
      if (isTaskContextBudgetError(error)) {
        this.task.stop(TaskTermination.CONTEXT_LIMIT);
      }
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          verificationId: id,
          durationMs: Math.round(this.task.readTimeMs() - startedAt),
          errorType: error instanceof Error ? error.name : typeof error,
        },
        'agent.verification.failed',
      );
      throw error;
    } finally {
      this.task.endVerification();
    }
  }

  async run(main: MainAgentPort): Promise<AgentResult> {
    if (this.running) {
      throw new Error('The task harness already started.');
    }
    this.running = true;
    try {
      this.task.startWorking();
      let proposal = await main.runFirstAttempt();
      await this.settleCalls();
      this.task.assertActive();
      let assessment = readCompletionAssessment(this.task, proposal);
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          proposalMode: proposal?.mode ?? null,
          status: assessment.status,
          supported: assessment.supported,
          needsRecovery: assessment.needsRecovery,
          diagnosticReason: assessment.diagnosticReason ?? null,
        },
        'agent.completion.checked',
      );
      if (assessment.needsRecovery && this.task.canContinue()) {
        this.task.admitContinuation();
        this.log?.debug(
          { ...describeTaskDiagnostics(this.task), maxTurns: this.task.config.recoveryModelTurns },
          'agent.continuation.started',
        );
        proposal = await main.continueWithFeedback(
          'Completion is not yet verified. Keep the original request and goal. Reuse admissible observations. Do not repeat navigation merely to clear an old error. Address missing results, explicitly call verify_task when ready, then reference its current id in final output: ' +
            assessment.missingCriteria.join('; '),
        );
        await this.settleCalls();
        this.task.assertActive();
        assessment = readCompletionAssessment(this.task, proposal);
        this.log?.debug(
          {
            ...describeTaskDiagnostics(this.task),
            proposalMode: proposal?.mode ?? null,
            status: assessment.status,
            supported: assessment.supported,
            needsRecovery: assessment.needsRecovery,
            diagnosticReason: assessment.diagnosticReason ?? null,
          },
          'agent.completion.checked',
        );
      } else {
        this.log?.debug(
          {
            ...describeTaskDiagnostics(this.task),
            reason: assessment.needsRecovery
              ? 'continuation_budget_unavailable'
              : 'continuation_not_needed',
          },
          'agent.continuation.skipped',
        );
      }
      const result = createTaskResult(assessment, proposal, this.locale);
      this.task.settle(result.kind === 'failed');
      return result;
    } catch (error) {
      await this.settleCalls();
      if (isTaskContextBudgetError(error)) {
        this.task.stop(TaskTermination.CONTEXT_LIMIT);
      }
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          errorType: error instanceof Error ? error.name : typeof error,
        },
        'agent.task.interrupted',
      );
      this.log?.debug(
        {
          ...describeTaskDiagnostics(this.task),
          reason: this.task.termination ?? 'execution_error',
        },
        'agent.continuation.skipped',
      );
      if (this.task.termination === TaskTermination.USER) {
        return { kind: 'stopped' };
      }
      if (this.task.termination !== null) {
        const result = createTaskResult(
          {
            ...createUnverifiedAssessment(this.task, 'Task execution budget exhausted.'),
            needsRecovery: false,
          },
          null,
          this.locale,
        );
        this.task.settle(result.kind === 'failed');
        return result;
      }
      this.task.settle(true);
      throw error;
    } finally {
      main.dispose();
      this.task.dispose();
    }
  }
}
