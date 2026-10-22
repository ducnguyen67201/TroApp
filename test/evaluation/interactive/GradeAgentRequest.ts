import { AgentTaskMode, TeachingOutcome } from '../../../src/contracts/CursorCompanion.js';
import {
  TeachingObservationKind,
  TeachingObservationSchema,
  type TeachingObservation,
} from '../../../src/contracts/TeachingObservation.js';
import { CompletionMode, TaskOutcomeStatus } from '../../../src/contracts/TaskOutcome.js';
import {
  InteractiveTrialStatus,
  type InteractiveAgentSummary,
  type InteractiveTrialResult,
} from './InteractiveEvaluationReport.js';
import {
  formatEvaluationUsage,
  summarizeEvaluationUsage,
  type EvaluationPriceCard,
  type EvaluationUsageSummary,
} from '../accounting/EvaluationUsage.js';

export const ChecklistStatus = {
  PASS: 'pass',
  FAIL: 'fail',
  UNASSESSED: 'unassessed',
} as const;

export type ChecklistStatus = (typeof ChecklistStatus)[keyof typeof ChecklistStatus];

export const CheckId = {
  AGENT_PIPELINE: 'A',
  GUIDANCE_PUBLISHED: 'B',
  STUDENT_CONTROL: 'C',
  APP_OUTCOME: 'D',
  COMPLETION_CLAIM: 'E',
  STEP_ASSESSMENTS: 'F',
  TRACE_COVERAGE: 'G',
  VISIBLE_CUE: 'H',
  INSTRUCTION_CLARITY: 'I',
  STUDENT_UNDERSTANDING: 'J',
} as const;

export type CheckId = (typeof CheckId)[keyof typeof CheckId];

export interface AgentRequestCheck {
  id: CheckId;
  title: string;
  status: ChecklistStatus;
  reason: string;
  evidenceIds: string[];
}

export interface AgentRequestEvaluationInput {
  trial: InteractiveTrialResult | null;
  taskMode: AgentTaskMode;
  observations: readonly unknown[];
  traceComplete: boolean;
  /** A custom request needs its own independent outcome predicate. */
  hasApplicableOutcome?: boolean;
  /** False when an app adapter cannot interpret the observed program/state. */
  supportsObservedOutcome?: boolean;
  /** Null when a final, correctly identified app state was not independently read.
   * This state predicate excludes the separate trusted-interaction requirement. */
  observedOutcomeMatches: boolean | null;
  pricing?: EvaluationPriceCard;
}

export interface AgentRequestUsage {
  gatewayRequests: number | null;
  requestsWithUnknownUsage: number | null;
  inputTokensObserved: number | null;
  cachedInputTokensObserved: number | null;
  outputTokensObserved: number | null;
  providerAttemptAccountingComplete: false;
  costMeasured: false;
  accounting: EvaluationUsageSummary;
}

export interface AgentRequestChecklist {
  schemaVersion: 1;
  trialId: string | null;
  checks: AgentRequestCheck[];
  coverage: {
    complete: boolean;
    declaredComplete: boolean;
    observationsValid: number;
    observationsRejected: number;
    observationsOrdered: boolean;
    teachingTraceEnded: boolean;
    teachingEventsAttempted: number | null;
    teachingEventsFailed: number | null;
  };
  usage: AgentRequestUsage;
}

interface ObservationReadback {
  observations: TeachingObservation[];
  rejected: number;
  ordered: boolean;
}

function readTeachingObservations(inputs: readonly unknown[]): ObservationReadback {
  const observations: TeachingObservation[] = [];
  let rejected = 0;
  let ordered = true;
  let previousElapsedMs = 0;
  for (const input of inputs) {
    const parsed = TeachingObservationSchema.safeParse(input);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    const observation = parsed.data;
    if (
      observation.sequence !== observations.length + 1 ||
      observation.elapsedMs < previousElapsedMs
    ) {
      ordered = false;
    }
    previousElapsedMs = observation.elapsedMs;
    observations.push(observation);
  }
  return { observations, rejected, ordered };
}

