// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { MicrophoneCaptureMode, microphonePreviewRenewalMs } from '#contracts/MicrophoneTest.js';
import { MicrophoneKind } from '../../../../src/desktop/renderer/voice/Microphones.js';
import type { MicrophoneView } from '../../../../src/desktop/renderer/voice/UseMicrophones.js';
import { useMicrophonePreview } from '../../../../src/desktop/renderer/voice/UseMicrophonePreview.js';

const captures = vi.hoisted(() => ({
  instances: new Array<{
    receive: (levelDb: number) => void;
    fail: () => void;
    dispose: () => void;
  }>(),
  startPreview: vi.fn<(deviceId: string) => Promise<void>>().mockResolvedValue(),
}));

vi.mock('../../../../src/desktop/renderer/voice/MicrophonePreviewCapture.js', () => ({
  MicrophonePreviewCapture: class {
    dispose = vi.fn<() => void>();
    startPreview = captures.startPreview;

    constructor(
      readonly receive: (levelDb: number) => void,
      readonly fail: () => void,
    ) {
      captures.instances.push(this);
    }
  },
}));

function createInventory(overrides: Partial<MicrophoneView> = {}): MicrophoneView {
  return {
    microphones: [
      { deviceId: 'usb', label: 'USB', kind: MicrophoneKind.WIRED },
      { deviceId: 'built-in', label: 'Built-in', kind: MicrophoneKind.BUILT_IN },
    ],
    selectedDeviceId: 'default',
    recommendedDeviceId: 'usb',
    defaultLabel: '',
    isLoading: false,
    hasLoaded: true,
    hasError: false,
    isSaved: true,
    isSelectedUnavailable: false,
    hasCustomRanking: false,
    moveMicrophone: () => {},
    resetRanking: () => {},
    refreshMicrophones: vi.fn<() => Promise<void>>().mockResolvedValue(),
    selectMicrophone: () => {},
    ...overrides,
  };
}

function createBridge() {
  const bridge = {
    controlMicrophoneTest: vi
      .fn<DesktopBridge['controlMicrophoneTest']>()
      .mockResolvedValue({ kind: 'ok' }),
    subscribeMicrophoneTest: vi
      .fn<DesktopBridge['subscribeMicrophoneTest']>()
      .mockReturnValue(() => {}),
    appendVoiceAudio: vi.fn<DesktopBridge['appendVoiceAudio']>(),
    sendAgentMessage: vi.fn<DesktopBridge['sendAgentMessage']>(),
  } satisfies Pick<
    DesktopBridge,
    'controlMicrophoneTest' | 'subscribeMicrophoneTest' | 'appendVoiceAudio' | 'sendAgentMessage'
  >;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  return bridge;
}

