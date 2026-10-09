import type { PracticeRecord } from '#contracts/PracticeCheck.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';
import { createPracticeCheckpoint } from '../../../server/features/classroom/PracticeFixtures.js';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  CompanionHudController,
  CompanionHudTransitionSource,
  type CompanionHudPort,
  type CompanionHudTransition,
} from '../../../../src/desktop/main/companion/CompanionHudController.js';
import {
  AgentProgressPhase,
  CompanionHudPhase,
  type CompanionHudSnapshot,
} from '#contracts/CompanionHud.js';
import { GuidanceReason, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { TeachingMessageKind } from '#contracts/TeachingStep.js';
import { VoiceState, VoiceShortcut } from '#contracts/VoiceInput.js';
import { AgentFailureCode } from '#contracts/AgentSession.js';
const captureId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

function createHarness(reportTransition?: (transition: CompanionHudTransition) => void) {
  vi.useFakeTimers();
  const snapshots: CompanionHudSnapshot[] = [];
  const transitions: CompanionHudTransition[] = [];
  const port: CompanionHudPort = {
    showSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
  };
  const controller = new CompanionHudController(
    port,
    {
      now: () => Date.now(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => {
          clearTimeout(timer);
        };
      },
    },
    (transition) => {
      transitions.push(transition);
      reportTransition?.(transition);
    },
  );
  return { controller, snapshots, transitions, latest: () => snapshots.at(-1) };
}

afterEach(() => {
  vi.useRealTimers();
});

it('distinguishes voice failure from task failure without recording speech or task content', () => {
  const { controller, latest, transitions } = createHarness();
  controller.startTask(sessionId, 'en');
  controller.receiveVoiceEvent({ kind: 'failed' });
  expect(latest()?.phase).toBe(CompanionHudPhase.ERROR);
  expect(transitions.at(-1)).toEqual({
    previousPhase: CompanionHudPhase.SENDING,
    nextPhase: CompanionHudPhase.ERROR,
    source: CompanionHudTransitionSource.VOICE_EVENT,
    voiceEventKind: 'failed',
    sessionId,
    captureId: null,
    lessonId: null,
  });

  controller.receiveVoiceEvent({ kind: 'prepare', captureId });
  controller.receiveVoiceEvent({
    kind: 'submitted',
    captureId,
    sessionId,
    text: 'private spoken transcript',
  });
  controller.receiveVoiceEvent({
    kind: 'result',
    captureId,
    sessionId,
    result: { kind: 'failed', message: 'private task failure message' },
  });
  expect(transitions.at(-1)).toEqual({
    previousPhase: CompanionHudPhase.SENDING,
    nextPhase: CompanionHudPhase.ERROR,
    source: CompanionHudTransitionSource.VOICE_EVENT,
    voiceEventKind: 'result',
    resultKind: 'failed',
    sessionId,
    captureId,
    lessonId: null,
  });
  expect(JSON.stringify(transitions)).not.toContain('private');
});

it('records waiting, pause and teaching failure causes while keeping meters and repeated phases quiet', () => {
  const { controller, transitions } = createHarness();
  controller.receiveVoiceEvent({ kind: 'prepare', captureId });
  controller.updateMeter({ captureId, sequence: 0, level: 0.2 });
  vi.advanceTimersByTime(50);
  controller.updateMeter({ captureId, sequence: 1, level: 0.8 });
  vi.advanceTimersByTime(50);
  controller.updateMeter({ captureId, sequence: 2, level: 0.4 });
  expect(
    transitions.filter(
      (transition) => transition.source === CompanionHudTransitionSource.VOICE_METER,
    ),
  ).toHaveLength(1);

  controller.receiveVoiceEvent({
    kind: 'submitted',
    captureId,
    sessionId,
    text: 'private voice request',
  });
  const progress = {
    kind: 'progress' as const,
    requestId: captureId,
    sessionId,
    phase: 'waiting' as const,
    lessonId: captureId,
    teachingMessage: {
      lessonId: captureId,
      stepId: sessionId,
      sequence: 1,
      kind: 'instruction' as const,
      text: 'private teaching instruction',
    },
  };
  controller.receiveProgress(progress);
  const waiting = transitions.at(-1);
  expect(waiting).toMatchObject({
    previousPhase: CompanionHudPhase.SENDING,
    nextPhase: CompanionHudPhase.WAITING,
    source: CompanionHudTransitionSource.AGENT_PROGRESS,
    progressPhase: 'waiting',
    sessionId,
    captureId,
    lessonId: captureId,
  });
  controller.receiveProgress(progress);
  expect(transitions.at(-1)).toBe(waiting);
  controller.receiveProgress({ ...progress, phase: 'paused' });
  expect(transitions.at(-1)).toMatchObject({
    previousPhase: CompanionHudPhase.WAITING,
    nextPhase: CompanionHudPhase.NEEDS_INPUT,
    source: CompanionHudTransitionSource.AGENT_PROGRESS,
    progressPhase: 'paused',
  });
  controller.finishTask(
    { kind: 'teaching', result: { outcome: 'failed', reason: 'render_timeout' } },
    sessionId,
  );
  expect(transitions.at(-1)).toMatchObject({
    previousPhase: CompanionHudPhase.NEEDS_INPUT,
    nextPhase: CompanionHudPhase.ERROR,
    source: CompanionHudTransitionSource.AGENT_RESULT,
    resultKind: 'teaching',
    teachingOutcome: 'failed',
    teachingReason: 'render_timeout',
    sessionId,
    captureId,
    lessonId: captureId,
  });
  expect(JSON.stringify(transitions)).not.toContain('private');
});

it('keeps rendering and terminal cleanup when transition reporting fails', () => {
  const { controller, latest, transitions } = createHarness(() => {
    throw new Error('diagnostic sink unavailable');
  });
  expect(() => {
    controller.receiveVoiceEvent({ kind: 'prepare', captureId });
    controller.receiveVoiceEvent({ kind: 'failed' });
    vi.advanceTimersByTime(1800);
  }).not.toThrow();
  expect(latest()?.phase).toBe(CompanionHudPhase.IDLE);
  expect(transitions.at(-1)).toMatchObject({
    previousPhase: CompanionHudPhase.ERROR,
    nextPhase: CompanionHudPhase.IDLE,
    source: CompanionHudTransitionSource.HIDE_TIMER,
  });
});

it('keeps a recoverable model pause visible through a spoken retry and accepts later Esc', () => {
  const { controller, latest } = createHarness();
  const answerCaptureId = '33333333-3333-4333-8333-333333333333';
  controller.startTask(sessionId, 'en');
  controller.receiveProgress({
    kind: 'progress',
    requestId: captureId,
    sessionId,
    lessonId: captureId,
    phase: AgentProgressPhase.PAUSED,
    teachingMessage: {
      lessonId: captureId,
      stepId: sessionId,
      sequence: 1,
      kind: TeachingMessageKind.QUESTION,
      text: 'Reply to retry, or press Esc to stop.',
    },
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.NEEDS_INPUT);
  vi.advanceTimersByTime(3000);
  expect(latest()?.phase).toBe(CompanionHudPhase.NEEDS_INPUT);
  controller.receiveVoiceEvent({ kind: 'prepare', captureId: answerCaptureId });
  expect(latest()?.message?.kind).toBe(TeachingMessageKind.QUESTION);
  controller.receiveVoiceEvent({
    kind: 'submitted',
    captureId: answerCaptureId,
    sessionId,
    text: 'Try again',
  });
  controller.receiveVoiceEvent({
    kind: 'result',
    captureId: answerCaptureId,
    sessionId,
    result: { kind: 'accepted', lessonId: captureId },
  });
  controller.receiveProgress({
    kind: 'progress',
    requestId: captureId,
    sessionId,
    phase: AgentProgressPhase.THINKING,
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.THINKING);
  controller.finishTask(
    {
      kind: 'teaching',
      result: { outcome: TeachingOutcome.CANCELED, reason: GuidanceReason.EXPLICIT_STOP },
    },
    sessionId,
  );
  expect(latest()?.phase).toBe(CompanionHudPhase.CANCELED);
  controller.receiveProgress({
    kind: 'progress',
    requestId: captureId,
    sessionId,
    phase: AgentProgressPhase.PAUSED,
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.CANCELED);
});

it('releases a fatal model error presentation when the next voice hold begins', () => {
  const { controller, latest } = createHarness();
  controller.startTask(sessionId, 'en');
  controller.finishTask(
    {
      kind: 'teaching',
      result: { outcome: TeachingOutcome.FAILED, reason: GuidanceReason.TRANSPORT_FAILED },
    },
    sessionId,
  );
  expect(latest()?.phase).toBe(CompanionHudPhase.ERROR);
  controller.receiveProgress({
    kind: 'progress',
    requestId: captureId,
    sessionId,
    phase: AgentProgressPhase.PAUSED,
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.ERROR);
  controller.receiveVoiceEvent({ kind: 'prepare', captureId });
  vi.advanceTimersByTime(1800);
  expect(latest()?.phase).toBe(CompanionHudPhase.PREPARING);
});

it('preserves a paused lesson after follow-up voice failure and restores its retry prompt', () => {
  const { controller, latest, transitions } = createHarness();
  const question = {
    lessonId: captureId,
    stepId: sessionId,
    sequence: 1,
    kind: TeachingMessageKind.QUESTION,
    text: 'Private retry question.',
  };
  controller.startTask(sessionId, 'en');
  controller.receiveProgress({
    kind: 'progress',
    requestId: captureId,
    sessionId,
    lessonId: captureId,
    phase: AgentProgressPhase.PAUSED,
    teachingMessage: question,
  });
  controller.receiveVoiceEvent({ kind: 'prepare', captureId });
  controller.updateMeter({ captureId, sequence: 0, level: 0.7 });
  controller.receiveVoiceEvent({ kind: 'failed' });
  expect(latest()).toMatchObject({ phase: CompanionHudPhase.ERROR, message: question, level: 0 });
  expect(transitions.at(-1)).toMatchObject({
    previousPhase: CompanionHudPhase.LISTENING,
    nextPhase: CompanionHudPhase.ERROR,
    source: CompanionHudTransitionSource.VOICE_EVENT,
    voiceEventKind: 'failed',
    sessionId,
    captureId,
    lessonId: captureId,
  });
  vi.advanceTimersByTime(50);
  controller.updateMeter({ captureId, sequence: 1, level: 1 });
  expect(latest()?.phase).toBe(CompanionHudPhase.ERROR);
  vi.advanceTimersByTime(1750);
  expect(latest()).toMatchObject({ phase: CompanionHudPhase.NEEDS_INPUT, message: question });
  expect(transitions.at(-1)).toMatchObject({
    previousPhase: CompanionHudPhase.ERROR,
    nextPhase: CompanionHudPhase.NEEDS_INPUT,
    source: CompanionHudTransitionSource.HIDE_TIMER,
    sessionId,
    captureId: null,
    lessonId: captureId,
  });
  controller.receiveProgress({
    kind: 'progress',
    requestId: captureId,
    sessionId,
    phase: AgentProgressPhase.THINKING,
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.THINKING);
  controller.receiveVoiceEvent({
    kind: 'prepare',
    captureId: '33333333-3333-4333-8333-333333333333',
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.PREPARING);
  expect(JSON.stringify(transitions)).not.toContain(question.text);
});

it.each(['voice hold', 'lesson progress'] as const)(
  'does not let an earlier follow-up error timer overwrite newer %s',
  (nextActivity) => {
    const { controller, latest } = createHarness();
    controller.startTask(sessionId, 'en');
    controller.receiveProgress({
      kind: 'progress',
      requestId: captureId,
      sessionId,
      lessonId: captureId,
      phase: AgentProgressPhase.PAUSED,
      teachingMessage: {
        lessonId: captureId,
        stepId: sessionId,
        sequence: 1,
        kind: TeachingMessageKind.QUESTION,
        text: 'Reply to retry.',
      },
    });
    controller.receiveVoiceEvent({ kind: 'prepare', captureId });
    controller.receiveVoiceEvent({ kind: 'cancel', captureId });
    controller.receiveVoiceEvent({ kind: 'failed' });
    expect(latest()?.phase).toBe(CompanionHudPhase.ERROR);
    vi.advanceTimersByTime(500);
    if (nextActivity === 'voice hold') {
      controller.receiveVoiceEvent({
        kind: 'prepare',
        captureId: '33333333-3333-4333-8333-333333333333',
      });
    } else {
      controller.receiveProgress({
        kind: 'progress',
        requestId: captureId,
        sessionId,
        phase: AgentProgressPhase.THINKING,
      });
    }
    const phase = latest()?.phase;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1300);
    expect(latest()?.phase).toBe(phase);
    expect(latest()?.phase).not.toBe(CompanionHudPhase.IDLE);
  },
);
describe('companion voice lifecycle', () => {
  it('uses microphone frames, fences release and stale meters, and keeps the bar through admission', () => {
    const { controller, latest } = createHarness();
    controller.receiveVoiceEvent({ kind: 'prepare', captureId });
    controller.receiveVoiceEvent({ kind: 'record', captureId });
    expect(latest()?.phase).toBe(CompanionHudPhase.PREPARING);
    controller.updateMeter({ captureId, sequence: 0, level: 0.6 });
    expect(latest()?.phase).toBe(CompanionHudPhase.LISTENING);
    controller.receiveVoiceEvent({ kind: 'release', captureId });
    vi.advanceTimersByTime(100);
    controller.updateMeter({ captureId, sequence: 1, level: 1 });
    expect(latest()?.phase).toBe(CompanionHudPhase.TRANSCRIBING);
    controller.receiveVoiceEvent({ kind: 'admitting', captureId });
    expect(latest()?.phase).toBe(CompanionHudPhase.SENDING);
    controller.receiveVoiceEvent({ kind: 'submitted', captureId, sessionId, text: 'Show me' });
    controller.receiveProgress({
      kind: 'progress',
      requestId: captureId,
      sessionId,
      phase: 'thinking',
    });
    expect(latest()?.phase).toBe(CompanionHudPhase.THINKING);
    controller.receiveProgress({
      kind: 'progress',
      requestId: captureId,
      sessionId: captureId,
      phase: 'working',
    });
    expect(latest()?.phase).toBe(CompanionHudPhase.THINKING);
    controller.receiveVoiceEvent({
      kind: 'result',
      captureId,
      sessionId,
      result: { kind: 'completed', completion: { kind: 'response' }, answer: 'Done' },
    });
    expect(latest()?.phase).toBe(CompanionHudPhase.DONE);
    vi.advanceTimersByTime(650);
    expect(latest()?.phase).toBe(CompanionHudPhase.IDLE);
  });

  it('cancels terminal timers when another hold begins, clears empty finals and survives presentation errors', () => {
    const { controller, latest } = createHarness();
    controller.receiveVoiceEvent({ kind: 'prepare', captureId });
    controller.receiveVoiceEvent({ kind: 'cancel', captureId });
    controller.receiveVoiceEvent({ kind: 'prepare', captureId: sessionId });
    vi.advanceTimersByTime(700);
    expect(latest()?.phase).toBe(CompanionHudPhase.PREPARING);
    controller.receiveVoiceEvent({ kind: 'release', captureId: sessionId });
    controller.receiveVoiceEvent({
      kind: 'status',
      status: {
        state: VoiceState.IDLE,
        shortcut: VoiceShortcut.COMMAND_CONTROL,
        globalShortcutAvailable: true,
      },
    });
    expect(latest()?.phase).toBe(CompanionHudPhase.IDLE);
    const broken = new CompanionHudController(
      {
        showSnapshot: () => {
          throw new Error('offline');
        },
      },
      { now: () => 0, schedule: () => () => {} },
    );
    expect(() => {
      broken.receiveVoiceEvent({ kind: 'prepare', captureId });
    }).not.toThrow();
  });

  it('does not relabel quota errors as permissions, and sign-out fences progress', () => {
    const { controller, latest } = createHarness();
    controller.startTask(sessionId, 'vi');
    controller.finishTask({
      kind: 'failed',
      message: 'Daily model allowance reached.',
      code: AgentFailureCode.DAILY_LIMIT,
    });
    expect(latest()?.phase).toBe(CompanionHudPhase.DAILY_LIMIT);
    expect(latest()?.locale).toBe('vi');
    controller.reset();
    controller.finishTask(
      { kind: 'completed', completion: { kind: 'response' }, answer: 'late' },
      sessionId,
    );
    controller.receiveProgress({
      kind: 'progress',
      requestId: captureId,
      sessionId,
      phase: 'thinking',
    });
    expect(latest()?.phase).toBe(CompanionHudPhase.IDLE);
  });
});

it.each([
  [
    { kind: 'teaching', result: { outcome: 'demonstrated', answer: 'Guide finished' } },
    CompanionHudPhase.DONE,
  ],
  [
    { kind: 'teaching', result: { outcome: 'needs_input', reason: 'no_demonstration' } },
    CompanionHudPhase.NEEDS_INPUT,
  ],
  [
    { kind: 'teaching', result: { outcome: 'canceled', reason: 'user_takeover' } },
    CompanionHudPhase.CANCELED,
  ],
  [
    { kind: 'teaching', result: { outcome: 'failed', reason: 'render_timeout' } },
    CompanionHudPhase.ERROR,
  ],
] as const)('presents the V2 teaching outcome %j truthfully', (result, phase) => {
  const { controller, latest } = createHarness();
  controller.startTask(sessionId, 'en');
  controller.finishTask(result, sessionId);
  expect(latest()?.phase).toBe(phase);
});

it.each([
  ['succeeded', CompanionHudPhase.DONE],
  ['partial', CompanionHudPhase.ERROR],
  ['blocked', CompanionHudPhase.NEEDS_INPUT],
  ['unverified', CompanionHudPhase.ERROR],
] as const)(
  'presents execution outcome %s without claiming unsupported completion',
  (status, phase) => {
    const { controller, latest } = createHarness();
    controller.startTask(sessionId, 'vi');
    controller.finishTask(
      {
        kind: 'completed',
        answer: 'Task result',
        completion: {
          kind: 'task',
          outcome: {
            status,
            requiredCriteriaCount: 2,
            supportedCriteriaCount: status === 'succeeded' ? 2 : status === 'partial' ? 1 : 0,
            remainingCriteriaCount: status === 'succeeded' ? 0 : status === 'partial' ? 1 : 2,
            limitation: status === 'succeeded' ? null : 'Not all results are confirmed.',
          },
        },
      },
      sessionId,
    );
    expect(latest()).toMatchObject({ phase, locale: 'vi' });
    vi.advanceTimersByTime(status === 'succeeded' ? 650 : 1800);
    expect(latest()?.phase).toBe(CompanionHudPhase.IDLE);
  },
);

it('keeps the original voice lesson active through an answer and shows its final goal result', () => {
  const { controller, latest } = createHarness();
  const answerCapture = '33333333-3333-4333-8333-333333333333';
  controller.receiveVoiceEvent({ kind: 'prepare', captureId });
  controller.receiveVoiceEvent({ kind: 'submitted', captureId, sessionId, text: 'Design the ERD' });
  controller.receiveVoiceEvent({ kind: 'prepare', captureId: answerCapture });
  controller.receiveVoiceEvent({
    kind: 'submitted',
    captureId: answerCapture,
    sessionId,
    text: 'Sales',
  });
  controller.receiveVoiceEvent({
    kind: 'result',
    captureId: answerCapture,
    sessionId,
    result: { kind: 'accepted', lessonId: captureId },
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.SENDING);
  controller.receiveVoiceEvent({
    kind: 'result',
    captureId,
    sessionId,
    result: { kind: 'teaching', result: { outcome: 'goal_reached', answer: 'ERD complete.' } },
  });
  expect(latest()?.phase).toBe(CompanionHudPhase.DONE);
});

it('keeps one message across meters and waits, rejects late revisions and lets completion fade finish', () => {
  const { controller, latest } = createHarness();
  controller.startTask(sessionId, 'vi');
  const message = {
    lessonId: captureId,
    stepId: sessionId,
    sequence: 1,
    kind: 'instruction' as const,
    text: 'Nhập youtube.com rồi nhấn Enter.',
  };
  const progress = {
    kind: 'progress' as const,
    requestId: captureId,
    sessionId,
    phase: 'waiting' as const,
    lessonId: captureId,
    teachingMessage: message,
    locale: 'vi' as const,
  };
  controller.receiveProgress(progress);
  expect(latest()?.phase).toBe(CompanionHudPhase.WAITING);
  controller.receiveVoiceEvent({ kind: 'prepare', captureId });
  controller.updateMeter({ captureId, sequence: 0, level: 0.8 });
  expect(latest()?.message).toEqual(message);
  controller.receiveVoiceEvent({ kind: 'cancel', captureId });
  expect(latest()?.message).toEqual(message);
  controller.receiveProgress({
    ...progress,
    teachingMessage: { ...message, sequence: 2, kind: 'completion', text: 'YouTube đã mở.' },
  });
  controller.receiveProgress(progress);
  expect(latest()?.message?.sequence).toBe(2);
  controller.finishTask(
    { kind: 'teaching', result: { outcome: 'goal_reached', answer: 'YouTube đã mở.' } },
    sessionId,
  );
  vi.advanceTimersByTime(4000);
  expect(latest()?.message?.kind).toBe('completion');
  controller.startTask(captureId, 'en');
  vi.advanceTimersByTime(2000);
  expect(latest()?.phase).toBe(CompanionHudPhase.SENDING);
});

it('shows submission status only until a saved receipt, preserving locale and fencing late replies', () => {
  const { controller, latest } = createHarness();
  controller.setLocale('vi');
  expect(controller.startPractice(captureId, 'submit-snapshot')).toBe(true);
  expect(latest()).toMatchObject({ phase: 'submitting', locale: 'vi' });
  controller.receivePracticeReply(sessionId, { kind: 'failed', code: 'unavailable' });
  expect(latest()?.phase).toBe('submitting');
  controller.receivePracticeReply(captureId, {
    kind: 'submitted',
    submission: {
      id: captureId,
      studentId: 'student',
      attemptId: sessionId,
      checkpointId: sessionId,
      snapshotId: sessionId,
      checkId: sessionId,
      sequence: 1,
      submittedAt: new Date().toISOString(),
    },
  });
  expect(latest()?.phase).toBe('submitted');
  vi.advanceTimersByTime(2200);
  expect(latest()?.phase).toBe('idle');
  controller.startPractice(captureId, 'check', 'en');
  controller.receiveVoiceEvent({ kind: 'prepare', captureId: sessionId });
  controller.receivePracticeReply(captureId, { kind: 'failed', code: 'unavailable' });
  expect(latest()?.phase).toBe('preparing');
  expect(controller.startPractice(captureId, 'check', 'en')).toBe(false);
});

it('keeps running check progress until matching history, then reports feedback without claiming a pass', () => {
  const { controller, latest } = createHarness();
  const context = createTeachingContext();
  const record: PracticeRecord = {
    id: sessionId,
    requestId: captureId,
    snapshotId: captureId,
    attemptId: context.attempt.id,
    checkpointId: captureId,
    rubric: createPracticeCheckpoint(),
    status: 'running',
    finding: null,
    results: [],
    evaluator: 'test',
    createdAt: new Date().toISOString(),
    completedAt: null,
    evidence: [],
  };
  controller.startPractice(captureId, 'check', 'vi');
  controller.receivePracticeReply(captureId, { kind: 'check', check: record });
  expect(latest()?.phase).toBe('checking');
  controller.receivePracticeHistory({
    kind: 'history',
    checks: [{ ...record, id: captureId, status: 'completed', finding: 'met' }],
    submissions: [],
  });
  expect(latest()?.phase).toBe('checking');
  controller.receivePracticeHistory({
    kind: 'history',
    checks: [{ ...record, status: 'completed', finding: 'needs_changes' }],
    submissions: [],
  });
  expect(latest()).toMatchObject({ phase: 'checked', locale: 'vi' });
  controller.startTask(sessionId, 'en');
  vi.advanceTimersByTime(2500);
  expect(latest()?.phase).toBe('sending');
});

it('bounds practice presentation and never reports a failed request as a saved hand-in', () => {
  const { controller, latest } = createHarness();
  controller.startPractice(captureId, 'check', 'en');
  vi.advanceTimersByTime(100_000);
  expect(latest()?.phase).toBe('error');
  controller.startPractice(captureId, 'submit-snapshot', 'vi');
  controller.receivePracticeReply(captureId, { kind: 'failed', code: 'stale' });
  expect(latest()?.phase).toBe('error');
  controller.reset();
  controller.receivePracticeReply(captureId, { kind: 'failed', code: 'unavailable' });
  expect(latest()?.phase).toBe('idle');
});

it.each(['en', 'vi'] as const)(
  'keeps the %s HUD in checking while evaluation is pending',
  (locale) => {
    const { controller, latest } = createHarness();
    expect(controller.startPractice(captureId, 'check', locale)).toBe(true);
    vi.advanceTimersByTime(59000);
    expect(latest()).toMatchObject({ phase: 'checking', locale });
    controller.receivePracticeReply(sessionId, { kind: 'failed', code: 'unavailable' });
    expect(latest()).toMatchObject({ phase: 'checking', locale });
    controller.receivePracticeReply(captureId, { kind: 'failed', code: 'unavailable' });
    expect(latest()).toMatchObject({ phase: 'error', locale });
  },
);