function createCheck(
  id: CheckId,
  title: string,
  status: ChecklistStatus,
  reason: string,
  evidenceIds: string[] = [],
): AgentRequestCheck {
  return { id, title, status, reason, evidenceIds };
}

function readMatchingAgent(trial: InteractiveTrialResult | null): InteractiveAgentSummary | null {
  return trial?.agent?.trialId === trial?.trialId ? (trial?.agent ?? null) : null;
}

function gradeAgentPipeline(
  trial: InteractiveTrialResult | null,
  agent: InteractiveAgentSummary | null,
  coverageComplete: boolean,
): AgentRequestCheck {
  const id = CheckId.AGENT_PIPELINE;
  const title = 'Real agent request settled';
  if (!trial) {
    return createCheck(id, title, ChecklistStatus.UNASSESSED, 'No live agent trial was recorded.');
  }
  if (trial.status !== InteractiveTrialStatus.SETTLED) {
    return createCheck(
      id,
      title,
      ChecklistStatus.FAIL,
      `The agent trial ended with status ${trial.status}; changed app state cannot complete the run.`,
      [trial.trialId],
    );
  }
  if (!agent) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'Matching agent result and request accounting are missing.',
      [trial.trialId],
    );
  }
  const settledSuccessfully =
    !agent.failed &&
    (agent.resultKind === 'completed' || agent.resultKind === 'teaching') &&
    agent.teachingOutcome !== TeachingOutcome.CANCELED &&
    agent.teachingOutcome !== TeachingOutcome.FAILED;
  if (!settledSuccessfully) {
    return createCheck(
      id,
      title,
      ChecklistStatus.FAIL,
      'The recorded result is failed, canceled, missing, or not a terminal agent response.',
      [trial.trialId],
    );
  }
  if (agent.modelRequests.length === 0) {
    return createCheck(
      id,
      title,
      coverageComplete ? ChecklistStatus.FAIL : ChecklistStatus.UNASSESSED,
      'No real model gateway request was observed.',
      [trial.trialId],
    );
  }
  return createCheck(
    id,
    title,
    ChecklistStatus.PASS,
    'The production agent settled and model gateway requests were recorded.',
    agent.modelRequests.map((request) => request.id),
  );
}

function formatPresentationIdentity(
  observation: Extract<
    TeachingObservation,
    { kind: typeof TeachingObservationKind.CUE_ACKNOWLEDGED }
  >,
): string {
  return `${observation.lessonId}:${observation.stepId}:${observation.presentationId}`;
}

function findPublishedGuidance(observations: TeachingObservation[]): string[] {
  const acknowledgments = new Map<
    string,
    Extract<TeachingObservation, { kind: typeof TeachingObservationKind.CUE_ACKNOWLEDGED }>
  >();
  const publishedEvidence: string[] = [];
  for (const observation of observations) {
    if (observation.kind === TeachingObservationKind.CUE_ACKNOWLEDGED) {
      const identity = formatPresentationIdentity(observation);
      const receipt = observation.receipt;
      if (
        !receipt.interrupted &&
        receipt.lessonId === observation.lessonId &&
        receipt.stepId === observation.stepId &&
        receipt.presentationId === observation.presentationId
      ) {
        acknowledgments.set(identity, observation);
      } else {
        acknowledgments.delete(identity);
      }
      continue;
    }
    if (
      observation.kind === TeachingObservationKind.CUE_REVOKED ||
      observation.kind === TeachingObservationKind.CUE_SUPERSEDED ||
      observation.kind === TeachingObservationKind.CUE_REQUESTED
    ) {
      acknowledgments.delete(
        `${observation.lessonId}:${observation.stepId}:${observation.presentationId}`,
      );
      continue;
    }
    if (observation.kind !== TeachingObservationKind.CUE_PUBLISHED) {
      continue;
    }
    const identity = `${observation.lessonId}:${observation.stepId}:${observation.presentationId}`;
    const acknowledgment = acknowledgments.get(identity);
    if (
      acknowledgment &&
      acknowledgment.sequence < observation.sequence &&
      acknowledgment.elapsedMs <= observation.elapsedMs &&
      observation.message.lessonId === observation.lessonId &&
      observation.message.stepId === observation.stepId
    ) {
      publishedEvidence.push(
        `teaching:${String(acknowledgment.sequence)}`,
        `teaching:${String(observation.sequence)}`,
      );
    }
  }
  return [...new Set(publishedEvidence)];
}

