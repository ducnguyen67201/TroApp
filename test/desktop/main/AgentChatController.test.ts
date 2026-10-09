import { afterEach, expect, it, vi } from 'vitest';
import { AgentChatController } from '../../../src/desktop/main/AgentChatController.js';
import type {
  AgentChatAuth,
  AgentChatWorker,
  AgentChatPermissions,
  AgentCancelShortcut,
} from '../../../src/desktop/main/AgentChatPorts.js';
import { DesktopPermissionState, PermissionGrant } from '#contracts/DesktopPermissions.js';
import type { ModelCredential } from '#contracts/AuthSession.js';
import type { AgentResult } from '#contracts/AgentSession.js';
import {
  AgentProgressPhase,
  CompanionHudPhase,
  type CompanionHudSnapshot,
  type AgentProgress,
} from '#contracts/CompanionHud.js';
import { AgentTaskMode, GuidanceReason, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { TeachingMessageKind } from '#contracts/TeachingStep.js';
import { TranscriptionEventKind, type TranscriptionEvent } from '#contracts/Transcription.js';
import { VoiceShortcut, VoiceState, type VoiceEvent } from '#contracts/VoiceInput.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import {
  VoiceoverController,
  type VoiceoverDependencies,
} from '../../../src/desktop/main/voiceover/VoiceoverController.js';

import type { ClassroomTaskContext } from '../../../src/desktop/main/classroom/ClassroomSessionController.js';
import { createTeachingContext } from '../../server/features/classroom/ClassroomFixtures.js';
import { CompanionHudController } from '../../../src/desktop/main/companion/CompanionHudController.js';
import {
  VoiceInputController,
  type VoiceDependencies,
} from '../../../src/desktop/main/voice/VoiceInputController.js';
import type { TranscriptionConnection } from '../../../src/desktop/main/voice/TranscriptionClient.js';

function createController(
  cancelShortcut?: AgentCancelShortcut,
  classroom?: ClassroomTaskContext,
  voiceover?: VoiceoverController,
) {
  const auth = {
    readSession: vi.fn<AgentChatAuth['readSession']>().mockResolvedValue({
      kind: 'signed-in',
      user: { id: 'student', name: 'Student', email: 'student@example.test' },
    }),
    signInWithGoogle: vi
      .fn<AgentChatAuth['signInWithGoogle']>()
      .mockResolvedValue({ kind: 'pending' }),
    signOut: vi.fn<AgentChatAuth['signOut']>().mockResolvedValue({ kind: 'signed-out' }),
    fetchModelCredential: vi.fn<AgentChatAuth['fetchModelCredential']>(),
  };
  const worker = {
    isRunning: vi.fn<AgentChatWorker['isRunning']>().mockReturnValue(false),
    startCompanion: vi
      .fn<AgentChatWorker['startCompanion']>()
      .mockResolvedValue({ kind: 'started', sessionId: 'companion' }),
    start: vi
      .fn<AgentChatWorker['start']>()
      .mockResolvedValue({ kind: 'started', sessionId: 'teacher' }),
    sendMessage: vi
      .fn<AgentChatWorker['sendMessage']>()
      .mockResolvedValue({ kind: 'completed', completion: { kind: 'response' }, answer: 'Done' }),
    answerLesson: vi
      .fn<NonNullable<AgentChatWorker['answerLesson']>>()
      .mockResolvedValue({ kind: 'accepted', lessonId: '22222222-2222-4222-8222-222222222222' }),
    refreshCredential: vi
      .fn<NonNullable<AgentChatWorker['refreshCredential']>>()
      .mockResolvedValue({ kind: 'started', sessionId: 'teacher' }),
    stop: vi.fn<AgentChatWorker['stop']>().mockResolvedValue({ kind: 'stopped' }),
    dispose: vi.fn<AgentChatWorker['dispose']>(),
  };
  const permissions = {
    readStatus: vi.fn<AgentChatPermissions['readStatus']>().mockResolvedValue({
      kind: DesktopPermissionState.READY,
      accessibility: PermissionGrant.GRANTED,
      screenRecording: PermissionGrant.GRANTED,
    }),
  };
  const controller = new AgentChatController(
    auth,
    worker,
    'https://gateway.example.test',
    permissions,
    cancelShortcut,
    voiceover,
    classroom,
  );
  return { auth, worker, permissions, controller };
}

