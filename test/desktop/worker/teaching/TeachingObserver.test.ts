import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { TeachingOutcome } from '#contracts/CursorCompanion.js';
import { StudentActivityKind } from '#contracts/StudentActivity.js';
import {
  TeachingObservationKind,
  TeachingObservationSchema,
  type TeachingObservation,
  type TeachingObservationInput,
} from '#contracts/TeachingObservation.js';
import { TeachingAssessment, type TeachingMessage } from '#contracts/TeachingStep.js';
import { LoggedCuaServer } from '../../../../src/desktop/worker/cua/LoggedCuaServer.js';
import { CuaCompanionClient } from '../../../../src/desktop/worker/cua/CuaCompanionClient.js';
import type { DesktopObservationPort } from '../../../../src/desktop/worker/observation/DesktopObservationClient.js';
import { StudentInteractionTracker } from '../../../../src/desktop/worker/observation/StudentInteractionTracker.js';
import {
  TeachingObservationRecorder,
  type TeachingObserver,
} from '../../../../src/desktop/worker/teaching/TeachingObserver.js';
import { TeachingPresenter } from '../../../../src/desktop/worker/teaching/TeachingPresenter.js';
import { TeachingPresentationBudget } from '../../../../src/desktop/worker/teaching/TeachingPresentationBudget.js';
import { TeachingTaskRunner } from '../../../../src/desktop/worker/teaching/TeachingTaskRunner.js';
import { createLesson } from './TeachingTestFixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function createObservedPresenter(observe?: TeachingObserver) {
  const fixture = createLesson();
  const log = pino({ level: 'silent' });
  const server = new LoggedCuaServer(
    { name: 'Unused observation transport', command: 'unused' },
    log,
  );
  const publish = vi.fn<(message: TeachingMessage) => void>();
  const observations: TeachingObservation[] = [];
  const recorder = new TeachingObservationRecorder(
    observe ?? ((event) => observations.push(event)),
  );
  const presenter = new TeachingPresenter(
    fixture.lesson,
    server,
    new StudentInteractionTracker(),
    new TeachingPresentationBudget(),
    log,
    publish,
    () => {},
    () => {},
    () => {},
    recorder,
  );
  presenter.beginSegment();
  return { ...fixture, server, publish, observations, presenter, recorder };
}

function acknowledgePresentation(server: LoggedCuaServer, interrupted = false): void {
  vi.spyOn(server, 'showTeachingCue').mockImplementation(async (args, message) => {
    await Promise.resolve();
    return {
      content: [],
      structuredContent: {
        status: 'presented',
        following: true,
        active: false,
        receipt: {
          presentation_version: 3,
          task_epoch: randomUUID(),
          sequence_id: randomUUID(),
          presentation_id: args['presentation_id'],
          lesson_id: message?.lessonId,
          step_id: message?.stepId,
          message_presented: true,
          drawing_presented: true,
          text_only: false,
          interrupted,
          strokes_presented: [
            {
              stroke_index: 0,
              trace_progress: interrupted ? 0.5 : 1,
              hold_ms_observed: interrupted ? 0 : 1100,
            },
          ],
        },
      },
    };
  });
}

it('validates detached observations with monotonic task timing and sequence', () => {
  let time = 100;
  const events: TeachingObservation[] = [];
  const recorder = new TeachingObservationRecorder(
    (event) => events.push(event),
    () => time,
  );
  const lessonId = randomUUID();
  const input = {
    kind: TeachingObservationKind.CUE_REFUSED,
    stepId: null,
    presentationId: null,
    captureId: null,
    reason: 'fresh_observation_required',
  } satisfies TeachingObservationInput;
  time = 90;
  recorder.record(lessonId, input);
  time = 125;
  recorder.record(lessonId, input);
  expect(events.map(({ sequence, elapsedMs }) => ({ sequence, elapsedMs }))).toEqual([
    { sequence: 1, elapsedMs: 0 },
    { sequence: 2, elapsedMs: 25 },
  ]);
  expect(events.every((event) => TeachingObservationSchema.safeParse(event).success)).toBe(true);
  expect(
    TeachingObservationSchema.safeParse({ ...events[0], keyContents: 'private' }).success,
  ).toBe(false);
});

