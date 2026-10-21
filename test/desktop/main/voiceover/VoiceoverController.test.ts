import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  VoiceoverController,
  type VoiceoverDependencies,
} from '../../../../src/desktop/main/voiceover/VoiceoverController.js';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { TeachingMessageKind } from '#contracts/TeachingStep.js';
import { VoiceoverLimits, VoiceoverState } from '#contracts/Voiceover.js';
import {
  VoiceoverDiagnosticKind,
  VoiceoverDiagnosticReason,
  VoiceoverDiagnosticStage,
} from '../../../../src/desktop/main/voiceover/VoiceoverDiagnostics.js';

function createHarness() {
  const dependencies = {
    canSpeak: vi.fn<VoiceoverDependencies['canSpeak']>().mockReturnValue(true),
    fetchSpeech: vi.fn<VoiceoverDependencies['fetchSpeech']>().mockImplementation(() =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array([1]));
            stream.enqueue(new Uint8Array([2, 3, 4]));
            stream.close();
          },
        }),
      ),
    ),
    sendPlayback: vi.fn<VoiceoverDependencies['sendPlayback']>().mockResolvedValue(true),
    holdMessage: vi.fn<VoiceoverDependencies['holdMessage']>(),
    showStatus: vi.fn<VoiceoverDependencies['showStatus']>(),
    reportFailure: vi.fn<VoiceoverDependencies['reportFailure']>(),
    reportEvent: vi.fn<NonNullable<VoiceoverDependencies['reportEvent']>>(),
    reportDiagnostic: vi.fn<NonNullable<VoiceoverDependencies['reportDiagnostic']>>(),
  } satisfies VoiceoverDependencies;
  const progress = {
    kind: 'progress',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    phase: AgentProgressPhase.SHOWING,
    locale: 'vi',
    presentationPending: true,
    teachingMessage: {
      lessonId: randomUUID(),
      stepId: randomUUID(),
      sequence: 1,
      kind: TeachingMessageKind.INSTRUCTION,
      text: 'Mở Chrome.',
    },
  } satisfies AgentProgress;
  const controller = new VoiceoverController(dependencies);
  controller.startTask(progress.sessionId);
  return { controller, dependencies, progress };
}

