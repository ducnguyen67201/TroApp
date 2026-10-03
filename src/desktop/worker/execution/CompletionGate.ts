import { CompletionMode, TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import { CriterionState } from './TaskGoal.js';
import {
  TaskVerificationSchema,
  CompletionGateReason,
  VerificationDecision,
  type TaskAssessment,
} from './TaskVerification.js';
import type { CompletionProposal } from './TaskCompletionProposal.js';
import type { TaskContext } from './TaskContext.js';

export function createUnverifiedAssessment(
  task: TaskContext,
  reason: string,
  diagnosticReason?: CompletionGateReason,
): TaskAssessment {
  return {
    ...(diagnosticReason ? { diagnosticReason } : {}),
    mode: CompletionMode.TASK,
    status: TaskOutcomeStatus.UNVERIFIED,
    required: task.goal?.criteria.length ?? 0,
    supported: 0,
    missingCriteria: [reason],
    needsRecovery: task.canVerify(),
    limitation: null,
  };
}

/** Consistency and provenance only. The model interprets the requested result. */
export function assessVerificationOutput(
  task: TaskContext,
  output: unknown,
): { assessment: TaskAssessment; evidenceIds: readonly string[] } {
  const parsed = TaskVerificationSchema.safeParse(output);
  const goal = task.goal;
  const reject = (reason: string, diagnosticReason: CompletionGateReason) => ({
    assessment: createUnverifiedAssessment(task, reason, diagnosticReason),
    evidenceIds: [],
  });
  if (!parsed.success || !goal || task.evidence.readSnapshot().inFlight !== 0) {
    return reject(
      'Verification returned no valid settled verdict.',
      !parsed.success
        ? CompletionGateReason.VERDICT_SCHEMA_INVALID
        : !goal
          ? CompletionGateReason.GOAL_REQUIRED
          : CompletionGateReason.TOOLS_PENDING,
    );
  }
  const verdict = parsed.data;
  const coversGoal =
    verdict.criteria.length === goal.criteria.length &&
    goal.criteria.every(
      (criterion) =>
        verdict.criteria.filter((claim) => claim.criterionId === criterion.id).length === 1,
    );
  const evidenceIds = [...new Set(verdict.criteria.flatMap((claim) => claim.evidenceIds))];
  if (
    !coversGoal ||
    evidenceIds.some((id) => !task.evidence.hasAdmissibleEvidence(id)) ||
    verdict.criteria.some(
      (claim) => claim.state === CriterionState.SATISFIED && claim.evidenceIds.length === 0,
    )
  ) {
    return reject(
      'Cover every goal criterion and cite genuine, usable, fresh observations for each satisfied result.',
      !coversGoal
        ? CompletionGateReason.CRITERION_COVERAGE
        : evidenceIds.some((id) => !task.evidence.hasAdmissibleEvidence(id))
          ? CompletionGateReason.EVIDENCE_INVALID
          : CompletionGateReason.EVIDENCE_MISSING,
    );
  }
  const hasMissing = verdict.missingRequirements.length > 0;
  const hasUnsatisfied = verdict.criteria.some(
    (claim) => claim.state === CriterionState.UNSATISFIED,
  );
  const hasUnknown = verdict.criteria.some((claim) => claim.state === CriterionState.UNKNOWN);
  const consistent =
    verdict.decision === VerificationDecision.CONFIRMED
      ? !hasMissing && !hasUnsatisfied && !hasUnknown
      : verdict.decision === VerificationDecision.NEEDS_WORK
        ? hasUnsatisfied || hasMissing
        : verdict.decision === VerificationDecision.BLOCKED
          ? hasUnsatisfied || hasUnknown || hasMissing
          : hasUnknown || hasMissing;
  if (!consistent) {
    return reject(
      'The decision must agree with the criterion states and missing original requirements.',
      CompletionGateReason.DECISION_INCONSISTENT,
    );
  }
  const supportedCriteria = verdict.criteria.filter(
    (claim) => claim.state === CriterionState.SATISFIED,
  );
  const incompleteScope =
    supportedCriteria.length === goal.criteria.length &&
    verdict.decision !== VerificationDecision.CONFIRMED;
  const supported = incompleteScope ? 0 : supportedCriteria.length;
  const succeeded = verdict.decision === VerificationDecision.CONFIRMED;
  const blocked = verdict.decision === VerificationDecision.BLOCKED;
  const status = succeeded
    ? TaskOutcomeStatus.SUCCEEDED
    : incompleteScope
      ? TaskOutcomeStatus.UNVERIFIED
      : supported > 0
        ? TaskOutcomeStatus.PARTIAL
        : blocked
          ? TaskOutcomeStatus.BLOCKED
          : TaskOutcomeStatus.UNVERIFIED;
  return {
    evidenceIds,
    assessment: {
      mode: CompletionMode.TASK,
      status,
      required: goal.criteria.length,
      supported,
      missingCriteria: [
        ...verdict.criteria
          .filter((claim) => claim.state !== CriterionState.SATISFIED)
          .map((claim) => claim.criterionId + ': ' + claim.explanation),
        ...verdict.missingRequirements,
      ],
      needsRecovery: !succeeded && !blocked && task.canVerify(),
      limitation: succeeded ? null : verdict.summary,
    },
  };
}

/** No model calls. Recheck cited captures after the actor's final-answer turn. */
export function readCompletionAssessment(
  task: TaskContext,
  proposal: CompletionProposal | null,
): TaskAssessment {
  task.assertActive();
  const evidence = task.evidence.readSnapshot();
  if (
    proposal?.mode === CompletionMode.RESPONSE &&
    proposal.verificationId === null &&
    task.goal === null &&
    !task.hasUsedDesktopTools &&
    evidence.inFlight === 0
  ) {
    return {
      mode: CompletionMode.RESPONSE,
      status: TaskOutcomeStatus.SUCCEEDED,
      required: 0,
      supported: 0,
      missingCriteria: [],
      needsRecovery: false,
      limitation: null,
    };
  }
  const verification = task.latestVerification;
  if (
    proposal?.mode !== CompletionMode.TASK ||
    !verification ||
    verification.taskId !== task.id ||
    proposal.verificationId !== verification.id ||
    verification.revision !== evidence.revision ||
    evidence.inFlight !== 0 ||
    task.isVerifying ||
    verification.evidenceIds.some((id) => !task.evidence.hasAdmissibleEvidence(id))
  ) {
    task.invalidateVerification();
    return createUnverifiedAssessment(
      task,
      task.goal === null
        ? 'Desktop tools were used. Define a faithful task goal, then explicitly call verify_task before final output.'
        : 'Call verify_task when ready and reference its current verificationId. Cited observations must still be fresh and not superseded.',
      task.goal === null && task.hasUsedDesktopTools
        ? CompletionGateReason.DESKTOP_USE_WITHOUT_GOAL
        : !proposal
          ? CompletionGateReason.PROPOSAL_MISSING
          : proposal.mode !== CompletionMode.TASK
            ? CompletionGateReason.TASK_MODE_REQUIRED
            : !verification
              ? CompletionGateReason.VERIFICATION_REQUIRED
              : verification.taskId !== task.id
                ? CompletionGateReason.WRONG_TASK
                : proposal.verificationId !== verification.id
                  ? CompletionGateReason.WRONG_ID
                  : verification.revision !== evidence.revision
                    ? CompletionGateReason.REVISION_CHANGED
                    : evidence.inFlight !== 0
                      ? CompletionGateReason.TOOLS_PENDING
                      : task.isVerifying
                        ? CompletionGateReason.VERIFIER_ACTIVE
                        : CompletionGateReason.EVIDENCE_STALE,
    );
  }
  return { ...verification, needsRecovery: verification.needsRecovery && task.canVerify() };
}
