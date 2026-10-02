import type { CompletionProposal } from './TaskCompletionProposal.js';
import type { VerificationEvidencePacket } from './TaskEvidencePacket.js';
import type { DefineTaskGoalInput, TaskGoal } from './TaskGoal.js';

/** Per-task adapters bind cancellation, locale and budgets during construction. */
export interface MainAgentPort {
  runFirstAttempt(): Promise<CompletionProposal | null>;
  continueWithFeedback(feedback: string): Promise<CompletionProposal | null>;
  dispose(): void;
}

export interface VerificationPort {
  verifyCurrentTask(packet: VerificationEvidencePacket): Promise<unknown>;
}

/** Narrow controls for model tools. Only the harness schedules and saves verdicts. */
export interface TaskControls {
  defineGoal(input: DefineTaskGoalInput): TaskGoal;
  requestVerification(): Promise<unknown>;
}