it('does not start an agent after Stop while its model credential is loading', async () => {
  const { auth, worker, controller } = createController();
  let completeCredential: ((value: ModelCredential) => void) | undefined;
  auth.fetchModelCredential.mockImplementation(
    () =>
      new Promise((resolve) => {
        completeCredential = resolve;
      }),
  );
  const task = controller.sendMessage('teacher', 'Show a circle', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(auth.fetchModelCredential).toHaveBeenCalledTimes(1);
  });
  await controller.stopSession('teacher');
  completeCredential?.({ token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' });
  expect(await task).toMatchObject({ kind: 'failed' });
  expect(worker.start).not.toHaveBeenCalled();
  expect(worker.sendMessage).not.toHaveBeenCalled();
});

it('disposes a starting worker and rejects its late ready reply after Stop', async () => {
  const { auth, worker, controller } = createController();
  auth.fetchModelCredential.mockResolvedValue({
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let finishStart: ((value: Awaited<ReturnType<AgentChatWorker['start']>>) => void) | undefined;
  worker.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  );
  const task = controller.sendMessage('teacher', 'Show a circle', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(worker.start).toHaveBeenCalledTimes(1);
  });
  const disposals = worker.dispose.mock.calls.length;
  await controller.stopSession('teacher');
  expect(worker.dispose).toHaveBeenCalledTimes(disposals + 1);
  finishStart?.({ kind: 'started', sessionId: 'teacher' });
  expect(await task).toMatchObject({ kind: 'failed' });
  expect(worker.sendMessage).not.toHaveBeenCalled();
});

it('starts one local companion without a model credential or task', async () => {
  const { auth, worker, controller } = createController();
  const first = controller.startCursorCompanion();
  const second = controller.startCursorCompanion();
  expect(second).toBe(first);
  expect(await first).toMatchObject({ kind: 'started' });
  expect(worker.startCompanion).toHaveBeenCalledTimes(1);
  expect(auth.fetchModelCredential).not.toHaveBeenCalled();
  expect(worker.start).not.toHaveBeenCalled();
  expect(worker.sendMessage).not.toHaveBeenCalled();
  controller.dispose();
});

it('keeps the companion off until sign-in and both desktop grants are verified', async () => {
  const { auth, worker, permissions, controller } = createController();
  auth.readSession.mockResolvedValueOnce({ kind: 'signed-out' });
  expect(await controller.startCursorCompanion()).toMatchObject({ kind: 'failed' });
  permissions.readStatus.mockResolvedValue({
    kind: 'unknown',
    accessibility: 'unknown',
    screenRecording: 'unknown',
  });
  expect(await controller.startCursorCompanion()).toMatchObject({ kind: 'failed' });
  expect(worker.startCompanion).not.toHaveBeenCalled();
  expect(auth.fetchModelCredential).not.toHaveBeenCalled();
  controller.dispose();
});

it('rejects late companion startup after sign-out without reconnecting', async () => {
  const { worker, controller } = createController();
  let finishStart:
    ((result: Awaited<ReturnType<AgentChatWorker['startCompanion']>>) => void) | undefined;
  worker.startCompanion.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  );
  const following = controller.startCursorCompanion();
  await vi.waitFor(() => {
    expect(worker.startCompanion).toHaveBeenCalledTimes(1);
  });
  await controller.signOut();
  finishStart?.({ kind: 'started', sessionId: 'companion' });
  expect(await following).toMatchObject({ kind: 'failed' });
  expect(worker.startCompanion).toHaveBeenCalledTimes(1);
  controller.dispose();
});

