import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AgentTaskMode,
  GuidanceReason,
  TeachingOutcome,
} from '../../../src/contracts/CursorCompanion.js';
import {
  TeachingObservationKind,
  TeachingObservationSchema,
  type TeachingObservation,
} from '../../../src/contracts/TeachingObservation.js';
import { TeachingAssessment, TeachingMessageKind } from '../../../src/contracts/TeachingStep.js';
import { CompletionMode, TaskOutcomeStatus } from '../../../src/contracts/TaskOutcome.js';
import {
  CheckId,
  ChecklistStatus,
  formatAgentRequestChecklist,
  gradeAgentRequest,
  type AgentRequestCheck,
  type AgentRequestChecklist,
  type AgentRequestEvaluationInput,
} from './GradeAgentRequest.js';
import {
  InteractiveAgentMessageKind,
  type InteractiveAgentSettled,
} from './InteractiveAgentProtocol.js';
import { InteractiveVariant } from './InteractiveEvaluationConfig.js';
import {
  InteractiveTrialStatus,
  summarizeInteractiveAgent,
  type InteractiveAgentSummary,
  type InteractiveTrialResult,
} from './InteractiveEvaluationReport.js';
import { InteractiveTaskId } from './InteractiveStudyWorkspace.js';

type CueAcknowledgment = Extract<
  TeachingObservation,
  { kind: typeof TeachingObservationKind.CUE_ACKNOWLEDGED }
>;

type CuePublication = Extract<
  TeachingObservation,
  { kind: typeof TeachingObservationKind.CUE_PUBLISHED }
>;

const lessonId = randomUUID();
const stepId = randomUUID();
const presentationId = randomUUID();
const goalRevisionId = randomUUID();

function createAgentResult(
  trialId: string,
  result: InteractiveAgentSettled['result'] = {
    kind: 'completed',
    answer: 'PrivateModelAnswerMustNotAppear',
    completion: { kind: CompletionMode.RESPONSE },
  },
): InteractiveAgentSettled {
  return {
    kind: InteractiveAgentMessageKind.SETTLED,
    trialId,
    result,
    failed: false,
    durationMs: 900,
    contextPreparationMs: null,
    modelRequests: [
      {
        id: randomUUID(),
        status: 200,
        durationMs: 100,
        inputTokens: 200,
        cachedInputTokens: 30,
        outputTokens: 10,
      },
    ],
    toolCalls: 3,
    mutationCalls: 0,
    studentInputCalls: 0,
    outputCount: 0,
  };
}

function createTrial(overrides: Partial<InteractiveTrialResult> = {}): InteractiveTrialResult {
  const trialId = randomUUID();
  return {
    trialId,
    scenarioId: InteractiveTaskId.CLICK,
    variant: InteractiveVariant.OFF,
    repetition: 1,
    pairId: 'ClickRepeat1',
    startingStateId: 'AuthoredStartingState',
    status: InteractiveTrialStatus.SETTLED,
    outcomePassed: true,
    reasons: [],
    taskDurationMs: 1000,
    firstObservedInputMs: 300,
    firstVerifiedOutcomeMs: 600,
    cueAcknowledgedMs: null,
    cursorMoved: true,
    maximumCursorDistanceDip: 300,
    finalCursorDip: { x: 500, y: 400 },
    observedInput: {
      click: 1,
      pointerDown: 1,
      pointerMove: 1,
      pointerUp: 1,
      input: 0,
      keyDown: 0,
      wheel: 0,
      drag: 0,
    },
    events: [],
    geometry: {
      viewport: { width: 1120, height: 820, devicePixelRatio: 2 },
      targets: [
        { id: 'save-card', label: 'Save card', bounds: { x: 100, y: 100, width: 120, height: 40 } },
      ],
      lastPointerCss: { x: 150, y: 120 },
      windowContentDip: { x: 20, y: 40, width: 1120, height: 820 },
    },
    agent: summarizeInteractiveAgent(createAgentResult(trialId)),
    ...overrides,
  };
}

function readAgent(trial: InteractiveTrialResult): InteractiveAgentSummary {
  if (!trial.agent) {
    throw new Error('This test requires agent accounting.');
  }
  return trial.agent;
}