async function finishPendingOperations(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  captures.instances.length = 0;
  captures.startPreview.mockReset().mockResolvedValue();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'hidden');
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('automatic microphone input preview', () => {
  it('opens the OS default without a button and keeps meter updates local', async () => {
    const bridge = createBridge();
    const { result, rerender } = renderHook(() =>
      useMicrophonePreview(true, createInventory({ microphones: [] })),
    );
    expect(result.current.isStarting).toBe(true);
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledExactlyOnceWith('default');
    const command = bridge.controlMicrophoneTest.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      kind: 'start',
      mode: MicrophoneCaptureMode.PREVIEW,
    });
    expect(command?.testId).toBeTypeOf('string');
    expect(result.current.isStarting).toBe(false);
    act(() => {
      captures.instances[0]?.receive(-28);
    });
    expect(result.current.inputLevelDb).toBe(-28);
    rerender();
    expect(captures.startPreview).toHaveBeenCalledOnce();
    expect(bridge.appendVoiceAudio).not.toHaveBeenCalled();
    expect(bridge.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('waits for eligible inventory and never substitutes a missing explicit choice', async () => {
    createBridge();
    const { result, rerender } = renderHook(
      ({ enabled, inventory }) => useMicrophonePreview(enabled, inventory),
      { initialProps: { enabled: false, inventory: createInventory({ hasLoaded: false }) } },
    );
    await finishPendingOperations();
    expect(captures.startPreview).not.toHaveBeenCalled();
    rerender({ enabled: true, inventory: createInventory({ hasLoaded: false }) });
    await finishPendingOperations();
    expect(captures.startPreview).not.toHaveBeenCalled();
    rerender({ enabled: true, inventory: createInventory({ hasError: true }) });
    await finishPendingOperations();
    expect(captures.startPreview).not.toHaveBeenCalled();
    rerender({
      enabled: true,
      inventory: createInventory({ selectedDeviceId: 'missing', isSelectedUnavailable: true }),
    });
    await finishPendingOperations();
    expect(result.current.activeDeviceId).toBeNull();
    expect(captures.startPreview).not.toHaveBeenCalled();
    rerender({ enabled: true, inventory: createInventory({ selectedDeviceId: 'usb' }) });
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledExactlyOnceWith('usb');
  });

  it('disposes and awaits release before acquiring a newly selected microphone', async () => {
    const bridge = createBridge();
    const { result, rerender } = renderHook(
      ({ deviceId }) => useMicrophonePreview(true, createInventory({ selectedDeviceId: deviceId })),
      { initialProps: { deviceId: 'usb' } },
    );
    await finishPendingOperations();
    act(() => {
      captures.instances[0]?.receive(-30);
    });
    let release: ((reply: { kind: 'ok' }) => void) | undefined;
    bridge.controlMicrophoneTest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    rerender({ deviceId: 'built-in' });
    await finishPendingOperations();
    expect(captures.instances[0]?.dispose).toHaveBeenCalledOnce();
    expect(result.current.inputLevelDb).toBeNull();
    expect(bridge.controlMicrophoneTest.mock.calls.map(([command]) => command.kind)).toEqual([
      'start',
      'stop',
    ]);
    act(() => {
      captures.instances[0]?.receive(-5);
    });
    expect(result.current.inputLevelDb).toBeNull();
    await act(async () => {
      release?.({ kind: 'ok' });
      await Promise.resolve();
    });
    expect(captures.startPreview.mock.calls).toEqual([['usb'], ['built-in']]);
    act(() => {
      captures.instances[1]?.receive(-40);
    });
    expect(result.current.inputLevelDb).toBe(-40);
  });

  it('releases pending authorization immediately and fences a late grant after close', async () => {
    const bridge = createBridge();
    let authorize:
      ((reply: Awaited<ReturnType<DesktopBridge['controlMicrophoneTest']>>) => void) | undefined;
    bridge.controlMicrophoneTest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicrophonePreview(enabled, createInventory()),
      { initialProps: { enabled: true } },
    );
    await finishPendingOperations();
    rerender({ enabled: false });
    await act(async () => {
      await result.current.stopPreview();
    });
    expect(bridge.controlMicrophoneTest.mock.calls.map(([command]) => command.kind)).toEqual([
      'start',
      'stop',
    ]);
    expect(result.current.activeDeviceId).toBeNull();
    await act(async () => {
      authorize?.({ kind: 'ok' });
      await Promise.resolve();
    });
    expect(captures.startPreview).not.toHaveBeenCalled();
    expect(bridge.controlMicrophoneTest.mock.calls.map(([command]) => command.kind)).toEqual([
      'start',
      'stop',
      'stop',
    ]);
  });

  it('clears and stops late capture setup without reviving a closed preview', async () => {
    createBridge();
    let finishCapture: (() => void) | undefined;
    captures.startPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicrophonePreview(enabled, createInventory()),
      { initialProps: { enabled: true } },
    );
    await finishPendingOperations();
    expect(result.current.isStarting).toBe(true);
    rerender({ enabled: false });
    await act(async () => {
      finishCapture?.();
      captures.instances[0]?.receive(-20);
      await Promise.resolve();
    });
    expect(captures.instances[0]?.dispose).toHaveBeenCalled();
    expect(result.current.activeDeviceId).toBeNull();
    expect(result.current.inputLevelDb).toBeNull();
    expect(result.current.isStarting).toBe(false);
  });

  it('switches while permission is pending and ignores the previous grant and failures', async () => {
    const bridge = createBridge();
    let authorize:
      ((reply: Awaited<ReturnType<DesktopBridge['controlMicrophoneTest']>>) => void) | undefined;
    bridge.controlMicrophoneTest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ deviceId }) => useMicrophonePreview(true, createInventory({ selectedDeviceId: deviceId })),
      { initialProps: { deviceId: 'usb' } },
    );
    await finishPendingOperations();
    rerender({ deviceId: 'built-in' });
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledExactlyOnceWith('built-in');
    await act(async () => {
      authorize?.({ kind: 'ok' });
      captures.instances[0]?.fail();
      captures.instances[0]?.receive(-1);
      await Promise.resolve();
    });
    expect(result.current.activeDeviceId).toBe('built-in');
    expect(result.current.hasError).toBe(false);
    expect(result.current.inputLevelDb).toBeNull();
    act(() => {
      captures.instances[1]?.receive(-35);
      captures.instances[1]?.fail();
    });
    await finishPendingOperations();
    expect(result.current.hasError).toBe(true);
    expect(result.current.activeDeviceId).toBeNull();
    expect(result.current.inputLevelDb).toBeNull();
    expect(captures.startPreview).toHaveBeenCalledOnce();
  });

  it('renews only the current lease and stops after a renewal rejection', async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { result, unmount } = renderHook(() => useMicrophonePreview(true, createInventory()));
    await finishPendingOperations();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(microphonePreviewRenewalMs);
    });
    const start = bridge.controlMicrophoneTest.mock.calls[0]?.[0];
    expect(bridge.controlMicrophoneTest).toHaveBeenCalledWith({
      kind: 'renew',
      testId: start?.testId,
    });
    bridge.controlMicrophoneTest.mockResolvedValueOnce({ kind: 'failed' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(microphonePreviewRenewalMs);
    });
    expect(result.current.hasError).toBe(true);
    expect(result.current.activeDeviceId).toBeNull();
    expect(result.current.inputLevelDb).toBeNull();
    const calls = bridge.controlMicrophoneTest.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(microphonePreviewRenewalMs * 3);
    });
    expect(bridge.controlMicrophoneTest).toHaveBeenCalledTimes(calls);
    unmount();
  });

  it('stops while hidden and automatically resumes on becoming visible', async () => {
    createBridge();
    const { result } = renderHook(() => useMicrophonePreview(true, createInventory()));
    await finishPendingOperations();
    act(() => {
      captures.instances[0]?.receive(-32);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await finishPendingOperations();
    expect(result.current.activeDeviceId).toBeNull();
    expect(result.current.inputLevelDb).toBeNull();
    act(() => {
      captures.instances[0]?.receive(-10);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledTimes(2);
    expect(result.current.inputLevelDb).toBeNull();
  });

  it('waits for device refresh and leaves a disconnected explicit selection closed', async () => {
    createBridge();
    const devices = new EventTarget();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    let finishRefresh: (() => void) | undefined;
    const refresh = vi.fn<() => Promise<void>>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ unavailable }) =>
        useMicrophonePreview(
          true,
          createInventory({
            selectedDeviceId: 'usb',
            isSelectedUnavailable: unavailable,
            refreshMicrophones: refresh,
          }),
        ),
      { initialProps: { unavailable: false } },
    );
    await finishPendingOperations();
    act(() => {
      devices.dispatchEvent(new Event('devicechange'));
    });
    await finishPendingOperations();
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.current.activeDeviceId).toBeNull();
    expect(captures.startPreview).toHaveBeenCalledOnce();
    rerender({ unavailable: true });
    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
    });
    expect(captures.startPreview).toHaveBeenCalledOnce();
    rerender({ unavailable: false });
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledTimes(2);
  });

  it('does not retry a denied/canceled capture on meter renders and retries after refresh', async () => {
    const bridge = createBridge();
    bridge.controlMicrophoneTest.mockResolvedValueOnce({ kind: 'failed' });
    const { result, rerender } = renderHook(
      ({ isLoading }) => useMicrophonePreview(true, createInventory({ isLoading })),
      { initialProps: { isLoading: false } },
    );
    await finishPendingOperations();
    expect(result.current.hasError).toBe(true);
    expect(captures.startPreview).not.toHaveBeenCalled();
    rerender({ isLoading: false });
    await finishPendingOperations();
    expect(captures.instances).toHaveLength(1);
    rerender({ isLoading: true });
    rerender({ isLoading: false });
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledOnce();
    const command = bridge.controlMicrophoneTest.mock.calls
      .filter(([candidate]) => candidate.kind === 'start')
      .at(-1)?.[0];
    if (!command) {
      throw new Error('Missing preview command');
    }
    act(() => {
      captures.instances[1]?.receive(-20);
      bridge.subscribeMicrophoneTest.mock.calls[0]?.[0]({
        kind: 'canceled',
        testId: command.testId,
      });
    });
    expect(result.current.hasError).toBe(true);
    expect(result.current.activeDeviceId).toBeNull();
    expect(result.current.inputLevelDb).toBeNull();
    rerender({ isLoading: false });
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledOnce();
  });

  it('supports awaited comparison handoff and removes listeners on unmount', async () => {
    const bridge = createBridge();
    const devices = new EventTarget();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    const inventory = createInventory();
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useMicrophonePreview(enabled, inventory),
      { initialProps: { enabled: true } },
    );
    await finishPendingOperations();
    await act(async () => {
      await result.current.stopPreview();
    });
    rerender({ enabled: false });
    await finishPendingOperations();
    expect(result.current.activeDeviceId).toBeNull();
    expect(captures.startPreview).toHaveBeenCalledOnce();
    rerender({ enabled: true });
    await finishPendingOperations();
    expect(captures.startPreview).toHaveBeenCalledTimes(2);
    unmount();
    await finishPendingOperations();
    const calls = bridge.controlMicrophoneTest.mock.calls.length;
    devices.dispatchEvent(new Event('devicechange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(bridge.controlMicrophoneTest).toHaveBeenCalledTimes(calls);
    expect(inventory.refreshMicrophones).not.toHaveBeenCalled();
    expect(captures.instances.at(-1)?.dispose).toHaveBeenCalled();
  });
});
