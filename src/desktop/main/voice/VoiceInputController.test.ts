import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceShortcut, type VoiceEvent } from '#contracts/VoiceInput.js';
import { TranscriptionEventKind, type TranscriptionEvent } from '#contracts/Transcription.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { VoiceInputController, type VoiceDependencies } from './VoiceInputController.js';
import type { TranscriptionConnection } from './TranscriptionClient.js';
import { sendVoiceEventToWindow } from './VoiceEventDelivery.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const controllers: VoiceInputController[] = [];

function createHarness() {
  const events: VoiceEvent[] = [];
  let receive: ((event: TranscriptionEvent) => void) | null = null;
  const connection = {
    sendCommand: vi.fn<TranscriptionConnection['sendCommand']>(),
    close: vi.fn<() => void>(),
  };
  const dependencies = {
    releaseUnusedCredential: vi
      .fn<VoiceDependencies['releaseUnusedCredential']>()
      .mockResolvedValue(),
    readSession: vi.fn<VoiceDependencies['readSession']>().mockResolvedValue({
      kind: 'signed-in',
      user: { id: 'user', name: 'Test', email: 'test@example.test' },
    }),
    fetchCredential: vi.fn<VoiceDependencies['fetchCredential']>().mockResolvedValue({
      token: 'synthetic',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    connect: vi.fn<VoiceDependencies['connect']>().mockImplementation((_token, emit) => {
      receive = emit;
      return connection;
    }),
    isAgentBusy: vi.fn<VoiceDependencies['isAgentBusy']>().mockReturnValue(false),
    areTriggerKeysReleased: vi
      .fn<VoiceDependencies['areTriggerKeysReleased']>()
      .mockReturnValue(true),
    startAgentSession: vi
      .fn<VoiceDependencies['startAgentSession']>()
      .mockResolvedValue({ kind: 'started', sessionId }),
    sendAgentMessage: vi
      .fn<VoiceDependencies['sendAgentMessage']>()
      .mockResolvedValue({ kind: 'completed', answer: 'Done' }),
    emit: (event: VoiceEvent): void => {
      events.push(event);
    },
  } satisfies VoiceDependencies;
  const controller = new VoiceInputController(dependencies, VoiceShortcut.COMMAND_CONTROL);
  controllers.push(controller);
  controller.enableVoiceInput(VoiceShortcut.COMMAND_CONTROL, true);

  function emit(event: TranscriptionEvent): void {
    if (!receive) {
      throw new Error('No capture connection.');
    }
    receive(event);
  }

  async function startCapture(
    locale: DesktopLocale = DesktopLocale.VIETNAMESE,
    mode: AgentTaskMode = AgentTaskMode.EXECUTE,
  ): Promise<string> {
    controller.startVoiceCapture();
    const prepared = [...events].reverse().find((event) => event.kind === 'prepare');
    if (!prepared) {
      throw new Error('No preparation request.');
    }
    await controller.prepareVoiceCapture(prepared.captureId, locale, mode);
    emit({ kind: TranscriptionEventKind.READY });
    return prepared.captureId;
  }

  return { events, dependencies, controller, connection, emit, startCapture };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.disableVoiceInput());
});

