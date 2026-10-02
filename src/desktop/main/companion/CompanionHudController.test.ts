import { describe, expect, it, vi, afterEach } from 'vitest';
import { CompanionHudController, type CompanionHudPort } from './CompanionHudController.js';
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
      result: { kind: 'completed', answer: 'Done' },
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
    controller.finishTask({ kind: 'completed', answer: 'late' }, sessionId);
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
    { kind: 'teaching', result: { outcome: 'explained', answer: 'Here is how' } },
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
