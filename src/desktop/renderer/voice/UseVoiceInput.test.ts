// @vitest-environment happy-dom
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  VoiceShortcut,
  VoiceState,
  type VoiceEvent,
  type VoiceReply,
} from '#contracts/VoiceInput.js';
import { LocaleProvider } from '../localization/LocaleProvider.js';
import { useLocale } from '../localization/UseLocale.js';
import { localeStorageKey } from '../localization/Locale.js';
import { useVoiceInput } from './UseVoiceInput.js';

const doubles = vi.hoisted(() => {
  const append: Array<(pcm: Uint8Array) => void> = [];
  return {
    append,
    dispose: vi.fn<() => void>(),
    flush: vi.fn<() => Promise<void>>().mockResolvedValue(),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
});

vi.mock('./VoiceAudioCapture.js', () => ({
  VoiceAudioCapture: class {
    constructor(appendFrame: (pcm: Uint8Array) => void) {
      doubles.append.push(appendFrame);
    }
    startCapture = doubles.start;
    flushCapture = doubles.flush;
    dispose = doubles.dispose;
  },
}));

function createBridge() {
  return {
    controlVoiceInput: vi.fn<DesktopBridge['controlVoiceInput']>().mockResolvedValue({
      kind: 'ok',
      status: { state: 'idle', shortcut: 'command-control', globalShortcutAvailable: true },
    }),
    appendVoiceAudio: vi.fn<DesktopBridge['appendVoiceAudio']>().mockResolvedValue({
      kind: 'ok',
      status: { state: 'recording', shortcut: 'command-control', globalShortcutAvailable: true },
    }),
    subscribeVoiceInput: vi.fn<DesktopBridge['subscribeVoiceInput']>().mockReturnValue(() => {}),
    readAuthSession: vi
      .fn<DesktopBridge['readAuthSession']>()
      .mockResolvedValue({ kind: 'signed-out' }),
    signInWithGoogle: vi
      .fn<DesktopBridge['signInWithGoogle']>()
      .mockResolvedValue({ kind: 'signed-out' }),
    signOut: vi.fn<DesktopBridge['signOut']>().mockResolvedValue({ kind: 'signed-out' }),
    readDesktopPermissions: vi
      .fn<DesktopBridge['readDesktopPermissions']>()
      .mockResolvedValue({ kind: 'ready', accessibility: 'granted', screenRecording: 'granted' }),
    requestDesktopPermissions: vi
      .fn<DesktopBridge['requestDesktopPermissions']>()
      .mockResolvedValue({ kind: 'opened' }),
    openDesktopPermissionSettings: vi
      .fn<DesktopBridge['openDesktopPermissionSettings']>()
      .mockResolvedValue({ kind: 'opened' }),
    startCursorCompanion: vi
      .fn<DesktopBridge['startCursorCompanion']>()
      .mockResolvedValue({ kind: 'started', sessionId: '11111111-1111-4111-8111-111111111111' }),
    startAgentSession: vi
      .fn<DesktopBridge['startAgentSession']>()
      .mockResolvedValue({ kind: 'stopped' }),
    sendAgentMessage: vi
      .fn<DesktopBridge['sendAgentMessage']>()
      .mockResolvedValue({ kind: 'stopped' }),
    stopAgentSession: vi
      .fn<DesktopBridge['stopAgentSession']>()
      .mockResolvedValue({ kind: 'stopped' }),
  } satisfies DesktopBridge;
}

const firstId = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(LocaleProvider, { children });
}