it('releases idle ownership before starting a credentialed task and restores it after Stop', async () => {
  const { auth, worker, controller } = createController();
  worker.startCompanion.mockImplementation((sessionId) => {
    worker.isRunning.mockReturnValue(true);
    return Promise.resolve({ kind: 'started', sessionId });
  });
  worker.stop.mockImplementation(() => {
    worker.isRunning.mockReturnValue(false);
    return Promise.resolve({ kind: 'stopped' });
  });
  worker.start.mockImplementation((sessionId) => {
    worker.isRunning.mockReturnValue(true);
    return Promise.resolve({ kind: 'started', sessionId });
  });
  auth.fetchModelCredential.mockResolvedValue({
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await controller.startCursorCompanion();
  expect(
    await controller.sendMessage('teacher', 'Show a circle', DesktopLocale.ENGLISH, 'teach'),
  ).toMatchObject({ kind: 'completed' });
  const stopOrder = worker.stop.mock.invocationCallOrder[0];
  const taskStartOrder = worker.start.mock.invocationCallOrder[0];
  expect(stopOrder).toBeDefined();
  expect(taskStartOrder).toBeDefined();
  expect(stopOrder).toBeLessThan(taskStartOrder ?? 0);
  await controller.stopSession('teacher');
  expect(worker.startCompanion).toHaveBeenCalledTimes(2);
  expect(auth.fetchModelCredential).toHaveBeenCalledTimes(1);
  controller.dispose();
});

it('Esc cancels a teaching request during credential loading and suppresses later startup', async () => {
  const shortcut = {
    enable: vi.fn<AgentCancelShortcut['enable']>().mockReturnValue(true),
    disable: vi.fn<AgentCancelShortcut['disable']>(),
  };
  const { auth, worker, controller } = createController(shortcut);
  let finishCredential: ((value: ModelCredential) => void) | undefined;
  auth.fetchModelCredential.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCredential = resolve;
      }),
  );
  const turning = controller.sendMessage('teacher', 'Open YouTube', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(auth.fetchModelCredential).toHaveBeenCalledOnce();
  });
  shortcut.enable.mock.calls[0]?.[0]();
  finishCredential?.({ token: 'test-token', expiresAt: '2099-01-01T00:00:00.000Z' });
  expect(await turning).toEqual({
    kind: 'teaching',
    result: { outcome: 'canceled', reason: 'explicit_stop' },
  });
  expect(worker.start).not.toHaveBeenCalled();
  expect(worker.sendMessage).not.toHaveBeenCalled();
  expect(shortcut.disable).toHaveBeenCalled();
});

it('Esc stops an active teaching worker and discards a late successful answer', async () => {
  const shortcut = {
    enable: vi.fn<AgentCancelShortcut['enable']>().mockReturnValue(true),
    disable: vi.fn<AgentCancelShortcut['disable']>(),
  };
  const { auth, worker, controller } = createController(shortcut);
  auth.fetchModelCredential.mockResolvedValue({
    token: 'test-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let finishTurn:
    ((result: Awaited<ReturnType<AgentChatWorker['sendMessage']>>) => void) | undefined;
  worker.start.mockImplementation(async () => {
    await Promise.resolve();
    worker.isRunning.mockReturnValue(true);
    return { kind: 'started', sessionId: 'teacher' };
  });
  worker.sendMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishTurn = resolve;
      }),
  );
  const turning = controller.sendMessage('teacher', 'Open YouTube', DesktopLocale.ENGLISH, 'teach');
  await vi.waitFor(() => {
    expect(worker.sendMessage).toHaveBeenCalledOnce();
  });
  shortcut.enable.mock.calls[0]?.[0]();
  await vi.waitFor(() => {
    expect(worker.stop).toHaveBeenCalledWith('teacher');
  });
  finishTurn?.({ kind: 'teaching', result: { outcome: 'demonstrated', answer: 'Late guide' } });
  expect(await turning).toEqual({
    kind: 'teaching',
    result: { outcome: 'canceled', reason: 'explicit_stop' },
  });
  controller.dispose();
});

afterEach(() => {
  vi.useRealTimers();
});