function createInput(
  overrides: Partial<AgentRequestEvaluationInput> = {},
  includeTeachingEnding = true,
): AgentRequestEvaluationInput {
  const trial = overrides.trial === undefined ? createTrial() : overrides.trial;
  const taskMode = overrides.taskMode ?? AgentTaskMode.TEACH;
  const observations = overrides.observations ?? [];
  return {
    traceComplete: true,
    observedOutcomeMatches: true,
    ...overrides,
    trial,
    taskMode,
    observations:
      trial && taskMode === AgentTaskMode.TEACH && includeTeachingEnding
        ? appendTeachingEnding(observations)
        : observations,
  };
}

function appendTeachingEnding(observations: readonly unknown[]): readonly unknown[] {
  const validObservations = observations.flatMap((observation) => {
    const parsed = TeachingObservationSchema.safeParse(observation);
    return parsed.success ? [parsed.data] : [];
  });
  const attemptedEvents = validObservations.reduce(
    (maximum, observation) => Math.max(maximum, observation.sequence),
    0,
  );
  const elapsedMs = validObservations.reduce(
    (maximum, observation) => Math.max(maximum, observation.elapsedMs),
    0,
  );
  return [
    ...observations,
    {
      sequence: attemptedEvents + 1,
      elapsedMs: elapsedMs + 1,
      lessonId,
      kind: TeachingObservationKind.TRACE_ENDED,
      attemptedEvents,
      failedEvents: 0,
    } satisfies TeachingObservation,
  ];
}

function readCheck(
  checklist: AgentRequestChecklist,
  id: AgentRequestCheck['id'],
): AgentRequestCheck {
  const check = checklist.checks.find((item) => item.id === id);
  if (!check) {
    throw new Error(`Missing check ${id}.`);
  }
  return check;
}

function createAcknowledgment(overrides: Partial<CueAcknowledgment> = {}): CueAcknowledgment {
  return {
    sequence: 1,
    elapsedMs: 100,
    lessonId,
    kind: TeachingObservationKind.CUE_ACKNOWLEDGED,
    stepId,
    presentationId,
    receipt: {
      lessonId,
      stepId,
      presentationId,
      goalRevisionId,
      captureId: 'capture-one',
      messagePresented: true,
      drawingPresented: true,
      textOnly: false,
      interrupted: false,
    },
    ...overrides,
  };
}

function createPublication(overrides: Partial<CuePublication> = {}): CuePublication {
  return {
    sequence: 2,
    elapsedMs: 150,
    lessonId,
    kind: TeachingObservationKind.CUE_PUBLISHED,
    stepId,
    presentationId,
    message: {
      lessonId,
      stepId,
      sequence: 1,
      kind: TeachingMessageKind.INSTRUCTION,
      text: 'PrivateTeachingInstructionMustNotAppear',
    },
    ...overrides,
  };
}

function createCompletedTask(trialId: string): InteractiveAgentSummary {
  return summarizeInteractiveAgent(
    createAgentResult(trialId, {
      kind: 'completed',
      answer: 'PrivateModelAnswerMustNotAppear',
      completion: {
        kind: CompletionMode.TASK,
        outcome: {
          status: TaskOutcomeStatus.SUCCEEDED,
          requiredCriteriaCount: 1,
          supportedCriteriaCount: 1,
          remainingCriteriaCount: 0,
          limitation: null,
        },
      },
    }),
  );
}

it('prints separate recorded checks without converting unknown learning or visibility into passes', () => {
  const checklist = gradeAgentRequest(
    createInput({ observations: [createAcknowledgment(), createPublication()] }),
  );
  expect(readCheck(checklist, CheckId.AGENT_PIPELINE).status).toBe(ChecklistStatus.PASS);
  expect(readCheck(checklist, CheckId.GUIDANCE_PUBLISHED)).toMatchObject({
    status: ChecklistStatus.PASS,
    evidenceIds: ['teaching:1', 'teaching:2'],
  });
  expect(readCheck(checklist, CheckId.APP_OUTCOME).status).toBe(ChecklistStatus.PASS);
  for (const id of [
    CheckId.VISIBLE_CUE,
    CheckId.INSTRUCTION_CLARITY,
    CheckId.STUDENT_UNDERSTANDING,
  ]) {
    expect(readCheck(checklist, id).status).toBe(ChecklistStatus.UNASSESSED);
  }
  const text = formatAgentRequestChecklist(checklist);
  expect(text).toContain('Test A [PASS]');
  expect(text).toContain('Test B [PASS]');
  expect(text).toContain('Test J [UNASSESSED]');
  expect(text).toContain('Estimated observed-call cost: unknown');
  expect(text).not.toContain('PrivateModel');
  expect(text).not.toContain('PrivateTeaching');
  expect(JSON.stringify(checklist)).not.toContain('Private');
});

