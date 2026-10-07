import type { PracticeRecord } from '#contracts/PracticeCheck.js';
import { createTeachingContext } from '../../../server/features/classroom/ClassroomFixtures.js';
import { createPracticeCheckpoint } from '../../../server/features/classroom/PracticeFixtures.js';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  CompanionHudController,
  type CompanionHudPort,
} from '../../../../src/desktop/main/companion/CompanionHudController.js';
import { CompanionHudPhase, type CompanionHudSnapshot } from '#contracts/CompanionHud.js';
import { VoiceState, VoiceShortcut } from '#contracts/VoiceInput.js';
import { AgentFailureCode } from '#contracts/AgentSession.js';
const captureId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

function createHarness() {
  vi.useFakeTimers();
  const snapshots: CompanionHudSnapshot[] = [];
  const port: CompanionHudPort = {
    showSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
  };
  const controller = new CompanionHudController(port, {
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => {
        clearTimeout(timer);
      };
    },
  });
  return { controller, snapshots, latest: () => snapshots.at(-1) };
}

afterEach(() => {
  vi.useRealTimers();
});
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
