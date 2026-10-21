import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { TeachingMessageKind } from '#contracts/TeachingStep.js';
import { VoiceoverLimits, VoiceoverState } from '#contracts/Voiceover.js';
import { VoiceoverController } from '../src/desktop/main/voiceover/VoiceoverController.js';
import {
  VoiceoverDiagnosticKind,
  VoiceoverDiagnosticReason,
  VoiceoverDiagnosticStage,
  type VoiceoverDiagnostic,
} from '../src/desktop/main/voiceover/VoiceoverDiagnostics.js';
import { registerVoiceoverRoutes } from '../src/server/features/voiceover/RegisterVoiceoverRoutes.js';
import type { SpeechProvider } from '../src/server/features/voiceover/VoiceoverPorts.js';

interface DiagnosticCase {
  name: string;
  providerDelayMs: number;
  setupDelayMs: number;
  stopAfterMs?: number;
  hideAfterMs?: number;
  microphoneBusy?: boolean;
  rejectPlayback?: boolean;
  streamTailDelayMs?: number;
  expectedTimeout?: VoiceoverDiagnostic['reason'];
}

interface CaseReport {
  name: string;
  passed: boolean;
  speechRequests: number;
  pcmChunksAccepted: number;
  requestElapsedMs: number | null;
  cause: string;
}

const directory = resolve('.tro-development/voiceover-diagnostics');
const logs: string[] = [];
const reports: CaseReport[] = [];

/** The controller, real HTTP transport and backend route are real; speech, auth,
 * allowance and renderer acknowledgments are synthetic. No hardware or paid calls. */