it('contains sink and validation failures without changing the task', () => {
  const lessonId = randomUUID();
  const observer = vi.fn<TeachingObserver>().mockImplementationOnce(() => {
    throw new Error('Trace sink unavailable');
  });
  const recorder = new TeachingObservationRecorder(observer);
  const input = {
    kind: TeachingObservationKind.CUE_REFUSED,
    stepId: null,
    presentationId: null,
    captureId: null,
    reason: 'fresh_observation_required',
  } satisfies TeachingObservationInput;
  expect(() => {
    recorder.record(lessonId, input);
  }).not.toThrow();
  recorder.record(lessonId, input);
  recorder.record('invalid-lesson-id', input);
  expect(observer).toHaveBeenCalledTimes(2);
  expect(observer.mock.calls[1]?.[0].sequence).toBe(2);
  expect(recorder.readStatus()).toEqual({ attemptedEvents: 3, failedEvents: 2 });
});

it('does no observation work when the optional sink is absent', () => {
  const readTime = vi.fn<() => number>().mockReturnValue(100);
  const recorder = new TeachingObservationRecorder(undefined, readTime);
  recorder.record(randomUUID(), {
    kind: TeachingObservationKind.CUE_REFUSED,
    stepId: null,
    presentationId: null,
    captureId: null,
    reason: 'fresh_observation_required',
  });
  recorder.finish(randomUUID());
  expect(readTime).toHaveBeenCalledOnce();
  expect(recorder.readStatus()).toEqual({ attemptedEvents: 0, failedEvents: 0 });
});

it('closes once with counts covering a failed final event and rejects later observations', () => {
  const events: TeachingObservation[] = [];
  const lessonId = randomUUID();
  const recorder = new TeachingObservationRecorder((event) => events.push(event));
  const input = {
    kind: TeachingObservationKind.CUE_REFUSED,
    stepId: null,
    presentationId: null,
    captureId: null,
    reason: 'fresh_observation_required',
  } satisfies TeachingObservationInput;
  recorder.record(lessonId, input);
  recorder.record('invalid-lesson-id', input);
  recorder.finish(lessonId);
  recorder.finish(lessonId);
  recorder.record(lessonId, input);
  expect(events.map((event) => event.kind)).toEqual([
    TeachingObservationKind.CUE_REFUSED,
    TeachingObservationKind.TRACE_ENDED,
  ]);
  expect(events[1]).toMatchObject({ sequence: 3, attemptedEvents: 2, failedEvents: 1 });
  expect(recorder.readStatus()).toEqual({ attemptedEvents: 3, failedEvents: 1 });
});

it('reports callback loss immediately before the terminal and contains terminal callback failure', () => {
  const events: TeachingObservation[] = [];
  const lessonId = randomUUID();
  const recorder = new TeachingObservationRecorder((event) => {
    if (event.kind !== TeachingObservationKind.TRACE_ENDED) {
      throw new Error('Last ordinary delivery failed');
    }
    events.push(event);
  });
  recorder.record(lessonId, {
    kind: TeachingObservationKind.CUE_REFUSED,
    stepId: null,
    presentationId: null,
    captureId: null,
    reason: 'fresh_observation_required',
  });
  recorder.finish(lessonId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: TeachingObservationKind.TRACE_ENDED,
    sequence: 2,
    attemptedEvents: 1,
    failedEvents: 1,
  });
  const failedTerminal = new TeachingObservationRecorder(() => {
    throw new Error('Terminal delivery failed');
  });
  expect(() => {
    failedTerminal.finish(lessonId);
  }).not.toThrow();
  expect(failedTerminal.readStatus()).toEqual({ attemptedEvents: 1, failedEvents: 1 });
});