it.each([
  InteractiveTrialStatus.TIMED_OUT,
  InteractiveTrialStatus.FAILED,
  InteractiveTrialStatus.CANCELLED,
])('does not pass the agent pipeline after %s even when app state changed', (status) => {
  const checklist = gradeAgentRequest(createInput({ trial: createTrial({ status }) }));
  expect(readCheck(checklist, CheckId.AGENT_PIPELINE).status).toBe(ChecklistStatus.FAIL);
  expect(readCheck(checklist, CheckId.APP_OUTCOME).status).toBe(ChecklistStatus.PASS);
});

it('requires real model request evidence and a terminal successful response', () => {
  const trial = createTrial();
  readAgent(trial).modelRequests = [];
  expect(readCheck(gradeAgentRequest(createInput({ trial })), CheckId.AGENT_PIPELINE).status).toBe(
    ChecklistStatus.FAIL,
  );
  expect(
    readCheck(
      gradeAgentRequest(createInput({ trial, traceComplete: false })),
      CheckId.AGENT_PIPELINE,
    ).status,
  ).toBe(ChecklistStatus.UNASSESSED);
  trial.agent = summarizeInteractiveAgent(
    createAgentResult(trial.trialId, { kind: 'failed', message: 'PrivateFailureMustNotAppear' }),
  );
  expect(readCheck(gradeAgentRequest(createInput({ trial })), CheckId.AGENT_PIPELINE).status).toBe(
    ChecklistStatus.FAIL,
  );
});

it('treats needs-input as a settled pipeline response without claiming goal success', () => {
  const trial = createTrial({ outcomePassed: false, reasons: ['outcome_mismatch:saved'] });
  trial.agent = summarizeInteractiveAgent(
    createAgentResult(trial.trialId, {
      kind: 'teaching',
      result: {
        outcome: TeachingOutcome.NEEDS_INPUT,
        reason: GuidanceReason.NO_DEMONSTRATION,
      },
    }),
  );
  const checklist = gradeAgentRequest(createInput({ trial, observedOutcomeMatches: false }));
  expect(readCheck(checklist, CheckId.AGENT_PIPELINE).status).toBe(ChecklistStatus.PASS);
  expect(readCheck(checklist, CheckId.APP_OUTCOME).status).toBe(ChecklistStatus.FAIL);
  expect(readCheck(checklist, CheckId.COMPLETION_CLAIM).status).toBe(ChecklistStatus.UNASSESSED);
});

it('requires publication as well as matching non-interrupted host acknowledgment', () => {
  const acknowledgment = createAcknowledgment();
  expect(
    readCheck(
      gradeAgentRequest(createInput({ observations: [acknowledgment] })),
      CheckId.GUIDANCE_PUBLISHED,
    ).status,
  ).toBe(ChecklistStatus.FAIL);
  const interrupted = {
    ...acknowledgment,
    receipt: { ...acknowledgment.receipt, interrupted: true },
  };
  expect(
    readCheck(
      gradeAgentRequest(createInput({ observations: [interrupted, createPublication()] })),
      CheckId.GUIDANCE_PUBLISHED,
    ).status,
  ).toBe(ChecklistStatus.FAIL);
  expect(
    readCheck(
      gradeAgentRequest(
        createInput({
          observations: [
            createAcknowledgment({ receipt: { ...acknowledgment.receipt, stepId: randomUUID() } }),
            createPublication(),
          ],
        }),
      ),
      CheckId.GUIDANCE_PUBLISHED,
    ).status,
  ).toBe(ChecklistStatus.FAIL);
});

it('does not match acknowledgment and publication from different presentation identities', () => {
  const checklist = gradeAgentRequest(
    createInput({
      observations: [createAcknowledgment(), createPublication({ presentationId: randomUUID() })],
    }),
  );
  expect(readCheck(checklist, CheckId.GUIDANCE_PUBLISHED).status).toBe(ChecklistStatus.FAIL);
});

