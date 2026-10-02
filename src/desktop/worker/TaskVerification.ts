import { z } from 'zod';
import { CompletionMode, TaskOutcomeLimits, type TaskOutcome } from '#contracts/TaskOutcome.js';
import { CriterionState } from './TaskGoal.js';

export const VerificationDecision = {
  CONFIRMED: 'confirmed',
  NEEDS_WORK: 'needs_work',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
} as const;

export type VerificationDecision = (typeof VerificationDecision)[keyof typeof VerificationDecision];

/** Model judgment has one decision; contradictory independent flags are impossible. */
export const TaskVerificationSchema = z.strictObject({
  decision: z.enum(VerificationDecision),
  summary: z.string().trim().min(1).max(TaskOutcomeLimits.MAX_LIMITATION_CHARACTERS),
  missingRequirements: z.array(z.string().trim().min(1).max(500)).max(5),
  criteria: z
    .array(
      z.strictObject({
        criterionId: z.string().min(1).max(80),
        state: z.enum(CriterionState),
        evidenceIds: z.array(z.string().min(1).max(80)).max(5),
        explanation: z.string().trim().min(1).max(1000),
      }),
    )
    .max(TaskOutcomeLimits.MAX_REQUIRED_CRITERIA),
});

/** Worker-owned gate diagnostics are safe to log; model explanations are not. */
export const CompletionGateReason = {
  VERDICT_SCHEMA_INVALID: 'verdict_schema_invalid',
  GOAL_REQUIRED: 'goal_required',
  TOOLS_PENDING: 'tools_pending',
  CRITERION_COVERAGE: 'criterion_coverage_mismatch',
  EVIDENCE_INVALID: 'evidence_not_admissible',
  EVIDENCE_MISSING: 'satisfied_criterion_without_evidence',
  DECISION_INCONSISTENT: 'decision_inconsistent',
  PROPOSAL_MISSING: 'missing_or_invalid_proposal',
  TASK_MODE_REQUIRED: 'task_mode_required',
  VERIFICATION_REQUIRED: 'verification_required',
  WRONG_TASK: 'verification_wrong_task',
  WRONG_ID: 'verification_id_mismatch',
  REVISION_CHANGED: 'desktop_revision_changed',
  VERIFIER_ACTIVE: 'verification_in_progress',
  EVIDENCE_STALE: 'cited_evidence_stale',
  DESKTOP_USE_WITHOUT_GOAL: 'desktop_use_without_goal',
} as const;

export type CompletionGateReason = (typeof CompletionGateReason)[keyof typeof CompletionGateReason];

export interface TaskAssessment {
  diagnosticReason?: CompletionGateReason;
  mode: (typeof CompletionMode)[keyof typeof CompletionMode];
  status: TaskOutcome['status'];
  required: number;
  supported: number;
  missingCriteria: readonly string[];
  needsRecovery: boolean;
  limitation: string | null;
}

export interface TaskVerification extends TaskAssessment {
  readonly id: string;
  readonly taskId: string;
  readonly revision: number;
  readonly evidenceVersion: number;
  readonly verifiedAtMs: number;
  readonly evidenceIds: readonly string[];
}
