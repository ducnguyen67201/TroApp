import { TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import { randomUUID } from 'node:crypto';
import type { TaskVerification } from './TaskVerification.js';
import {
  TaskCompletionConfig,
  TaskTermination,
  type TaskBudgetConfig,
} from './TaskCompletionConfig.js';
import { CuaTaskEvidence } from '../cua/CuaTaskEvidence.js';
import { defineTaskGoal, type DefineTaskGoalInput, type TaskGoal } from './TaskGoal.js';

export const TaskPhase = {
  CREATED: 'created',
  WORKING: 'working',
  VERIFYING: 'verifying',
  READY_TO_FINISH: 'ready_to_finish',
  SETTLED: 'settled',
  STOPPED: 'stopped',
  FAILED: 'failed',
} as const;

export type TaskPhase = (typeof TaskPhase)[keyof typeof TaskPhase];

/** Per-task control state. No success check runs while desktop tools execute. */
export class TaskContext {
  readonly evidence: CuaTaskEvidence;
  readonly abort = new AbortController();
  private taskGoal: TaskGoal | null = null;
  termination: TaskTermination | null = null;
  private modelTurns = 0;
  private verificationTurns = 0;
  private totalVerificationTurns = 0;
  private verificationAttempts = 0;
  readonly id = randomUUID();
  private currentPhase: TaskPhase = TaskPhase.CREATED;
  private desktopToolsUsed = false;
  private continuationCount = 0;
  private verification: TaskVerification | null = null;
  private toolCalls = 0;
  private goalAcknowledged = false;
  private repeatedInspections = 0;
  private noProgressCalls = 0;
  private lastFingerprint: string | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly removeUserListener: () => void;
  private readonly startedAt: number;

  constructor(
    evidence: CuaTaskEvidence,
    userSignal: AbortSignal,
    readonly config: TaskBudgetConfig = TaskCompletionConfig,
    private readonly readTime: () => number = () => performance.now(),
    readonly instruction: string = '',
  ) {
    this.evidence = evidence;
    this.evidence.configure(this.id, config, readTime);
    this.startedAt = readTime();
    const stop = (): void => {
      this.stop(TaskTermination.USER);
    };
    userSignal.addEventListener('abort', stop, { once: true });
    this.removeUserListener = () => {
      userSignal.removeEventListener('abort', stop);
    };
    this.timer = setTimeout(() => {
      this.stop(TaskTermination.DEADLINE);
    }, config.deadlineMs);
    this.timer.unref();
    if (userSignal.aborted) {
      stop();
    }
  }

  defineGoal(input: DefineTaskGoalInput): TaskGoal {
    this.admitToolCall(false);
    if (this.goal !== null) {
      throw new Error('The task goal cannot be changed.');
    }
    this.taskGoal = defineTaskGoal(input);
    return this.taskGoal;
  }

  get goal(): TaskGoal | null {
    return this.taskGoal;
  }

  admitModelTurn(): void {
    this.startWorking();
    if (this.isVerifying) {
      throw new Error('The main agent must wait for verification.');
    }
    if (++this.modelTurns > this.config.initialModelTurns + this.config.recoveryModelTurns) {
      this.stop(TaskTermination.TURN_LIMIT);
      this.abort.signal.throwIfAborted();
    }
    this.goalAcknowledged = this.goal !== null;
  }

  get phase(): TaskPhase {
    return this.currentPhase;
  }

  get hasUsedDesktopTools(): boolean {
    return this.desktopToolsUsed;
  }

  readTimeMs(): number {
    return this.readTime();
  }

  readRemainingTimeMs(): number {
    return Math.max(0, this.config.deadlineMs - (this.readTime() - this.startedAt));
  }

  /** Explain write admission and loop stops without exposing captured content. */
  readProgressDiagnostics(): {
    goalAcknowledged: boolean;
    repeatedInspections: number;
    noProgressCalls: number;
  } {
    return {
      goalAcknowledged: this.goalAcknowledged,
      repeatedInspections: this.repeatedInspections,
      noProgressCalls: this.noProgressCalls,
    };
  }

  startWorking(): void {
    this.assertActive();
    if (this.currentPhase === TaskPhase.CREATED) {
      this.currentPhase = TaskPhase.WORKING;
    }
  }

  assertActive(): void {
    this.abort.signal.throwIfAborted();
    if (
      this.currentPhase === TaskPhase.SETTLED ||
      this.currentPhase === TaskPhase.FAILED ||
      this.currentPhase === TaskPhase.STOPPED
    ) {
      throw new Error('The desktop task has ended.');
    }
  }

  markDesktopToolUse(): void {
    this.assertActive();
    this.desktopToolsUsed = true;
  }

  invalidateVerification(): void {
    this.assertActive();
    this.verification = null;
    if (this.currentPhase === TaskPhase.READY_TO_FINISH) {
      this.currentPhase = TaskPhase.WORKING;
    }
  }

  admitContinuation(): void {
    this.assertActive();
    if (!this.canContinue() || this.continuationCount !== 0) {
      throw new Error('The continuation budget is exhausted.');
    }
    this.continuationCount += 1;
  }

  settle(hasFailed: boolean): void {
    if (
      this.termination === TaskTermination.USER ||
      this.phase === TaskPhase.SETTLED ||
      this.phase === TaskPhase.STOPPED
    ) {
      throw new Error('The desktop task has ended.');
    }
    if (this.termination === null) {
      this.assertActive();
    }
    if (this.isVerifying || this.evidence.readSnapshot().inFlight !== 0) {
      throw new Error('Settle pending work before ending the task.');
    }
    this.currentPhase = hasFailed ? TaskPhase.FAILED : TaskPhase.SETTLED;
  }

  get isVerifying(): boolean {
    return this.currentPhase === TaskPhase.VERIFYING;
  }

  get latestVerification(): TaskVerification | null {
    return this.verification;
  }

  canVerify(): boolean {
    return (
      !this.abort.signal.aborted &&
      (this.phase === TaskPhase.CREATED ||
        this.phase === TaskPhase.WORKING ||
        this.phase === TaskPhase.READY_TO_FINISH ||
        this.phase === TaskPhase.VERIFYING) &&
      this.verificationAttempts < this.config.maximumVerificationAttempts
    );
  }

  beginVerification(): string {
    this.admitToolCall(false);
    if (this.isVerifying || !this.goalAcknowledged || !this.canVerify()) {
      throw new Error(
        'Verification needs an acknowledged goal, an available attempt, and no other verification in progress.',
      );
    }
    this.currentPhase = TaskPhase.VERIFYING;
    this.verificationTurns = 0;
    this.verification = null;
    return `verification-${String(++this.verificationAttempts)}`;
  }

  admitVerificationModelTurn(): void {
    this.assertActive();
    this.totalVerificationTurns += 1;
    if (!this.isVerifying || ++this.verificationTurns > this.config.verificationModelTurns) {
      this.stop(TaskTermination.TURN_LIMIT);
      this.abort.signal.throwIfAborted();
    }
  }

  saveVerification(verification: TaskVerification): void {
    this.assertActive();
    if (!this.isVerifying) {
      throw new Error('Verification is not running.');
    }
    this.verification = verification;
  }

  endVerification(): void {
    if (this.currentPhase === TaskPhase.VERIFYING) {
      this.currentPhase =
        this.verification?.status === TaskOutcomeStatus.SUCCEEDED
          ? TaskPhase.READY_TO_FINISH
          : TaskPhase.WORKING;
    }
  }

  admitToolCall(isMutation: boolean): void {
    this.startWorking();
    if (++this.toolCalls > this.config.maximumToolCalls) {
      this.stop(TaskTermination.TOOL_LIMIT);
      this.abort.signal.throwIfAborted();
    }
    if (isMutation && this.isVerifying) {
      throw new Error('Task verification is read-only.');
    }
    if (isMutation && !this.goalAcknowledged) {
      throw new Error('Define the task goal and wait for its result before desktop actions.');
    }
  }

  recordProgress(fingerprint: string, isObservation: boolean): void {
    if (
      this.isVerifying ||
      !this.goal ||
      this.readTime() - this.startedAt < this.config.settleAllowanceMs
    ) {
      return;
    }
    const isNew = this.evidence.recordFingerprint(fingerprint);
    this.noProgressCalls = isNew ? 0 : this.noProgressCalls + 1;
    this.repeatedInspections =
      isObservation && this.lastFingerprint === fingerprint ? this.repeatedInspections + 1 : 0;
    this.lastFingerprint = fingerprint;
    if (
      this.repeatedInspections >= this.config.maximumRepeatedInspections ||
      this.noProgressCalls >= this.config.maximumNoProgressCalls
    ) {
      this.stop(TaskTermination.LOOP);
    }
  }

  canContinue(): boolean {
    return (
      !this.abort.signal.aborted &&
      this.continuationCount === 0 &&
      (this.phase === TaskPhase.WORKING || this.phase === TaskPhase.READY_TO_FINISH) &&
      this.modelTurns < this.config.initialModelTurns + this.config.recoveryModelTurns &&
      this.toolCalls < this.config.maximumToolCalls
    );
  }

  readExecutionCounts(): {
    mainModelTurns: number;
    verificationModelTurns: number;
    verificationAttempts: number;
    toolCalls: number;
    continuations: number;
  } {
    return {
      mainModelTurns: this.modelTurns,
      verificationModelTurns: this.totalVerificationTurns,
      verificationAttempts: this.verificationAttempts,
      toolCalls: this.toolCalls,
      continuations: this.continuationCount,
    };
  }

  stop(reason: TaskTermination): void {
    if (this.phase === TaskPhase.SETTLED || this.phase === TaskPhase.STOPPED) {
      return;
    }
    if (this.termination === null) {
      this.termination = reason;
      this.currentPhase = reason === TaskTermination.USER ? TaskPhase.STOPPED : TaskPhase.FAILED;
      this.abort.abort();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.removeUserListener();
    if (this.currentPhase !== TaskPhase.SETTLED && this.currentPhase !== TaskPhase.STOPPED) {
      this.currentPhase = TaskPhase.FAILED;
    }
    this.evidence.reset();
    this.verification = null;
  }
}