it.each(['needs_input', 'waiting'] as const)(
  'routes answers during %s into the same lesson and fences foreign questions',
  async (phase) => {
    const { auth, worker, controller } = createController();
    auth.fetchModelCredential.mockResolvedValue({
      token: 'test-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    let finish: ((result: Awaited<ReturnType<AgentChatWorker['sendMessage']>>) => void) | undefined;
    worker.sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = controller.sendMessage(
      'teacher',
      'Design an ERD',
      DesktopLocale.ENGLISH,
      'teach',
    );
    await vi.waitFor(() => {
      expect(worker.sendMessage).toHaveBeenCalledOnce();
    });
    const lessonId = '22222222-2222-4222-8222-222222222222';
    controller.receiveProgress({
      kind: 'progress',
      requestId: lessonId,
      sessionId: 'teacher',
      lessonId,
      phase,
      canAcceptAnswer: true,
      teachingStep: 'Which database?',
    });
    expect(controller.isBusy()).toBe(false);
    expect(await controller.startTaskSession()).toEqual({ kind: 'started', sessionId: 'teacher' });
    expect(
      await controller.answerLesson('other', lessonId, 'Sales', DesktopLocale.ENGLISH),
    ).toMatchObject({ kind: 'failed' });
    expect(
      await controller.sendMessage('teacher', 'Sales', DesktopLocale.ENGLISH, 'teach'),
    ).toMatchObject({ kind: 'accepted' });
    expect(worker.answerLesson).toHaveBeenCalledWith(
      'teacher',
      lessonId,
      'Sales',
      DesktopLocale.ENGLISH,
    );
    expect(worker.sendMessage).toHaveBeenCalledOnce();
    finish?.({ kind: 'teaching', result: { outcome: 'goal_reached', answer: 'ERD finished.' } });
    expect(await running).toMatchObject({ kind: 'teaching', result: { outcome: 'goal_reached' } });
    controller.dispose();
  },
);

it('routes a transcribed follow-up after a model pause, then Esc releases the lesson and HUD', async () => {
  const shortcut = {
    enable: vi.fn<AgentCancelShortcut['enable']>().mockReturnValue(true),
    disable: vi.fn<AgentCancelShortcut['disable']>(),
  };
  const { auth, worker, controller } = createController(shortcut);
  auth.fetchModelCredential.mockResolvedValue({
    token: 'fixture-model-credential',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  worker.start.mockImplementation((sessionId) => {
    worker.isRunning.mockReturnValue(true);
    return Promise.resolve({ kind: 'started', sessionId });
  });
  let finishLesson: ((result: AgentResult) => void) | undefined;
  worker.sendMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishLesson = resolve;
      }),
  );
  worker.stop.mockImplementation(() => {
    worker.isRunning.mockReturnValue(false);
    finishLesson?.({
      kind: 'teaching',
      result: { outcome: TeachingOutcome.CANCELED, reason: GuidanceReason.EXPLICIT_STOP },
    });
    return Promise.resolve({ kind: 'stopped' });
  });
  const snapshots: CompanionHudSnapshot[] = [];
  const hud = new CompanionHudController(
    { showSnapshot: (snapshot) => snapshots.push(snapshot) },
    {
      now: () => Date.now(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    },
  );
  const voiceEvents: VoiceEvent[] = [];
  let receiveTranscript: ((event: TranscriptionEvent) => void) | undefined;
  const connection: TranscriptionConnection = {
    sendCommand: vi.fn<TranscriptionConnection['sendCommand']>(),
    close: vi.fn<TranscriptionConnection['close']>(),
  };
  const voice = new VoiceInputController(
    {
      readSession: () => controller.readAuthSession(),
      releaseUnusedCredential: () => Promise.resolve(),
      fetchCredential: () =>
        Promise.resolve({
          token: 'fixture-transcription-credential',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      connect: (_token, emit) => {
        receiveTranscript = emit;
        return connection;
      },
      isAgentBusy: () => controller.isBusy(),
      areTriggerKeysReleased: () => true,
      startAgentSession: () => controller.startTaskSession(),
      sendAgentMessage: (sessionId, message, locale, mode) =>
        controller.sendMessage(sessionId, message, locale, mode),
      emit: (event) => {
        voiceEvents.push(event);
        hud.receiveVoiceEvent(event);
      },
    } satisfies VoiceDependencies,
    VoiceShortcut.COMMAND_CONTROL,
  );
  voice.enableVoiceInput(VoiceShortcut.COMMAND_CONTROL, true);
  const sendVoiceInstruction = async (text: string): Promise<void> => {
    expect(voice.startVoiceCapture().kind).toBe('ok');
    const capture = [...voiceEvents].reverse().find((event) => event.kind === 'prepare');
    if (!capture) {
      throw new Error('No capture was prepared.');
    }
    await voice.prepareVoiceCapture(capture.captureId, DesktopLocale.ENGLISH, AgentTaskMode.TEACH);
    if (!receiveTranscript) {
      throw new Error('No transcription connection was established.');
    }
    receiveTranscript({ kind: TranscriptionEventKind.READY });
    voice.releaseVoiceCapture();
    voice.finishVoiceAudio(capture.captureId, -1);
    receiveTranscript({ kind: TranscriptionEventKind.FINAL, text });
  };
  const receiveProgress = (progress: AgentProgress): void => {
    controller.receiveProgress(progress);
    voice.setLessonAnswerAllowed(!controller.isBusy());
    hud.receiveProgress(progress);
  };
  try {
    await sendVoiceInstruction('Explain this screen');
    await vi.waitFor(() => {
      expect(worker.sendMessage).toHaveBeenCalledOnce();
    });
    const submitted = voiceEvents.find((event) => event.kind === 'submitted');
    if (!submitted) {
      throw new Error('The original voice task was not submitted.');
    }
    const lessonId = '22222222-2222-4222-8222-222222222222';
    const pause: AgentProgress = {
      kind: 'progress',
      requestId: submitted.captureId,
      sessionId: submitted.sessionId,
      lessonId,
      phase: AgentProgressPhase.PAUSED,
      canAcceptAnswer: true,
      teachingMessage: {
        lessonId,
        stepId: '33333333-3333-4333-8333-333333333333',
        sequence: 1,
        kind: TeachingMessageKind.QUESTION,
        text: 'The model connection was interrupted. Reply to retry, or press Esc to stop.',
      },
    };
    receiveProgress(pause);
    expect(controller.isBusy()).toBe(false);
    expect(voice.readStatus().state).toBe(VoiceState.IDLE);
    expect(snapshots.at(-1)?.phase).toBe(CompanionHudPhase.NEEDS_INPUT);
    expect(voice.startVoiceCapture().kind).toBe('ok');
    const failedCapture = [...voiceEvents].reverse().find((event) => event.kind === 'prepare');
    if (!failedCapture) {
      throw new Error('No follow-up capture was prepared.');
    }
    await voice.prepareVoiceCapture(
      failedCapture.captureId,
      DesktopLocale.ENGLISH,
      AgentTaskMode.TEACH,
    );
    if (!receiveTranscript) {
      throw new Error('No follow-up transcription connection was established.');
    }
    receiveTranscript({ kind: TranscriptionEventKind.READY });
    receiveTranscript({ kind: TranscriptionEventKind.FAILED });
    expect(voice.readStatus().state).toBe(VoiceState.IDLE);
    expect(snapshots.at(-1)?.phase).toBe(CompanionHudPhase.ERROR);
    expect(snapshots.at(-1)?.message).toEqual(pause.teachingMessage);
    await sendVoiceInstruction('Try again');
    await vi.waitFor(() => {
      expect(worker.answerLesson).toHaveBeenCalledOnce();
    });
    expect(worker.answerLesson).toHaveBeenCalledWith(
      submitted.sessionId,
      lessonId,
      'Try again',
      DesktopLocale.ENGLISH,
    );
    expect(worker.sendMessage).toHaveBeenCalledOnce();
    expect(worker.start).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(
        voiceEvents.some((event) => event.kind === 'result' && event.result.kind === 'accepted'),
      ).toBe(true);
    });
    receiveProgress({ ...pause, phase: AgentProgressPhase.THINKING });
    expect(voice.startVoiceCapture()).toEqual({ kind: 'failed' });
    expect(shortcut.enable).toHaveBeenCalledOnce();
    shortcut.enable.mock.calls[0]?.[0]();
    await vi.waitFor(() => {
      expect(
        voiceEvents.some(
          (event) =>
            event.kind === 'result' &&
            event.result.kind === 'teaching' &&
            event.result.result.outcome === TeachingOutcome.CANCELED,
        ),
      ).toBe(true);
    });
    expect(worker.stop).toHaveBeenCalledWith(submitted.sessionId);
    expect(controller.isBusy()).toBe(false);
    expect(voice.readStatus().state).toBe(VoiceState.IDLE);
    expect(snapshots.at(-1)?.phase).toBe(CompanionHudPhase.CANCELED);
    expect(shortcut.disable).toHaveBeenCalled();
    receiveProgress(pause);
    expect(snapshots.at(-1)?.phase).toBe(CompanionHudPhase.CANCELED);
    expect(voice.startVoiceCapture().kind).toBe('ok');
  } finally {
    voice.disableVoiceInput();
    controller.dispose();
    hud.reset();
  }
});

it('releases busy and answer ownership after a fatal model result without requiring Esc', async () => {
  const shortcut = {
    enable: vi.fn<AgentCancelShortcut['enable']>().mockReturnValue(true),
    disable: vi.fn<AgentCancelShortcut['disable']>(),
  };
  const { auth, worker, controller } = createController(shortcut);
  auth.fetchModelCredential.mockResolvedValue({
    token: 'fixture',
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  worker.sendMessage.mockResolvedValueOnce({
    kind: 'teaching',
    result: { outcome: TeachingOutcome.FAILED, reason: GuidanceReason.TRANSPORT_FAILED },
  });
  try {
    expect(
      await controller.sendMessage(
        'teacher',
        'Explain this screen',
        DesktopLocale.ENGLISH,
        AgentTaskMode.TEACH,
      ),
    ).toMatchObject({
      kind: 'teaching',
      result: { outcome: TeachingOutcome.FAILED },
    });
    expect(controller.isBusy()).toBe(false);
    expect(shortcut.disable).toHaveBeenCalled();
    controller.receiveProgress({
      kind: 'progress',
      requestId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'teacher',
      lessonId: '22222222-2222-4222-8222-222222222222',
      phase: AgentProgressPhase.PAUSED,
      canAcceptAnswer: true,
    });
    expect(
      await controller.answerLesson(
        'teacher',
        '22222222-2222-4222-8222-222222222222',
        'Try again',
        DesktopLocale.ENGLISH,
      ),
    ).toMatchObject({ kind: 'failed' });
    expect(
      await controller.sendMessage(
        'new-session',
        'Explain again',
        DesktopLocale.ENGLISH,
        AgentTaskMode.TEACH,
      ),
    ).toMatchObject({ kind: 'completed' });
    expect(worker.sendMessage).toHaveBeenCalledTimes(2);
    expect(worker.answerLesson).not.toHaveBeenCalled();
  } finally {
    controller.dispose();
  }
});

it('renews expiring model access during a long lesson without replacing its worker or goal', async () => {
  vi.useFakeTimers();
  const { auth, worker, controller } = createController();
  auth.fetchModelCredential
    .mockResolvedValueOnce({
      token: 'initial',
      expiresAt: new Date(Date.now() + 90000).toISOString(),
    })
    .mockResolvedValue({
      token: 'renewed',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
  worker.sendMessage.mockImplementation(() => new Promise(() => {}));
  void controller.sendMessage('teacher', 'Open YouTube', DesktopLocale.ENGLISH, 'teach');
  await vi.advanceTimersByTimeAsync(30000);
  expect(worker.refreshCredential).toHaveBeenCalledWith(
    'teacher',
    'renewed',
    'https://gateway.example.test',
  );
  expect(worker.start).toHaveBeenCalledOnce();
  controller.dispose();
  await vi.advanceTimersByTimeAsync(120000);
  expect(worker.refreshCredential).toHaveBeenCalledOnce();
});

it.each([
  [DesktopLocale.ENGLISH, 'The class context changed. Send your request again.'],
  [DesktopLocale.VIETNAMESE, 'Nội dung buổi học đã thay đổi. Hãy gửi lại yêu cầu.'],
] as const)(
  'passes class context and localizes a stale result in %s',
  async (locale, expectedMessage) => {
    const context = createTeachingContext();
    const voiceover = new VoiceoverController({
      canSpeak: () => false,
      fetchSpeech: vi.fn<VoiceoverDependencies['fetchSpeech']>(),
      sendPlayback: vi.fn<VoiceoverDependencies['sendPlayback']>().mockResolvedValue(true),
      showStatus: vi.fn<VoiceoverDependencies['showStatus']>(),
      holdMessage: vi.fn<VoiceoverDependencies['holdMessage']>(),
      reportFailure: vi.fn<VoiceoverDependencies['reportFailure']>(),
    });
    const clearNarration = vi.spyOn(voiceover, 'clearTask');
    const startNarration = vi.spyOn(voiceover, 'startTask');
    const isContextCurrent = vi
      .fn<ClassroomTaskContext['isContextCurrent']>()
      .mockReturnValue(false);
    const { auth, worker, controller } = createController(
      undefined,
      {
        readTeachingContext: () => Promise.resolve(context),
        isContextCurrent,
      },
      voiceover,
    );
    auth.fetchModelCredential.mockResolvedValue({
      token: 'test-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    try {
      const reply = await controller.sendMessage(
        'class-task',
        'Help me with this',
        locale,
        'teach',
      );
      expect(worker.sendMessage).toHaveBeenCalledWith(
        'class-task',
        'Help me with this',
        locale,
        'teach',
        context,
      );
      expect(reply.kind).toBe('failed');
      if (reply.kind === 'failed') {
        expect(reply.message).toBe(expectedMessage);
      }
      expect(startNarration).toHaveBeenCalledWith('class-task', locale);
      expect(clearNarration).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
    }
  },
);

it.each([
  [DesktopLocale.ENGLISH, 'In class, choose Show me so you perform the learning actions.'],
  [DesktopLocale.VIETNAMESE, 'Trong lớp học, hãy chọn “Chỉ cho tôi” để tự thực hiện bài tập.'],
] as const)(
  'localizes the classroom mode restriction in %s without starting work',
  async (locale, expectedMessage) => {
    const readTeachingContext = vi
      .fn<ClassroomTaskContext['readTeachingContext']>()
      .mockResolvedValue(createTeachingContext());
    const { worker, controller } = createController(undefined, {
      readTeachingContext,
      isContextCurrent: () => true,
    });
    try {
      const execution = await controller.sendMessage('class-task', 'Do this', locale, 'execute');
      expect(execution.kind).toBe('failed');
      if (execution.kind === 'failed') {
        expect(execution.message).toBe(expectedMessage);
      }
      readTeachingContext.mockRejectedValue(new Error('Classroom unavailable'));
      expect(await controller.sendMessage('class-task', 'Help me', locale, 'teach')).toMatchObject({
        kind: 'failed',
      });
      expect(worker.sendMessage).not.toHaveBeenCalled();
      expect(worker.start).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  },
);

it('disposes the old worker before switching credentials without signing the old user out', async () => {
  const { controller, worker, auth } = createController();
  worker.isRunning.mockReturnValue(true);
  const nextUser = { id: 'other-user', name: 'Other', email: 'other@example.test' };
  const switchIdentity = vi
    .fn<() => Promise<import('#contracts/AuthSession.js').AuthResult>>()
    .mockImplementation(() => {
      expect(worker.dispose).toHaveBeenCalled();
      return Promise.resolve({ kind: 'signed-in', user: nextUser });
    });
  expect(await controller.changeAccount(switchIdentity)).toEqual({
    kind: 'signed-in',
    user: nextUser,
  });
  expect(auth.signOut).not.toHaveBeenCalled();
  expect(auth.signInWithGoogle).not.toHaveBeenCalled();
});