it.each([TeachingObservationKind.CUE_REVOKED, TeachingObservationKind.CUE_SUPERSEDED])(
  'rejects publication after %s without erasing publication that already happened',
  (kind) => {
    const invalidation: TeachingObservation = {
      sequence: 2,
      elapsedMs: 120,
      lessonId,
      kind,
      stepId,
      presentationId,
      reason: 'Authoritative presentation changed.',
    };
    const invalidated = gradeAgentRequest(
      createInput({
        observations: [createAcknowledgment(), invalidation, createPublication({ sequence: 3 })],
      }),
    );
    expect(readCheck(invalidated, CheckId.GUIDANCE_PUBLISHED).status).toBe(ChecklistStatus.FAIL);
    const alreadyPublished = gradeAgentRequest(
      createInput({
        observations: [
          createAcknowledgment(),
          createPublication(),
          { ...invalidation, sequence: 3, elapsedMs: 200 },
        ],
      }),
    );
    expect(readCheck(alreadyPublished, CheckId.GUIDANCE_PUBLISHED).status).toBe(
      ChecklistStatus.PASS,
    );
  },
);

it('does not infer missing guidance or zero mutations from incomplete coverage', () => {
  const checklist = gradeAgentRequest(createInput({ traceComplete: false }));
  expect(readCheck(checklist, CheckId.GUIDANCE_PUBLISHED).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.STUDENT_CONTROL).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.TRACE_COVERAGE).status).toBe(ChecklistStatus.FAIL);
  const trial = createTrial();
  readAgent(trial).studentInputCalls = 1;
  expect(
    readCheck(
      gradeAgentRequest(createInput({ trial, traceComplete: false })),
      CheckId.STUDENT_CONTROL,
    ).status,
  ).toBe(ChecklistStatus.FAIL);
});

it('validates trace records and retains positive evidence when invalid records reduce coverage', () => {
  const checklist = gradeAgentRequest(
    createInput({
      observations: [createAcknowledgment(), { kind: 'unknown' }, createPublication()],
    }),
  );
  expect(checklist.coverage).toMatchObject({ complete: false, observationsRejected: 1 });
  expect(readCheck(checklist, CheckId.TRACE_COVERAGE).status).toBe(ChecklistStatus.FAIL);
  expect(readCheck(checklist, CheckId.GUIDANCE_PUBLISHED).status).toBe(ChecklistStatus.PASS);
  expect(readCheck(checklist, CheckId.STUDENT_CONTROL).status).toBe(ChecklistStatus.UNASSESSED);
});

it.each([createPublication({ sequence: 3 }), createPublication({ elapsedMs: 10 })])(
  'marks missing or unordered observation coverage incomplete',
  (publication) => {
    const checklist = gradeAgentRequest(
      createInput({ observations: [createAcknowledgment(), publication] }),
    );
    expect(checklist.coverage.observationsOrdered).toBe(false);
    expect(readCheck(checklist, CheckId.TRACE_COVERAGE).status).toBe(ChecklistStatus.FAIL);
  },
);

it('requires a terminal teaching marker even when every delivered event is valid and ordered', () => {
  const checklist = gradeAgentRequest(
    createInput({ observations: [createAcknowledgment(), createPublication()] }, false),
  );
  expect(checklist.coverage).toMatchObject({
    complete: false,
    observationsOrdered: true,
    teachingTraceEnded: false,
  });
  expect(readCheck(checklist, CheckId.GUIDANCE_PUBLISHED).status).toBe(ChecklistStatus.PASS);
  expect(readCheck(checklist, CheckId.STUDENT_CONTROL).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.TRACE_COVERAGE).status).toBe(ChecklistStatus.FAIL);
});

it.each([0, 1])(
  'uses terminal counts to expose lost teaching observations (%i failed at source)',
  (failedEvents) => {
    const checklist = gradeAgentRequest(
      createInput(
        {
          observations: [
            createAcknowledgment(),
            {
              sequence: 3,
              elapsedMs: 200,
              lessonId,
              kind: TeachingObservationKind.TRACE_ENDED,
              attemptedEvents: 2,
              failedEvents,
            } satisfies TeachingObservation,
          ],
        },
        false,
      ),
    );
    expect(checklist.coverage).toMatchObject({
      complete: false,
      teachingTraceEnded: true,
      teachingEventsAttempted: 2,
      teachingEventsFailed: failedEvents,
    });
    expect(readCheck(checklist, CheckId.GUIDANCE_PUBLISHED).status).toBe(
      ChecklistStatus.UNASSESSED,
    );
  },
);