it.each([false, true])(
  'ends the trace after teardown, even when teardown throws=%s',
  async (throws) => {
    const log = pino({ level: 'silent' });
    const server = new LoggedCuaServer(
      { name: 'Unused teardown transport', command: 'unused' },
      log,
    );
    const companion = new CuaCompanionClient(server);
    const order: string[] = [];
    const events: TeachingObservation[] = [];
    const observation: DesktopObservationPort = {
      begin: vi.fn<DesktopObservationPort['begin']>(),
      read: vi.fn<DesktopObservationPort['read']>(),
      recordCapture: vi.fn<DesktopObservationPort['recordCapture']>(),
      readBaseline: () => null,
      end: vi.fn<DesktopObservationPort['end']>().mockImplementation(async () => {
        await Promise.resolve();
        order.push('observation-ended');
      }),
    };
    vi.spyOn(companion, 'startFollowing').mockRejectedValue(new Error('Desktop unavailable'));
    vi.spyOn(server, 'endTeachingTask').mockImplementation(() => {
      order.push('native-task-ended');
      if (throws) {
        throw new Error('Native teardown failed');
      }
    });
    const runner = new TeachingTaskRunner(
      server,
      companion,
      log,
      undefined,
      observation,
      undefined,
      undefined,
      (event) => {
        order.push(event.kind);
        events.push(event);
      },
    );
    const result = runner.run(
      'Help debug this script.',
      DesktopLocale.ENGLISH,
      new AbortController().signal,
    );
    if (throws) {
      await expect(result).rejects.toThrow('Native teardown failed');
    } else {
      await expect(result).resolves.toMatchObject({ outcome: TeachingOutcome.FAILED });
    }
    expect(order).toEqual([
      'observation-ended',
      'native-task-ended',
      TeachingObservationKind.TRACE_ENDED,
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: TeachingObservationKind.TRACE_ENDED,
      attemptedEvents: 0,
      failedEvents: 0,
      sequence: 1,
    });
  },
);

it('streams every safe student attempt before the bounded model history evicts entries', () => {
  const events: TeachingObservation[] = [];
  const recorder = new TeachingObservationRecorder((event) => events.push(event));
  const lessonId = randomUUID();
  const stepId = randomUUID();
  const tracker = new StudentInteractionTracker((attempt) => {
    recorder.record(lessonId, { kind: TeachingObservationKind.STUDENT_ATTEMPT, attempt });
  });
  tracker.registerStep(stepId, { kind: 'keyboard' });
  for (let index = 0; index < 20; index += 1) {
    tracker.recordActivity({ kind: StudentActivityKind.KEY, point: null, button: null });
  }
  expect(tracker.readEvidence().attempts).toHaveLength(12);
  expect(events).toHaveLength(20);
  expect(events[0]).toMatchObject({
    kind: TeachingObservationKind.STUDENT_ATTEMPT,
    attempt: { stepId, sequence: 1, kind: 'key', sourceNear: null, destinationNear: null },
  });
  expect(events.every((event) => TeachingObservationSchema.safeParse(event).success)).toBe(true);
});

it('contains attempt callback failures and preserves input bookkeeping', () => {
  const tracker = new StudentInteractionTracker(() => {
    throw new Error('Observer failed');
  });
  expect(() => {
    tracker.recordActivity({ kind: StudentActivityKind.KEY, point: null, button: null });
  }).not.toThrow();
  expect(tracker.readEvidence().attemptCount).toBe(1);
});