describe('voice instruction admission', () => {
  it.each(['window', 'webContents'])(
    'finishes capture cleanup after the %s is destroyed',
    async (destroyedObject) => {
      const harness = createHarness();
      const captureId = await harness.startCapture();
      let destroyed = false;
      const send = vi.fn<(channel: 'tro:voice-event', event: VoiceEvent) => void>(() => {
        if (destroyed) {
          throw new Error('Object has been destroyed');
        }
      });
      const window = {
        isDestroyed: () => destroyed && destroyedObject === 'window',
        get webContents() {
          if (destroyed && destroyedObject === 'window') {
            throw new Error('Object has been destroyed');
          }
          return { isDestroyed: () => destroyed, send };
        },
      };
      harness.dependencies.emit = (event) => {
        sendVoiceEventToWindow(window, event);
      };
      harness.controller.releaseVoiceCapture();
      expect(send).toHaveBeenCalledWith(
        'tro:voice-event',
        expect.objectContaining({ kind: 'release' }),
      );
      send.mockClear();
      destroyed = true;
      expect(() => {
        harness.controller.invalidateVoiceInput();
      }).not.toThrow();
      expect(harness.controller.readStatus().state).toBe('disabled');
      expect(harness.connection.close).toHaveBeenCalledOnce();
      expect(harness.dependencies.releaseUnusedCredential).toHaveBeenCalledWith(captureId);
      harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Late result' });
      expect(send).not.toHaveBeenCalled();
      expect(harness.dependencies.startAgentSession).not.toHaveBeenCalled();
    },
  );

  it('streams in order and submits the final Unicode instruction once after release and flush', async () => {
    const harness = createHarness();
    const captureId = await harness.startCapture();
    expect(harness.dependencies.fetchCredential).toHaveBeenCalledWith(captureId, 'vi');
    harness.controller.appendVoiceAudio({ captureId, sequence: 0, pcm: new Uint8Array(960) });
    harness.emit({ kind: TranscriptionEventKind.PREVIEW, text: 'Mở' });
    expect(harness.dependencies.sendAgentMessage).not.toHaveBeenCalled();
    harness.controller.releaseVoiceCapture();
    harness.controller.appendVoiceAudio({ captureId, sequence: 1, pcm: new Uint8Array(128) });
    harness.controller.finishVoiceAudio(captureId, 1);
    expect(harness.connection.sendCommand.mock.calls.map(([command]) => command.kind)).toEqual([
      'audio',
      'audio',
      'finish',
    ]);
    harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Mở Chrome, đừng gửi email.' });
    harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Duplicate' });
    await vi.waitFor(() => {
      expect(harness.dependencies.sendAgentMessage).toHaveBeenCalledTimes(1);
    });
    expect(harness.dependencies.sendAgentMessage).toHaveBeenCalledWith(
      sessionId,
      'Mở Chrome, đừng gửi email.',
      DesktopLocale.VIETNAMESE,
      AgentTaskMode.EXECUTE,
    );
    expect(harness.events.filter((event) => event.kind === 'submitted')).toHaveLength(1);
    expect(harness.events.filter((event) => event.kind === 'result')).toHaveLength(1);
  });

  it.each([AgentTaskMode.EXECUTE, AgentTaskMode.TEACH])(
    'preserves capture locale and %s mode for the agent',
    async (mode) => {
      const harness = createHarness();
      for (const locale of [DesktopLocale.VIETNAMESE, DesktopLocale.ENGLISH]) {
        const captureId = await harness.startCapture(locale, mode);
        expect(harness.dependencies.fetchCredential).toHaveBeenLastCalledWith(captureId, locale);
        harness.controller.releaseVoiceCapture();
        harness.controller.finishVoiceAudio(captureId, -1);
        harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'YouTube' });
        await vi.waitFor(() => {
          expect(harness.controller.readStatus().state).toBe('idle');
        });
        expect(harness.dependencies.sendAgentMessage).toHaveBeenLastCalledWith(
          sessionId,
          'YouTube',
          locale,
          mode,
        );
      }
    },
  );

  it('waits for the remaining modifier to release before starting the agent', async () => {
    const harness = createHarness();
    const captureId = await harness.startCapture();
    harness.dependencies.areTriggerKeysReleased.mockReturnValue(false);
    harness.controller.releaseVoiceCapture();
    harness.controller.finishVoiceAudio(captureId, -1);
    harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Open Chrome' });
    harness.emit({
      kind: TranscriptionEventKind.FINAL,
      text: 'Duplicate must not replace the instruction',
    });
    expect(harness.dependencies.startAgentSession).not.toHaveBeenCalled();
    harness.dependencies.areTriggerKeysReleased.mockReturnValue(true);
    harness.controller.notifyKeysReleased();
    await vi.waitFor(() => {
      expect(harness.dependencies.sendAgentMessage).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects late completion after cancellation, invalid frame order, and busy activation', async () => {
    const harness = createHarness();
    const captureId = await harness.startCapture();
    expect(
      harness.controller.appendVoiceAudio({ captureId, sequence: 3, pcm: new Uint8Array(960) })
        .kind,
    ).toBe('failed');
    harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Do not execute' });
    expect(harness.dependencies.sendAgentMessage).not.toHaveBeenCalled();
    harness.dependencies.isAgentBusy.mockReturnValue(true);
    expect(harness.controller.startVoiceCapture().kind).toBe('failed');
  });

  it('cancels credential acquisition and does not connect late', async () => {
    const harness = createHarness();
    let resolveCredential:
      ((credential: Awaited<ReturnType<VoiceDependencies['fetchCredential']>>) => void) | undefined;
    harness.dependencies.fetchCredential.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCredential = resolve;
        }),
    );
    harness.controller.startVoiceCapture();
    const prepared = harness.events.find((event) => event.kind === 'prepare');
    if (!prepared) {
      throw new Error('Missing capture.');
    }
    const preparation = harness.controller.prepareVoiceCapture(prepared.captureId, 'en');
    await vi.waitFor(() => {
      expect(resolveCredential).toBeDefined();
    });
    harness.controller.cancelVoiceCapture();
    resolveCredential?.({ token: 'synthetic', expiresAt: new Date().toISOString() });
    await preparation;
    expect(harness.dependencies.connect).not.toHaveBeenCalled();
    expect(harness.dependencies.releaseUnusedCredential).toHaveBeenCalledWith(prepared.captureId);
  });

  it('rejects completion before finish and a changed account after finish', async () => {
    const harness = createHarness();
    await harness.startCapture();
    harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Premature' });
    expect(harness.dependencies.sendAgentMessage).not.toHaveBeenCalled();
    const captureId = await harness.startCapture();
    harness.controller.releaseVoiceCapture();
    harness.controller.finishVoiceAudio(captureId, -1);
    harness.dependencies.readSession.mockResolvedValue({ kind: 'signed-out' });
    harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Stale account' });
    await vi.waitFor(() => {
      expect(harness.controller.readStatus().state).toBe('idle');
    });
    expect(harness.dependencies.sendAgentMessage).not.toHaveBeenCalled();
  });
});

it('finalizes captured speech when release happens before the relay is ready', async () => {
  const harness = createHarness();
  harness.controller.startVoiceCapture();
  const prepared = harness.events.find((event) => event.kind === 'prepare');
  if (!prepared) {
    throw new Error('Missing capture.');
  }
  await harness.controller.prepareVoiceCapture(prepared.captureId, 'en');
  harness.controller.releaseVoiceCapture();
  expect(harness.controller.readStatus().state).toBe('finalizing');
  harness.emit({ kind: TranscriptionEventKind.READY });
  expect(harness.controller.readStatus().state).toBe('finalizing');
  harness.controller.appendVoiceAudio({
    captureId: prepared.captureId,
    sequence: 0,
    pcm: new Uint8Array(960),
  });
  harness.controller.finishVoiceAudio(prepared.captureId, 0);
  harness.emit({ kind: TranscriptionEventKind.FINAL, text: 'Open Chrome' });
  await vi.waitFor(() => {
    expect(harness.dependencies.sendAgentMessage).toHaveBeenCalledWith(
      sessionId,
      'Open Chrome',
      DesktopLocale.ENGLISH,
      AgentTaskMode.EXECUTE,
    );
  });
});