async function runCase(testCase: DiagnosticCase): Promise<void> {
  const startedAt = performance.now();
  const events: VoiceoverDiagnostic[] = [];
  let speechRequests = 0;
  let pcmChunksAccepted = 0;
  let microphoneBusy = testCase.microphoneBusy ?? false;
  const measurement: { terminal: boolean; requestElapsedMs: number | null } = {
    terminal: false,
    requestElapsedMs: null,
  };
  let requestStartedAt: number | null = null;

  function record(event: Record<string, unknown>): void {
    logs.push(
      JSON.stringify({
        case: testCase.name,
        atMs: Math.round(performance.now() - startedAt),
        ...event,
      }),
    );
  }

  const provider: SpeechProvider = {
    isAvailable: () => true,
    async streamSpeech(request, signal) {
      record({ event: 'provider.requested', utteranceId: request.utteranceId });
      try {
        await delay(testCase.providerDelayMs, undefined, { signal });
      } catch {
        record({ event: 'provider.aborted_before_audio', utteranceId: request.utteranceId });
        throw new Error('Synthetic provider aborted.');
      }
      let chunks = 0;
      return new ReadableStream<Uint8Array>({
        async pull(stream) {
          if (chunks++ === 0) {
            record({ event: 'provider.first_pcm', utteranceId: request.utteranceId });
            stream.enqueue(new Uint8Array([0, 0, 1, 0]));
          } else {
            await delay(testCase.streamTailDelayMs ?? 0, undefined, { signal });
            stream.close();
          }
        },
      });
    },
  };
  const api = Fastify();
  api.addHook('onRequest', async (request, reply) => {
    record({ event: 'http.request_received', requestId: request.id });
    reply.raw.once('close', () => {
      record({
        event: 'http.connection_closed',
        requestId: request.id,
        responseFinished: reply.raw.writableFinished,
      });
    });
  });
  registerVoiceoverRoutes(
    api,
    () => Promise.resolve('local-synthetic-user'),
    {
      reserveVoiceover: () => Promise.resolve(true),
      finishVoiceover: () => Promise.resolve(),
    },
    provider,
  );
  const address = await api.listen({ host: '127.0.0.1', port: 0 });
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
      text: 'Synthetic local instruction.',
    },
  } satisfies AgentProgress;
  const controller = new VoiceoverController({
    canSpeak: () => !microphoneBusy,
    async fetchSpeech(request, signal) {
      speechRequests++;
      requestStartedAt = performance.now();
      signal.addEventListener(
        'abort',
        () => {
          measurement.requestElapsedMs = Math.round(
            performance.now() - (requestStartedAt ?? performance.now()),
          );
          record({
            event: 'http.client_signal_aborted',
            utteranceId: request.utteranceId,
            requestElapsedMs: measurement.requestElapsedMs,
          });
        },
        { once: true },
      );
      const response = await fetch(`${address}/api/v1/voiceover/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      record({
        event: 'http.headers_received',
        utteranceId: request.utteranceId,
        status: response.status,
      });
      assert.ok(response.ok && response.body, 'Local speech route must return an audio stream.');
      return response.body;
    },
    async sendPlayback(command) {
      if (command.kind === 'start') {
        await delay(testCase.setupDelayMs);
        return !testCase.rejectPlayback;
      }
      if (command.kind === 'chunk') {
        pcmChunksAccepted++;
      }
      return true;
    },
    showStatus(status) {
      record({ event: 'desktop.status', state: status.state });
      if (status.state === VoiceoverState.UNAVAILABLE) {
        measurement.terminal = true;
      }
    },
    holdMessage() {},
    reportFailure(stage) {
      record({ event: 'desktop.failure', stage });
    },
    reportEvent(event) {
      record({ event: `desktop.${event.kind}`, ...event });
      if (event.kind === 'stopped') {
        measurement.terminal = true;
      }
    },
    reportDiagnostic(event) {
      events.push(event);
      record({ event: 'voiceover.diagnostic', ...event });
    },
  });
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let passed = false;
  let cause = 'unclassified';
  try {
    controller.startTask(progress.sessionId);
    controller.receiveProgress(progress);
    controller.receiveVisibleMessage(progress.teachingMessage);
    if (testCase.stopAfterMs !== undefined) {
      stopTimer = setTimeout(() => {
        void controller.stopSpeaking();
      }, testCase.stopAfterMs);
    }
    if (testCase.hideAfterMs !== undefined) {
      hideTimer = setTimeout(() => {
        controller.receiveVisibleMessage(null);
      }, testCase.hideAfterMs);
    }
    if (testCase.microphoneBusy) {
      assert.equal(speechRequests, 0);
      assert.ok(events.some((event) => event.reason === VoiceoverDiagnosticReason.MICROPHONE_BUSY));
      microphoneBusy = false;
      controller.resumeDeferredMessage();
      record({ event: 'harness.microphone_ready_resume_current_message' });
    }
    const deadline =
      performance.now() +
      VoiceoverLimits.STOP_TIMEOUT_MS +
      VoiceoverLimits.START_TIMEOUT_MS +
      VoiceoverLimits.FIRST_AUDIO_TIMEOUT_MS +
      2000;
    while (!measurement.terminal) {
      assert.ok(
        performance.now() < deadline,
        'Local case must finish within its bounded deadlines.',
      );
      await delay(10);
    }
    await delay(50);
    const timeout = events.find((event) => event.kind === VoiceoverDiagnosticKind.TIMEOUT);
    if (testCase.stopAfterMs !== undefined || testCase.hideAfterMs !== undefined) {
      assert.equal(timeout, undefined);
      cause = testCase.hideAfterMs !== undefined ? 'message_hidden' : 'interrupted';
      assert.ok(
        events.some(
          (event) => event.kind === VoiceoverDiagnosticKind.STOPPED && event.reason === cause,
        ),
      );
      assert.equal(pcmChunksAccepted, 0);
    } else if (testCase.rejectPlayback) {
      assert.equal(speechRequests, 0);
      assert.ok(
        events.some(
          (event) =>
            event.kind === VoiceoverDiagnosticKind.FAILED &&
            event.stage === VoiceoverDiagnosticStage.STARTING_PLAYBACK,
        ),
      );
      cause = 'renderer_start_rejected';
    } else if (testCase.expectedTimeout) {
      assert.ok(timeout);
      assert.equal(timeout.reason, testCase.expectedTimeout);
      assert.equal(pcmChunksAccepted, 0);
      if (testCase.expectedTimeout === VoiceoverDiagnosticReason.PLAYBACK_START_TIMEOUT) {
        assert.equal(timeout.stage, VoiceoverDiagnosticStage.STARTING_PLAYBACK);
        assert.equal(speechRequests, 0);
        cause = 'playback_setup_timeout';
      } else {
        assert.equal(timeout.stage, VoiceoverDiagnosticStage.REQUESTING_SPEECH);
        assert.ok(measurement.requestElapsedMs !== null);
        assert.ok(measurement.requestElapsedMs >= VoiceoverLimits.FIRST_AUDIO_TIMEOUT_MS - 100);
        assert.ok(
          timeout.elapsedMs - measurement.requestElapsedMs >= 500,
          'Playback setup must be outside the first-audio budget.',
        );
        cause = 'first_audio_timeout';
      }
    } else {
      assert.equal(timeout, undefined);
      assert.equal(speechRequests, 1);
      assert.ok(pcmChunksAccepted > 0);
      assert.ok(
        events.some(
          (event) => event.kind === VoiceoverDiagnosticKind.STOPPED && event.reason === 'completed',
        ),
      );
      cause = testCase.microphoneBusy
        ? 'deferred_message_spoken'
        : testCase.streamTailDelayMs !== undefined
          ? 'completed_after_original_startup_deadline'
          : 'slow_first_audio_recovered';
    }
    passed = true;
  } finally {
    clearTimeout(stopTimer);
    clearTimeout(hideTimer);
    controller.clearTask();
    await delay(30);
    await api.close();
    reports.push({
      name: testCase.name,
      passed,
      speechRequests,
      pcmChunksAccepted,
      requestElapsedMs: measurement.requestElapsedMs,
      cause,
    });
  }
}

await mkdir(directory, { recursive: true });
try {
  for (const testCase of [
    {
      name: 'slow first audio after 600ms playback setup',
      providerDelayMs: 6500,
      setupDelayMs: 600,
    },
    {
      name: 'stalled provider retains full independent first-audio budget',
      providerDelayMs: VoiceoverLimits.FIRST_AUDIO_TIMEOUT_MS + 1000,
      setupDelayMs: 600,
      expectedTimeout: VoiceoverDiagnosticReason.FIRST_AUDIO_TIMEOUT,
    },
    {
      name: 'stalled renderer has a separate bounded setup deadline',
      providerDelayMs: 0,
      setupDelayMs: VoiceoverLimits.STOP_TIMEOUT_MS + VoiceoverLimits.START_TIMEOUT_MS + 1000,
      expectedTimeout: VoiceoverDiagnosticReason.PLAYBACK_START_TIMEOUT,
    },
    {
      name: 'explicit stop during slow generation',
      providerDelayMs: 6500,
      setupDelayMs: 0,
      stopAfterMs: 4500,
    },
    {
      name: 'visible instruction disappears',
      providerDelayMs: 6500,
      setupDelayMs: 0,
      hideAfterMs: 100,
    },
    {
      name: 'microphone busy then ready',
      providerDelayMs: 0,
      setupDelayMs: 0,
      microphoneBusy: true,
    },
    {
      name: 'renderer rejects playback startup',
      providerDelayMs: 0,
      setupDelayMs: 0,
      rejectPlayback: true,
    },
    {
      name: 'first PCM fast but stream lasts beyond five seconds',
      providerDelayMs: 20,
      setupDelayMs: 0,
      streamTailDelayMs: 5500,
    },
  ] satisfies DiagnosticCase[]) {
    await runCase(testCase);
    console.info('voiceover.reproduction', reports.at(-1));
  }
} finally {
  await writeFile(resolve(directory, 'VoiceoverEvents.jsonl'), logs.join('\n') + '\n');
  await writeFile(
    resolve(directory, 'VoiceoverReport.json'),
    JSON.stringify(
      {
        scope:
          'Real controller, loopback HTTP and backend route; synthetic provider, auth, allowance and renderer. No hardware playback or production-cause proof.',
        cases: reports,
      },
      null,
      2,
    ) + '\n',
  );
}
