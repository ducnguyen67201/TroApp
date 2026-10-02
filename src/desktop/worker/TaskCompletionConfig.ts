/** Fixed operational defaults; tests inject smaller budgets without environment changes. */
export const TaskCompletionConfig = {
  initialModelTurns: 15,
  recoveryModelTurns: 5,
  verificationModelTurns: 3,
  maximumVerificationAttempts: 2,
  deadlineMs: 110_000,
  maximumToolCalls: 40,
  maximumRepeatedInspections: 2,
  maximumNoProgressCalls: 3,
  settleAllowanceMs: 3000,
  maximumEvidenceAgeMs: 10_000,
  maximumEvidencePacketBytes: 4 * 1024 * 1024,
  maximumRetainedEvidenceBytes: 16 * 1024 * 1024,
  maximumModelRequestBytes: 8 * 1024 * 1024,
} as const;

export interface TaskBudgetConfig {
  initialModelTurns: number;
  recoveryModelTurns: number;
  verificationModelTurns: number;
  maximumVerificationAttempts: number;
  deadlineMs: number;
  maximumToolCalls: number;
  maximumRepeatedInspections: number;
  maximumNoProgressCalls: number;
  settleAllowanceMs: number;
  maximumEvidenceAgeMs: number;
  maximumEvidencePacketBytes: number;
  maximumRetainedEvidenceBytes: number;
  maximumModelRequestBytes: number;
}

export const TaskTermination = {
  USER: 'user',
  DEADLINE: 'deadline',
  TOOL_LIMIT: 'tool_limit',
  LOOP: 'loop',
  TURN_LIMIT: 'turn_limit',
  CONTEXT_LIMIT: 'context_limit',
} as const;

export type TaskTermination = (typeof TaskTermination)[keyof typeof TaskTermination];