function gradePublishedGuidance(
  taskMode: AgentTaskMode,
  observations: TeachingObservation[],
  coverageComplete: boolean,
): AgentRequestCheck {
  const id = CheckId.GUIDANCE_PUBLISHED;
  const title = 'Teaching guidance was published';
  if (taskMode !== AgentTaskMode.TEACH) {
    return createCheck(id, title, ChecklistStatus.UNASSESSED, 'This is an execute-mode request.');
  }
  const evidenceIds = findPublishedGuidance(observations);
  if (evidenceIds.length > 0) {
    return createCheck(
      id,
      title,
      ChecklistStatus.PASS,
      'A published message matched an earlier, non-interrupted native acknowledgment. This does not verify visible pixels or instruction quality.',
      evidenceIds,
    );
  }
  return createCheck(
    id,
    title,
    coverageComplete ? ChecklistStatus.FAIL : ChecklistStatus.UNASSESSED,
    'No published message with a matching, non-interrupted acknowledgment was recorded. Installation alone is insufficient.',
  );
}

function gradeStudentControl(
  taskMode: AgentTaskMode,
  agent: InteractiveAgentSummary | null,
  coverageComplete: boolean,
): AgentRequestCheck {
  const id = CheckId.STUDENT_CONTROL;
  const title = 'Student retained control';
  if (taskMode !== AgentTaskMode.TEACH) {
    return createCheck(id, title, ChecklistStatus.UNASSESSED, 'This is an execute-mode request.');
  }
  if (!agent || agent.studentInputCalls === null) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'Agent student-input/edit-call accounting is missing.',
    );
  }
  if (agent.studentInputCalls > 0) {
    return createCheck(
      id,
      title,
      ChecklistStatus.FAIL,
      `${String(agent.studentInputCalls)} agent input or edit calls were recorded during teaching.`,
      [agent.trialId],
    );
  }
  return createCheck(
    id,
    title,
    coverageComplete ? ChecklistStatus.PASS : ChecklistStatus.UNASSESSED,
    coverageComplete
      ? 'Complete call accounting recorded zero agent input or edit calls; permitted window focus and guidance calls are excluded.'
      : 'Zero agent input or edit calls were recorded, but incomplete coverage cannot prove absence.',
    [agent.trialId],
  );
}

function gradeAppOutcome(input: AgentRequestEvaluationInput): AgentRequestCheck {
  const id = CheckId.APP_OUTCOME;
  const title = 'Requested app outcome was independently verified';
  if (input.hasApplicableOutcome === false) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'The authored fixture predicate is not mapped to this custom request. Fixture state diagnostics do not grade its requested outcome.',
    );
  }
  if (input.supportsObservedOutcome === false) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      "The observed application state or exported program is unavailable or outside the independent grader's supported scope.",
    );
  }
  if (!input.trial || input.observedOutcomeMatches === null) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'No final, correctly identified app-state observation is available.',
    );
  }
  return createCheck(
    id,
    title,
    input.trial.outcomePassed ? ChecklistStatus.PASS : ChecklistStatus.FAIL,
    input.trial.outcomePassed
      ? 'The independent application outcome checks passed. See the recorded state and application-specific evidence.'
      : `The independent outcome check did not pass: ${input.trial.reasons.join(', ') || 'required evidence missing'}.`,
    [input.trial.trialId],
  );
}

