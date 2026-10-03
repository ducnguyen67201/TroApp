import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  VoiceoverController,
  type VoiceoverDependencies,
} from '../../../../src/desktop/main/voiceover/VoiceoverController.js';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { TeachingMessageKind } from '#contracts/TeachingStep.js';
import { VoiceoverState } from '#contracts/Voiceover.js';

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