it('rejects duplicate terminal markers and observations delivered after termination', () => {
  const ending = {
    sequence: 1,
    elapsedMs: 0,
    lessonId,
    kind: TeachingObservationKind.TRACE_ENDED,
    attemptedEvents: 0,
    failedEvents: 0,
  } satisfies TeachingObservation;
  const duplicate = gradeAgentRequest(
    createInput(
      {
        observations: [ending, { ...ending, sequence: 2, elapsedMs: 1, attemptedEvents: 1 }],
      },
      false,
    ),
  );
  expect(readCheck(duplicate, CheckId.TRACE_COVERAGE).status).toBe(ChecklistStatus.FAIL);
  const continued = gradeAgentRequest(
    createInput({ observations: [ending, createAcknowledgment({ sequence: 2 })] }, false),
  );
  expect(continued.coverage.observationsOrdered).toBe(true);
  expect(readCheck(continued, CheckId.TRACE_COVERAGE).status).toBe(ChecklistStatus.FAIL);
});

it('requires matching input/edit accounting and allows teaching focus mutations', () => {
  const trial = createTrial();
  readAgent(trial).mutationCalls = 1;
  expect(readCheck(gradeAgentRequest(createInput({ trial })), CheckId.STUDENT_CONTROL).status).toBe(
    ChecklistStatus.PASS,
  );
  readAgent(trial).trialId = randomUUID();
  const checklist = gradeAgentRequest(createInput({ trial }));
  expect(readCheck(checklist, CheckId.STUDENT_CONTROL).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.AGENT_PIPELINE).status).toBe(ChecklistStatus.UNASSESSED);
  expect(checklist.usage.gatewayRequests).toBeNull();
});

it('keeps student control unassessed when input/edit accounting is unknown', () => {
  const trial = createTrial();
  readAgent(trial).studentInputCalls = null;
  const checklist = gradeAgentRequest(createInput({ trial }));
  expect(readCheck(checklist, CheckId.STUDENT_CONTROL).status).toBe(ChecklistStatus.UNASSESSED);
});

it('does not apply teaching-control and publication checks to an execute-mode request', () => {
  const checklist = gradeAgentRequest(createInput({ taskMode: AgentTaskMode.EXECUTE }));
  expect(readCheck(checklist, CheckId.STUDENT_CONTROL).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.GUIDANCE_PUBLISHED).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.TRACE_COVERAGE).status).toBe(ChecklistStatus.PASS);
});

it.each([AgentTaskMode.EXECUTE, AgentTaskMode.TEACH])(
  'detects unsupported structured completion claims in %s mode',
  (taskMode) => {
    const trial = createTrial({ outcomePassed: false, reasons: ['outcome_mismatch:saved'] });
    trial.agent =
      taskMode === AgentTaskMode.EXECUTE
        ? createCompletedTask(trial.trialId)
        : summarizeInteractiveAgent(
            createAgentResult(trial.trialId, {
              kind: 'teaching',
              result: { outcome: TeachingOutcome.GOAL_REACHED, answer: 'PrivateAnswer' },
            }),
          );
    const checklist = gradeAgentRequest(
      createInput({ trial, taskMode, observedOutcomeMatches: false }),
    );
    expect(readCheck(checklist, CheckId.COMPLETION_CLAIM).status).toBe(ChecklistStatus.FAIL);
    expect(
      readCheck(
        gradeAgentRequest(
          createInput({ trial, taskMode, observedOutcomeMatches: false, traceComplete: false }),
        ),
        CheckId.COMPLETION_CLAIM,
      ).status,
    ).toBe(ChecklistStatus.UNASSESSED);
  },
);

it('keeps app-state success separate from required trusted target-interaction evidence', () => {
  const trial = createTrial({ outcomePassed: false, reasons: ['missing_trusted_click_evidence'] });
  trial.agent = createCompletedTask(trial.trialId);
  const checklist = gradeAgentRequest(createInput({ trial, observedOutcomeMatches: true }));
  expect(readCheck(checklist, CheckId.APP_OUTCOME).status).toBe(ChecklistStatus.FAIL);
  expect(readCheck(checklist, CheckId.COMPLETION_CLAIM).status).toBe(ChecklistStatus.PASS);
});