function gradeCompletionClaim(
  input: AgentRequestEvaluationInput,
  agent: InteractiveAgentSummary | null,
  coverageComplete: boolean,
): AgentRequestCheck {
  const id = CheckId.COMPLETION_CLAIM;
  const title = 'Completion claim agrees with app state';
  if (input.hasApplicableOutcome === false) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'The authored fixture predicate is not mapped to this custom request; completion needs an applicable independent outcome predicate.',
    );
  }
  if (input.supportsObservedOutcome === false) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'The observed application state or exported program is unavailable or unsupported, so the completion claim cannot be independently checked.',
    );
  }
  const claimedCompletion =
    (agent?.resultKind === 'completed' &&
      agent.completionMode === CompletionMode.TASK &&
      agent.taskOutcomeStatus === TaskOutcomeStatus.SUCCEEDED) ||
    (agent?.resultKind === 'teaching' && agent.teachingOutcome === TeachingOutcome.GOAL_REACHED);
  if (!claimedCompletion) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'No structured task-success or teaching-goal-reached claim was recorded. Free text is not interpreted as a success claim.',
    );
  }
  if (input.observedOutcomeMatches === null || !coverageComplete) {
    return createCheck(
      id,
      title,
      ChecklistStatus.UNASSESSED,
      'The completion claim lacks complete, independent app-state coverage for comparison.',
    );
  }
  return createCheck(
    id,
    title,
    input.observedOutcomeMatches ? ChecklistStatus.PASS : ChecklistStatus.FAIL,
    input.observedOutcomeMatches
      ? 'The independent final app state supports the structured completion claim.'
      : 'The agent claimed completion, but the independently observed final app state does not meet the requested outcome.',
    input.trial ? [input.trial.trialId] : [],
  );
}

function summarizeUsage(
  agent: InteractiveAgentSummary | null,
  pricing?: EvaluationPriceCard,
): AgentRequestUsage {
  const accounting = summarizeEvaluationUsage(agent?.modelRequests ?? null, pricing);
  return {
    gatewayRequests: accounting.gatewayCalls,
    requestsWithUnknownUsage: accounting.requestsWithUnknownUsage,
    inputTokensObserved: accounting.inputTokensObserved,
    cachedInputTokensObserved: accounting.cachedInputTokensObserved,
    outputTokensObserved: accounting.outputTokensObserved,
    providerAttemptAccountingComplete: false,
    costMeasured: false,
    accounting,
  };
}

/** Grades recorded facts after a request. Agent self-assessments never establish
 * app success, cue visibility, instruction clarity, or student understanding. */