describe('HUD narration', () => {
  it('keeps setup outside the first-audio budget and reports a stalled provider without text', async () => {
    vi.useFakeTimers();
    const { controller, dependencies, progress } = createHarness();
    dependencies.sendPlayback.mockImplementation(async (command) => {
      if (command.kind === 'start') {
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      }
      return true;
    });
    dependencies.fetchSpeech.mockImplementation(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('Synthetic abort.'));
            },
            {
              once: true,
            },
          );
        }),
    );
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      await vi.advanceTimersByTimeAsync(600);
      expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4400);
      expect(dependencies.fetchSpeech.mock.calls[0]?.[1].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(VoiceoverLimits.FIRST_AUDIO_TIMEOUT_MS - 4400 - 1);
      expect(dependencies.fetchSpeech.mock.calls[0]?.[1].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(dependencies.reportDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: VoiceoverDiagnosticKind.TIMEOUT,
          stage: VoiceoverDiagnosticStage.REQUESTING_SPEECH,
          reason: VoiceoverDiagnosticReason.FIRST_AUDIO_TIMEOUT,
        }),
      );
      expect(dependencies.reportDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: VoiceoverDiagnosticKind.FAILED,
          reason: VoiceoverDiagnosticReason.FIRST_AUDIO_TIMEOUT,
        }),
      );
      expect(JSON.stringify(dependencies.reportDiagnostic.mock.calls)).not.toContain(
        progress.teachingMessage.text,
      );
    } finally {
      controller.clearTask();
      vi.useRealTimers();
    }
  });

  it('distinguishes deliberate interruption from a first-audio timeout', async () => {
    const { controller, dependencies, progress } = createHarness();
    dependencies.fetchSpeech.mockImplementation(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('Synthetic abort.'));
            },
            {
              once: true,
            },
          );
        }),
    );
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      await vi.waitFor(() => {
        expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
      });
      await controller.stopSpeaking();
      expect(dependencies.reportDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: VoiceoverDiagnosticKind.STOPPED,
          reason: 'interrupted',
          stage: VoiceoverDiagnosticStage.REQUESTING_SPEECH,
        }),
      );
      expect(
        dependencies.reportDiagnostic.mock.calls.some(
          ([event]) => event.kind === VoiceoverDiagnosticKind.TIMEOUT,
        ),
      ).toBe(false);
    } finally {
      controller.clearTask();
    }
  });

  it('defers microphone-busy instructions once and resumes the same visible message exactly once', async () => {
    const { controller, dependencies, progress } = createHarness();
    dependencies.canSpeak.mockReturnValue(false);
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      controller.receiveVisibleMessage(progress.teachingMessage);
      controller.resumeDeferredMessage();
      expect(dependencies.fetchSpeech).not.toHaveBeenCalled();
      expect(dependencies.reportDiagnostic).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          kind: VoiceoverDiagnosticKind.DEFERRED,
          stage: VoiceoverDiagnosticStage.ADMISSION,
          reason: VoiceoverDiagnosticReason.MICROPHONE_BUSY,
          utteranceId: null,
        }),
      );
      dependencies.canSpeak.mockReturnValue(true);
      controller.resumeDeferredMessage();
      controller.resumeDeferredMessage();
      await vi.waitFor(() => {
        expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
      });
      controller.receiveVisibleMessage(progress.teachingMessage);
      expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    } finally {
      controller.clearTask();
    }
  });

  it.each(['stop', 'hide', 'revoke', 'mute', 'locale', 'new task'] as const)(
    'does not revive microphone-deferred guidance after %s',
    async (action) => {
      const { controller, dependencies, progress } = createHarness();
      dependencies.canSpeak.mockReturnValue(false);
      try {
        controller.receiveProgress(progress);
        controller.receiveVisibleMessage(progress.teachingMessage);
        if (action === 'stop') {
          await controller.stopSpeaking();
        } else if (action === 'hide') {
          controller.receiveVisibleMessage(null);
        } else if (action === 'revoke') {
          controller.receiveProgress({ ...progress, presentationRevoked: true });
        } else if (action === 'mute') {
          controller.setEnabled(false);
          controller.setEnabled(true);
        } else if (action === 'locale') {
          controller.setLocale('en');
          controller.setLocale('vi');
        } else {
          controller.startTask(randomUUID());
        }
        dependencies.canSpeak.mockReturnValue(true);
        controller.resumeDeferredMessage();
        controller.receiveVisibleMessage(progress.teachingMessage);
        controller.receiveProgress(progress);
        expect(dependencies.fetchSpeech).not.toHaveBeenCalled();
      } finally {
        controller.clearTask();
      }
    },
  );

  it('resumes only the latest visible instruction after microphone readiness', async () => {
    const { controller, dependencies, progress } = createHarness();
    dependencies.canSpeak.mockReturnValue(false);
    const next = { ...progress, teachingMessage: { ...progress.teachingMessage, sequence: 2 } };
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      controller.receiveProgress(next);
      controller.receiveVisibleMessage(next.teachingMessage);
      dependencies.canSpeak.mockReturnValue(true);
      controller.resumeDeferredMessage();
      await vi.waitFor(() => {
        expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
      });
      expect(dependencies.fetchSpeech.mock.calls[0]?.[0].message.sequence).toBe(2);
    } finally {
      controller.clearTask();
    }
  });

  it('allows first audio later than five seconds after separate playback setup', async () => {
    vi.useFakeTimers();
    const { controller, dependencies, progress } = createHarness();
    const audio = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2]));
        stream.close();
      },
    });
    dependencies.sendPlayback.mockImplementation(async (command) => {
      if (command.kind === 'start') {
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      }
      return true;
    });
    dependencies.fetchSpeech.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(audio);
          }, 6500);
        }),
    );
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      await vi.advanceTimersByTimeAsync(7100);
      expect(dependencies.sendPlayback).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'chunk' }),
      );
      expect(dependencies.reportEvent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'playback_finished' }),
      );
      expect(dependencies.reportFailure).not.toHaveBeenCalled();
    } finally {
      controller.clearTask();
      vi.useRealTimers();
    }
  });

  it('bounds playback setup separately before dispatching paid speech', async () => {
    vi.useFakeTimers();
    const { controller, dependencies, progress } = createHarness();
    dependencies.sendPlayback.mockImplementation((command) =>
      command.kind === 'start' ? new Promise(() => {}) : Promise.resolve(true),
    );
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      await vi.advanceTimersByTimeAsync(
        VoiceoverLimits.STOP_TIMEOUT_MS + VoiceoverLimits.START_TIMEOUT_MS,
      );
      expect(dependencies.fetchSpeech).not.toHaveBeenCalled();
      expect(dependencies.reportDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: VoiceoverDiagnosticKind.TIMEOUT,
          stage: VoiceoverDiagnosticStage.STARTING_PLAYBACK,
          reason: VoiceoverDiagnosticReason.PLAYBACK_START_TIMEOUT,
        }),
      );
    } finally {
      controller.clearTask();
      vi.useRealTimers();
    }
  });

  it('retains the overall deadline after accepting first audio', async () => {
    vi.useFakeTimers();
    const { controller, dependencies, progress } = createHarness();
    dependencies.fetchSpeech.mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array([1, 2]));
        },
      }),
    );
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(VoiceoverLimits.MAX_DURATION_MS);
      expect(dependencies.reportDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: VoiceoverDiagnosticKind.TIMEOUT,
          stage: VoiceoverDiagnosticStage.PLAYING_AUDIO,
          reason: VoiceoverDiagnosticReason.DURATION_TIMEOUT,
        }),
      );
    } finally {
      controller.clearTask();
      vi.useRealTimers();
    }
  });

  it('locates a renderer startup rejection before any speech request', async () => {
    const { controller, dependencies, progress } = createHarness();
    dependencies.sendPlayback.mockImplementation((command) =>
      Promise.resolve(command.kind !== 'start'),
    );
    try {
      controller.receiveProgress(progress);
      controller.receiveVisibleMessage(progress.teachingMessage);
      await vi.waitFor(() => {
        expect(dependencies.reportFailure).toHaveBeenCalled();
      });
      expect(dependencies.fetchSpeech).not.toHaveBeenCalled();
      expect(dependencies.reportDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: VoiceoverDiagnosticKind.FAILED,
          stage: VoiceoverDiagnosticStage.STARTING_PLAYBACK,
          reason: VoiceoverDiagnosticReason.OPERATION_FAILED,
        }),
      );
    } finally {
      controller.clearTask();
    }
  });

  it('retains completion narration through missing and older native frames until audio drains', async () => {
    const { controller, dependencies, progress } = createHarness();
    let finishAudio: ((accepted: boolean) => void) | undefined;
    dependencies.sendPlayback.mockImplementation((command) =>
      command.kind === 'end'
        ? new Promise((resolve) => {
            finishAudio = resolve;
          })
        : Promise.resolve(true),
    );
    const completion = {
      ...progress,
      teachingMessage: {
        ...progress.teachingMessage,
        sequence: 2,
        kind: TeachingMessageKind.COMPLETION,
        text: 'Xong rồi. Bạn có thể bắt đầu đặt câu hỏi.',
      },
    };
    controller.receiveProgress(completion);
    controller.receiveVisibleMessage(completion.teachingMessage);
    try {
      await vi.waitFor(() => {
        expect(finishAudio).toBeTypeOf('function');
      });
      controller.receiveVisibleMessage(null);
      controller.receiveVisibleMessage(null);
      controller.receiveVisibleMessage(progress.teachingMessage);
      expect(dependencies.fetchSpeech.mock.calls[0]?.[1].aborted).toBe(false);
      expect(
        dependencies.sendPlayback.mock.calls.some(([command]) => command.kind === 'stop'),
      ).toBe(false);
      expect(dependencies.holdMessage).toHaveBeenLastCalledWith(completion.teachingMessage);
      expect(dependencies.reportEvent).toHaveBeenCalledOnce();
      expect(dependencies.reportEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'completion_retained', messageSequence: 2 }),
      );

      finishAudio?.(true);
      await vi.waitFor(() => {
        expect(dependencies.reportEvent).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'playback_finished' }),
        );
        expect(dependencies.holdMessage).toHaveBeenLastCalledWith(null);
      });
      expect(dependencies.reportEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'stopped', reason: 'completed' }),
      );
      controller.receiveVisibleMessage(completion.teachingMessage);
      expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    } finally {
      controller.clearTask();
    }
  });

  it.each(['stop', 'new task', 'new message'] as const)(
    'still interrupts a retained completion for %s',
    async (interruption) => {
      const { controller, dependencies, progress } = createHarness();
      dependencies.sendPlayback.mockImplementation((command) =>
        command.kind === 'end' ? new Promise(() => {}) : Promise.resolve(true),
      );
      const completion = {
        ...progress,
        teachingMessage: { ...progress.teachingMessage, kind: TeachingMessageKind.COMPLETION },
      };
      controller.receiveProgress(completion);
      controller.receiveVisibleMessage(completion.teachingMessage);
      try {
        await vi.waitFor(() => {
          expect(dependencies.sendPlayback).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'end' }),
          );
        });
        controller.receiveVisibleMessage(null);
        if (interruption === 'stop') {
          await controller.stopSpeaking();
        } else if (interruption === 'new task') {
          controller.startTask(randomUUID());
        } else {
          controller.receiveVisibleMessage({ ...completion.teachingMessage, sequence: 2 });
        }
        expect(dependencies.fetchSpeech.mock.calls[0]?.[1].aborted).toBe(true);
        expect(dependencies.sendPlayback).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'stop' }),
        );
        expect(dependencies.holdMessage).toHaveBeenLastCalledWith(null);
      } finally {
        controller.clearTask();
      }
    },
  );

  it('still cancels instruction narration when its native message disappears', async () => {
    const { controller, dependencies, progress } = createHarness();
    dependencies.sendPlayback.mockImplementation((command) =>
      command.kind === 'end' ? new Promise(() => {}) : Promise.resolve(true),
    );
    controller.receiveProgress(progress);
    controller.receiveVisibleMessage(progress.teachingMessage);
    try {
      await vi.waitFor(() => {
        expect(dependencies.sendPlayback).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'end' }),
        );
      });
      controller.receiveVisibleMessage(null);
      expect(dependencies.fetchSpeech.mock.calls[0]?.[1].aborted).toBe(true);
      expect(dependencies.reportEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'stopped', reason: 'message_hidden' }),
      );
    } finally {
      controller.clearTask();
    }
  });

  it('waits for the matching visible message, preserves split PCM samples and reads duplicates once', async () => {
    const { controller, dependencies, progress } = createHarness();
    controller.receiveProgress(progress);
    expect(dependencies.fetchSpeech).not.toHaveBeenCalled();
    controller.receiveVisibleMessage(progress.teachingMessage);
    await vi.waitFor(() => {
      expect(dependencies.sendPlayback).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'end' }),
      );
    });
    controller.receiveProgress(progress);
    controller.receiveVisibleMessage(progress.teachingMessage);
    expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    expect(dependencies.fetchSpeech.mock.calls[0]?.[0]).toMatchObject({
      message: progress.teachingMessage,
      locale: 'vi',
    });
    expect(dependencies.sendPlayback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chunk', pcm: new Uint8Array([1, 2, 3, 4]) }),
    );
    controller.clearTask();
  });

  it('aborts pending generation before capture and ignores stale task events', async () => {
    const { controller, dependencies, progress } = createHarness();
    dependencies.fetchSpeech.mockImplementation(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('Canceled'));
            },
            { once: true },
          );
        }),
    );
    controller.receiveVisibleMessage(progress.teachingMessage);
    controller.receiveProgress(progress);
    await vi.waitFor(() => {
      expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    });
    expect(await controller.stopSpeaking()).toBe(true);
    expect(dependencies.fetchSpeech.mock.calls[0]?.[1].aborted).toBe(true);
    dependencies.canSpeak.mockReturnValue(false);
    const duringCapture = {
      ...progress,
      teachingMessage: { ...progress.teachingMessage, sequence: 2 },
    };
    controller.receiveProgress(duringCapture);
    controller.receiveVisibleMessage(duringCapture.teachingMessage);
    expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    dependencies.canSpeak.mockReturnValue(true);
    controller.setLocale('en');
    controller.receiveProgress({
      ...progress,
      teachingMessage: { ...progress.teachingMessage, sequence: 2 },
    });
    expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    controller.startTask(randomUUID());
    controller.receiveProgress(progress);
    controller.receiveVisibleMessage(progress.teachingMessage);
    expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    controller.clearTask();
  });

  it('does not speak when muted and recovers from a provider failure without retry', async () => {
    const { controller, dependencies, progress } = createHarness();
    controller.setEnabled(false);
    controller.receiveProgress(progress);
    controller.receiveVisibleMessage(progress.teachingMessage);
    expect(dependencies.fetchSpeech).not.toHaveBeenCalled();
    controller.setEnabled(true);
    const next = { ...progress, teachingMessage: { ...progress.teachingMessage, sequence: 2 } };
    dependencies.fetchSpeech.mockRejectedValue(new Error('Synthetic failure'));
    controller.receiveProgress(next);
    controller.receiveVisibleMessage(next.teachingMessage);
    await vi.waitFor(() => {
      expect(dependencies.showStatus).toHaveBeenCalledWith({ state: VoiceoverState.UNAVAILABLE });
    });
    expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();
    controller.clearTask();
  });

  it('revokes active speech and blocks late polls without stopping a newer instruction', async () => {
    const { controller, dependencies, progress } = createHarness();
    dependencies.fetchSpeech.mockImplementation(() =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array([1, 2]));
          },
        }),
      ),
    );
    controller.receiveProgress(progress);
    controller.receiveVisibleMessage(progress.teachingMessage);
    await vi.waitFor(() => {
      expect(dependencies.showStatus).toHaveBeenCalledWith({ state: VoiceoverState.SPEAKING });
    });
    const revoked = { ...progress, presentationPending: false, presentationRevoked: true };
    controller.receiveProgress(revoked);
    expect(dependencies.fetchSpeech.mock.calls[0]?.[1].aborted).toBe(true);
    expect(dependencies.sendPlayback).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stop' }),
    );
    expect(dependencies.holdMessage).toHaveBeenLastCalledWith(null);
    controller.receiveVisibleMessage(progress.teachingMessage);
    controller.receiveProgress({ ...progress, presentationPending: false });
    expect(dependencies.fetchSpeech).toHaveBeenCalledOnce();

    const next = { ...progress, teachingMessage: { ...progress.teachingMessage, sequence: 2 } };
    controller.receiveProgress(next);
    controller.receiveVisibleMessage(next.teachingMessage);
    await vi.waitFor(() => {
      expect(dependencies.fetchSpeech).toHaveBeenCalledTimes(2);
    });
    controller.receiveProgress(revoked);
    controller.receiveProgress({
      ...revoked,
      sessionId: randomUUID(),
      teachingMessage: next.teachingMessage,
    });
    expect(dependencies.fetchSpeech.mock.calls[1]?.[1].aborted).toBe(false);
    controller.clearTask();
  });

  it('does not start a revoked candidate when its native frame is reported late', () => {
    const { controller, dependencies, progress } = createHarness();
    controller.receiveProgress(progress);
    controller.receiveProgress({ ...progress, presentationRevoked: true });
    controller.receiveVisibleMessage(progress.teachingMessage);
    controller.receiveProgress(progress);
    expect(dependencies.fetchSpeech).not.toHaveBeenCalled();
    controller.clearTask();
  });
});