beforeEach(() => {
  window.localStorage.clear();
  doubles.append.splice(0);
  doubles.dispose.mockClear();
  doubles.flush.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('locale-driven voice capture', () => {
  it('starts automatically after sign-in using the main-process platform shortcut, without opening the microphone', async () => {
    const bridge = createBridge();
    bridge.controlVoiceInput.mockImplementation((command) =>
      Promise.resolve<VoiceReply>({
        kind: 'ok',
        status: {
          state: command.kind === 'enable' ? VoiceState.IDLE : VoiceState.DISABLED,
          shortcut: VoiceShortcut.CONTROL_ALT,
          globalShortcutAvailable: command.kind === 'enable',
        },
      }),
    );
    window.tro = bridge;
    const startsBefore = doubles.start.mock.calls.length;
    const initialProps: { userId: string | null } = { userId: null };
    const { result, rerender } = renderHook(
      ({ userId }: { userId: string | null }) => ({
        locale: useLocale(),
        voice: useVoiceInput(userId, () => {}),
      }),
      { wrapper, initialProps },
    );
    await waitFor(() => {
      expect(bridge.controlVoiceInput).toHaveBeenCalledWith({ kind: 'status' });
    });
    expect(bridge.controlVoiceInput.mock.calls.some(([command]) => command.kind === 'enable')).toBe(
      false,
    );
    rerender({ userId: 'user' });
    await waitFor(() => {
      expect(result.current.voice.status.state).toBe(VoiceState.IDLE);
    });
    expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
      kind: 'enable',
      shortcut: VoiceShortcut.CONTROL_ALT,
    });
    act(() => {
      result.current.locale.changeLocale('en');
    });
    expect(
      bridge.controlVoiceInput.mock.calls.filter(([command]) => command.kind === 'enable'),
    ).toHaveLength(1);
    expect(doubles.start.mock.calls).toHaveLength(startsBefore);
    rerender({ userId: null });
    await waitFor(() => {
      expect(result.current.voice.status.state).toBe(VoiceState.DISABLED);
    });
    expect(bridge.controlVoiceInput).toHaveBeenCalledWith({ kind: 'disable' });
  });

  it('ignores an automatic startup reply that arrives after sign-out', async () => {
    const bridge = createBridge();
    let resolveEnable: (reply: VoiceReply) => void = () => {};
    const enabling = new Promise<VoiceReply>((resolve) => {
      resolveEnable = resolve;
    });
    bridge.controlVoiceInput.mockImplementation(async (command) => {
      if (command.kind === 'enable') {
        return enabling;
      }
      return {
        kind: 'ok',
        status: {
          state: VoiceState.DISABLED,
          shortcut: VoiceShortcut.COMMAND_CONTROL,
          globalShortcutAvailable: false,
        },
      };
    });
    window.tro = bridge;
    const initialProps: { userId: string | null } = { userId: 'user' };
    const { result, rerender } = renderHook(
      ({ userId }: { userId: string | null }) => useVoiceInput(userId, () => {}),
      { wrapper, initialProps },
    );
    await waitFor(() => {
      expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
        kind: 'enable',
        shortcut: VoiceShortcut.COMMAND_CONTROL,
      });
    });
    rerender({ userId: null });
    await act(async () => {
      resolveEnable({
        kind: 'ok',
        status: {
          state: VoiceState.IDLE,
          shortcut: VoiceShortcut.COMMAND_CONTROL,
          globalShortcutAvailable: true,
        },
      });
      await enabling;
    });
    expect(result.current.status.state).toBe(VoiceState.DISABLED);
    expect(result.current.isStarting).toBe(false);
  });

  it('lets the workspace retry startup after microphone permission is denied', async () => {
    const bridge = createBridge();
    let attempts = 0;
    bridge.controlVoiceInput.mockImplementation((command) => {
      if (command.kind === 'enable') {
        attempts += 1;
        if (attempts === 1) {
          return Promise.resolve<VoiceReply>({ kind: 'failed' });
        }
      }
      return Promise.resolve<VoiceReply>({
        kind: 'ok',
        status: {
          state: command.kind === 'enable' ? VoiceState.IDLE : VoiceState.DISABLED,
          shortcut: VoiceShortcut.COMMAND_CONTROL,
          globalShortcutAvailable: command.kind === 'enable',
        },
      });
    });
    window.tro = bridge;
    const { result } = renderHook(() => useVoiceInput('user', () => {}), { wrapper });
    await waitFor(() => {
      expect(result.current.error).toBe(true);
    });
    await act(async () => {
      await result.current.retryVoice();
    });
    expect(result.current.error).toBe(false);
    expect(result.current.status.state).toBe(VoiceState.IDLE);
    expect(attempts).toBe(2);
  });

  it('snapshots language and teaching mode, then reads changed settings on the next hold without resubscribing', async () => {
    const bridge = createBridge();
    window.tro = bridge;
    const initialProps: { mode: AgentTaskMode } = { mode: AgentTaskMode.TEACH };
    const { result, rerender } = renderHook(
      ({ mode }: { mode: AgentTaskMode }) => ({
        locale: useLocale(),
        voice: useVoiceInput('user', () => {}, mode),
      }),
      { wrapper, initialProps },
    );
    await waitFor(() => {
      expect(bridge.subscribeVoiceInput).toHaveBeenCalledTimes(1);
    });
    const emit = bridge.subscribeVoiceInput.mock.calls[0]?.[0];
    if (!emit) {
      throw new Error('Missing subscription.');
    }
    act(() => {
      emit({ kind: 'prepare', captureId: firstId });
    });
    expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
      kind: 'prepare',
      captureId: firstId,
      locale: 'vi',
      mode: AgentTaskMode.TEACH,
    });
    act(() => {
      result.current.locale.changeLocale('en');
      rerender({ mode: AgentTaskMode.EXECUTE });
    });
    expect(bridge.subscribeVoiceInput).toHaveBeenCalledTimes(1);
    expect(
      bridge.controlVoiceInput.mock.calls.filter(([command]) => command.kind === 'prepare'),
    ).toHaveLength(1);
    act(() => {
      emit({ kind: 'cancel', captureId: firstId });
    });
    act(() => {
      emit({ kind: 'prepare', captureId: nextId });
    });
    expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
      kind: 'prepare',
      captureId: nextId,
      locale: 'en',
      mode: AgentTaskMode.EXECUTE,
    });
    expect(window.localStorage.getItem(localeStorageKey)).toBe('en');
  });

  it('buffers startup audio, flushes the tail before finish, and never submits from React', async () => {
    const bridge = createBridge();
    window.tro = bridge;
    const received: VoiceEvent[] = [];
    renderHook(
      () =>
        useVoiceInput('user', (event) => {
          received.push(event);
        }),
      { wrapper },
    );
    const emit = bridge.subscribeVoiceInput.mock.calls[0]?.[0];
    if (!emit) {
      throw new Error('Missing subscription.');
    }
    act(() => {
      emit({ kind: 'prepare', captureId: firstId });
    });
    const append = doubles.append[0];
    if (!append) {
      throw new Error('No audio capture.');
    }
    act(() => {
      append(new Uint8Array(960));
    });
    expect(bridge.appendVoiceAudio).not.toHaveBeenCalled();
    act(() => {
      emit({ kind: 'record', captureId: firstId });
    });
    await waitFor(() => {
      expect(bridge.appendVoiceAudio).toHaveBeenCalledTimes(1);
    });
    doubles.flush.mockImplementationOnce(() => {
      append(new Uint8Array(64));
      return Promise.resolve();
    });
    act(() => {
      emit({ kind: 'release', captureId: firstId });
    });
    await waitFor(() => {
      expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
        kind: 'finish',
        captureId: firstId,
        lastSequence: 1,
      });
    });
    expect(bridge.appendVoiceAudio).toHaveBeenCalledTimes(2);
    expect(bridge.sendAgentMessage).not.toHaveBeenCalled();
    expect(bridge.startAgentSession).not.toHaveBeenCalled();
    expect(received.some((event) => event.kind === 'release')).toBe(true);
  });
});