export function gradeAgentRequest(input: AgentRequestEvaluationInput): AgentRequestChecklist {
  const readback = readTeachingObservations(input.observations);
  const lastObservation = readback.observations.at(-1);
  const teachingTraceEnding =
    lastObservation?.kind === TeachingObservationKind.TRACE_ENDED ? lastObservation : null;
  const requiresTeachingEnding =
    input.taskMode === AgentTaskMode.TEACH || readback.observations.length > 0;
  const hasCompleteTeachingEnding =
    !requiresTeachingEnding ||
    (teachingTraceEnding !== null &&
      teachingTraceEnding.failedEvents === 0 &&
      teachingTraceEnding.attemptedEvents === readback.observations.length - 1 &&
      teachingTraceEnding.sequence === teachingTraceEnding.attemptedEvents + 1 &&
      readback.observations
        .slice(0, -1)
        .every((observation) => observation.kind !== TeachingObservationKind.TRACE_ENDED));
  const coverageComplete =
    input.trial !== null &&
    input.traceComplete &&
    readback.rejected === 0 &&
    readback.ordered &&
    hasCompleteTeachingEnding;
  const agent = readMatchingAgent(input.trial);
  const assessmentEvidence = readback.observations
    .filter((observation) => observation.kind === TeachingObservationKind.ASSESSMENT)
    .map((observation) => `teaching:${String(observation.sequence)}`);
  return {
    schemaVersion: 1,
    trialId: input.trial?.trialId ?? null,
    checks: [
      gradeAgentPipeline(input.trial, agent, coverageComplete),
      gradePublishedGuidance(input.taskMode, readback.observations, coverageComplete),
      gradeStudentControl(input.taskMode, agent, coverageComplete),
      gradeAppOutcome(input),
      gradeCompletionClaim(input, agent, coverageComplete),
      createCheck(
        CheckId.STEP_ASSESSMENTS,
        'Step assessments agree with app state',
        ChecklistStatus.UNASSESSED,
        "Step-specific app predicates and time-aligned independent observations are required; the agent's own assessment is not an independent grade.",
        assessmentEvidence,
      ),
      createCheck(
        CheckId.TRACE_COVERAGE,
        'Trace coverage is complete',
        input.trial
          ? coverageComplete
            ? ChecklistStatus.PASS
            : ChecklistStatus.FAIL
          : ChecklistStatus.UNASSESSED,
        !input.trial
          ? 'No live trial trace is available.'
          : coverageComplete
            ? 'The worker declared completion; teaching observations are valid, contiguous, ordered, and end with matching zero-loss counts when teaching was observed.'
            : 'The trace is incomplete, invalid, unordered, or missing a terminal teaching marker with matching zero-loss counts. Missing events cannot prove absence.',
      ),
      createCheck(
        CheckId.VISIBLE_CUE,
        'Cue pixels were visible on screen',
        ChecklistStatus.UNASSESSED,
        'Host acknowledgment and message publication do not independently verify composited display pixels.',
      ),
      createCheck(
        CheckId.INSTRUCTION_CLARITY,
        'A child can follow each instruction',
        ChecklistStatus.UNASSESSED,
        'No independent teacher review or child usability observation was supplied.',
      ),
      createCheck(
        CheckId.STUDENT_UNDERSTANDING,
        'The student understands the step',
        ChecklistStatus.UNASSESSED,
        'No independent prediction, explanation, or transfer probe was administered. Task completion alone does not measure learning.',
      ),
    ],
    coverage: {
      complete: coverageComplete,
      declaredComplete: input.traceComplete,
      observationsValid: readback.observations.length,
      observationsRejected: readback.rejected,
      observationsOrdered: readback.ordered,
      teachingTraceEnded: teachingTraceEnding !== null,
      teachingEventsAttempted: teachingTraceEnding?.attemptedEvents ?? null,
      teachingEventsFailed: teachingTraceEnding?.failedEvents ?? null,
    },
    usage: summarizeUsage(agent, input.pricing),
  };
}

function formatMeasurement(value: number | null): string {
  return value === null ? 'unmeasured' : String(value);
}

/** Human-readable results preserve unassessed checks instead of treating them as passes. */
export function formatAgentRequestChecklist(checklist: AgentRequestChecklist): string {
  const lines = checklist.checks.map(
    (check) =>
      `Test ${check.id} [${check.status.toUpperCase()}] ${check.title}: ${check.reason}${check.evidenceIds.length > 0 ? ` Evidence: ${check.evidenceIds.join(', ')}.` : ''}`,
  );
  lines.push(
    '',
    `Observed gateway requests: ${formatMeasurement(checklist.usage.gatewayRequests)}. Requests with unknown usage: ${formatMeasurement(checklist.usage.requestsWithUnknownUsage)}.`,
    `Observed token subtotals — input: ${formatMeasurement(checklist.usage.inputTokensObserved)}, cached input: ${formatMeasurement(checklist.usage.cachedInputTokensObserved)}, output: ${formatMeasurement(checklist.usage.outputTokensObserved)}.`,
    formatEvaluationUsage(checklist.usage.accounting),
  );
  return lines.join('\n');
}