it('does not infer app outcomes or false completion from missing state readback', () => {
  const trial = createTrial();
  trial.agent = createCompletedTask(trial.trialId);
  const checklist = gradeAgentRequest(createInput({ trial, observedOutcomeMatches: null }));
  expect(readCheck(checklist, CheckId.APP_OUTCOME).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.COMPLETION_CLAIM).status).toBe(ChecklistStatus.UNASSESSED);
});

it('does not grade a custom request using an unrelated authored fixture predicate', () => {
  const trial = createTrial({ outcomePassed: false, reasons: ['outcome_mismatch:saved'] });
  trial.agent = createCompletedTask(trial.trialId);
  const checklist = gradeAgentRequest(
    createInput({ trial, observedOutcomeMatches: false, hasApplicableOutcome: false }),
  );
  const outcomeCheck = readCheck(checklist, CheckId.APP_OUTCOME);
  expect(outcomeCheck.status).toBe(ChecklistStatus.UNASSESSED);
  expect(outcomeCheck.reason).toContain('custom request');
  const completionCheck = readCheck(checklist, CheckId.COMPLETION_CLAIM);
  expect(completionCheck.status).toBe(ChecklistStatus.UNASSESSED);
  expect(completionCheck.reason).toContain('custom request');
});

it('reports unsupported app observations separately from a custom request mismatch', () => {
  const trial = createTrial();
  trial.agent = createCompletedTask(trial.trialId);
  const checklist = gradeAgentRequest(
    createInput({ trial, observedOutcomeMatches: null, supportsObservedOutcome: false }),
  );
  for (const id of [CheckId.APP_OUTCOME, CheckId.COMPLETION_CLAIM]) {
    const check = readCheck(checklist, id);
    expect(check.status).toBe(ChecklistStatus.UNASSESSED);
    expect(check.reason).toMatch(/unsupported|supported scope/);
    expect(check.reason).not.toContain('custom request');
  }
});

it('does not count response-only text or reached step assessments as an independently verified goal', () => {
  const checklist = gradeAgentRequest(
    createInput({
      observations: [
        {
          sequence: 1,
          elapsedMs: 100,
          lessonId,
          kind: TeachingObservationKind.ASSESSMENT,
          stepId,
          proposedStepId: randomUUID(),
          captureId: 'capture-one',
          goalRevisionId,
          assessment: TeachingAssessment.REACHED,
          evidence: 'PrivateSelfAssessmentMustNotAppear',
        } satisfies TeachingObservation,
      ],
    }),
  );
  expect(readCheck(checklist, CheckId.COMPLETION_CLAIM).status).toBe(ChecklistStatus.UNASSESSED);
  expect(readCheck(checklist, CheckId.STEP_ASSESSMENTS)).toMatchObject({
    status: ChecklistStatus.UNASSESSED,
    evidenceIds: ['teaching:1'],
  });
  expect(JSON.stringify(checklist)).not.toContain('Private');
});

it('reports observed usage subtotals and unknown requests without assuming a free or complete run', () => {
  const trial = createTrial();
  readAgent(trial).modelRequests.push({
    id: randomUUID(),
    status: 502,
    durationMs: 200,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
  });
  const checklist = gradeAgentRequest(createInput({ trial }));
  expect(checklist.usage).toMatchObject({
    gatewayRequests: 2,
    requestsWithUnknownUsage: 1,
    inputTokensObserved: 200,
    cachedInputTokensObserved: 30,
    outputTokensObserved: 10,
    providerAttemptAccountingComplete: false,
    costMeasured: false,
  });
  const absent = gradeAgentRequest(createInput({ trial: createTrial({ agent: null }) }));
  expect(absent.usage).toMatchObject({ gatewayRequests: null, inputTokensObserved: null });
  expect(formatAgentRequestChecklist(absent)).toContain('Observed gateway requests: unmeasured');
});

it('leaves preflight or aborted setup unassessed instead of producing passing live checks', () => {
  const checklist = gradeAgentRequest(
    createInput({ trial: null, observations: [], observedOutcomeMatches: null }),
  );
  expect(checklist.checks.every((check) => check.status === ChecklistStatus.UNASSESSED)).toBe(true);
  expect(checklist.coverage.complete).toBe(false);
  expect(checklist.usage.gatewayRequests).toBeNull();
});