it('releases without waiting for delayed microphone setup', async () => {
  const bridge = createBridge();
  window.tro = bridge;
  doubles.start.mockImplementationOnce(() => new Promise<void>(() => {}));
  renderHook(() => useVoiceInput('user', () => {}), { wrapper });
  const emit = bridge.subscribeVoiceInput.mock.calls[0]?.[0];
  if (!emit) {
    throw new Error('Missing subscription.');
  }
  act(() => {
    emit({ kind: 'prepare', captureId: firstId });
  });
  act(() => {
    emit({ kind: 'record', captureId: firstId });
  });
  act(() => {
    emit({ kind: 'release', captureId: firstId });
  });
  await waitFor(() => {
    expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
      kind: 'finish',
      captureId: firstId,
      lastSequence: -1,
    });
  });
  expect(doubles.flush).toHaveBeenCalledTimes(1);
});

it('stops and flushes on early release, then waits for relay readiness before sending the buffered tail', async () => {
  const bridge = createBridge();
  window.tro = bridge;
  renderHook(() => useVoiceInput('user', () => {}), { wrapper });
  const emit = bridge.subscribeVoiceInput.mock.calls[0]?.[0];
  if (!emit) {
    throw new Error('Missing subscription.');
  }
  act(() => {
    emit({ kind: 'prepare', captureId: firstId });
  });
  const append = doubles.append[0];
  if (!append) {
    throw new Error('Missing microphone.');
  }
  act(() => {
    append(new Uint8Array(960));
  });
  act(() => {
    emit({ kind: 'release', captureId: firstId });
  });
  expect(doubles.flush).toHaveBeenCalledTimes(1);
  expect(bridge.appendVoiceAudio).not.toHaveBeenCalled();
  act(() => {
    emit({ kind: 'record', captureId: firstId });
  });
  await waitFor(() => {
    expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
      kind: 'finish',
      captureId: firstId,
      lastSequence: 0,
    });
  });
  expect(bridge.appendVoiceAudio).toHaveBeenCalledTimes(1);
});