it.each([false, true])(
  'distinguishes native acknowledgment from public publication when interrupted=%s',
  async (interrupted) => {
    const { presenter, proposal, server, observations, publish, lesson } =
      createObservedPresenter();
    acknowledgePresentation(server, interrupted);
    await presenter.presentStep(proposal, DesktopLocale.ENGLISH);
    expect(observations.map((event) => event.kind)).toEqual([
      TeachingObservationKind.CUE_REQUESTED,
      TeachingObservationKind.CUE_ACKNOWLEDGED,
      interrupted ? TeachingObservationKind.CUE_REVOKED : TeachingObservationKind.CUE_PUBLISHED,
    ]);
    const acknowledgment = observations.find(
      (event) => event.kind === TeachingObservationKind.CUE_ACKNOWLEDGED,
    );
    expect(acknowledgment).toMatchObject({
      lessonId: lesson.id,
      receipt: { interrupted },
    });
    expect(publish).toHaveBeenCalledTimes(interrupted ? 0 : 1);
    expect(observations.every((event) => TeachingObservationSchema.safeParse(event).success)).toBe(
      true,
    );
    expect(
      new Set(observations.map((event) => 'presentationId' in event && event.presentationId)).size,
    ).toBe(1);
  },
);

it('records refusals and revokes the same staged presentation without claiming publication', async () => {
  const { presenter, proposal, server, observations } = createObservedPresenter();
  vi.spyOn(server, 'showTeachingCue').mockResolvedValue({
    content: [],
    structuredContent: { code: 'drawing_rejected' },
  });
  expect(await presenter.presentStep(proposal, DesktopLocale.ENGLISH)).toMatchObject({
    admitted: false,
  });
  expect(observations.map((event) => event.kind)).toEqual([
    TeachingObservationKind.CUE_REQUESTED,
    TeachingObservationKind.CUE_REFUSED,
    TeachingObservationKind.CUE_REVOKED,
  ]);
  expect(observations[1]).toMatchObject({ reason: 'drawing_rejected' });
  expect(
    new Set(observations.map((event) => 'presentationId' in event && event.presentationId)).size,
  ).toBe(1);
});

it('records a superseded pending cue before a late native result without acknowledging it', async () => {
  const { presenter, proposal, server, observations } = createObservedPresenter();
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(server, 'showTeachingCue').mockImplementation(async () => {
    await pending;
    return { content: [], structuredContent: { code: 'late_result' } };
  });
  const result = presenter.presentStep(proposal, DesktopLocale.ENGLISH);
  presenter.endSegment();
  finish?.();
  expect(await result).toEqual({ admitted: false, reason: 'presentation_superseded' });
  expect(observations.map((event) => event.kind)).toEqual([
    TeachingObservationKind.CUE_REQUESTED,
    TeachingObservationKind.CUE_SUPERSEDED,
    TeachingObservationKind.CUE_REVOKED,
  ]);
});

it('attributes an assessment to the previous checkpoint before committing a new step', async () => {
  const { presenter, proposal, server, observations, lesson, capture } = createObservedPresenter();
  acknowledgePresentation(server);
  await presenter.presentStep(proposal, DesktopLocale.ENGLISH);
  const previousStepId = lesson.readCurrentStep()?.receipt.stepId;
  lesson.recordObservation(capture('next-capture'));
  await presenter.presentStep(
    {
      ...proposal,
      captureId: 'next-capture',
      previousStepAssessment: TeachingAssessment.REACHED,
      assessmentEvidence: 'The address bar is visibly focused.',
      instruction: 'Enter the site address.',
    },
    DesktopLocale.ENGLISH,
  );
  const assessment = observations.find(
    (event) => event.kind === TeachingObservationKind.ASSESSMENT,
  );
  expect(assessment).toMatchObject({
    stepId: previousStepId,
    proposedStepId: lesson.readCurrentStep()?.receipt.stepId,
    captureId: 'next-capture',
  });
  if (!assessment) {
    throw new Error('Assessment observation missing');
  }
  expect(assessment.proposedStepId).not.toBe(assessment.stepId);
});

it('preserves real presentation when the trace sink throws', async () => {
  const { presenter, proposal, server, publish, recorder } = createObservedPresenter(() => {
    throw new Error('Trace sink unavailable');
  });
  acknowledgePresentation(server);
  expect(await presenter.presentStep(proposal, DesktopLocale.ENGLISH)).toMatchObject({
    admitted: true,
  });
  expect(publish).toHaveBeenCalledOnce();
  expect(recorder.readStatus()).toEqual({ attemptedEvents: 3, failedEvents: 3 });
});
