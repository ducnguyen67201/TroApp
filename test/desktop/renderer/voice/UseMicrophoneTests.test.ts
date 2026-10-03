// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { MicrophoneKind } from '../../../../src/desktop/renderer/voice/Microphones.js';
import type { MicrophoneView } from '../../../../src/desktop/renderer/voice/UseMicrophones.js';
import type { MicrophoneMeasurementEvent } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurements.js';
import { useMicrophoneTests } from '../../../../src/desktop/renderer/voice/UseMicrophoneTests.js';

const captures = vi.hoisted(() => ({
  instances: [] as {
    receive: (event: MicrophoneMeasurementEvent) => void;
    fail: () => void;
    dispose: () => void;
  }[],
  startTest: vi.fn<(deviceId: string) => Promise<void>>().mockResolvedValue(),
}));

vi.mock('../../../../src/desktop/renderer/voice/MicrophoneTestCapture.js', () => ({
  MicrophoneTestCapture: class {
    dispose = vi.fn<() => void>();
    startTest = captures.startTest;

    constructor(
      readonly receive: (event: MicrophoneMeasurementEvent) => void,
      readonly fail: () => void,
    ) {
      captures.instances.push(this);
    }
  },
}));

function createInventory(): MicrophoneView {
  return {
    microphones: [{ deviceId: 'usb', label: 'USB', kind: MicrophoneKind.WIRED }],
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

beforeEach(() => {
  captures.instances.length = 0;
  captures.startTest.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('local comparison lifecycle', () => {
  it('tests one device at a time, retains measurements without submitting audio or tasks', async () => {
    const bridge = createBridge();
    const inventory = createInventory();
    const { result } = renderHook(() => useMicrophoneTests(true, inventory));
    await act(() => result.current.startTest('usb'));
    await act(() => result.current.startTest('usb'));
    expect(captures.startTest).toHaveBeenCalledOnce();
    act(() => {
      captures.instances[0]?.receive({ kind: 'progress', phase: 'quiet', secondsRemaining: 2 });
    });
    expect(result.current.phase).toBe('quiet');
    act(() => {
      captures.instances[0]?.receive({
        kind: 'result',
        measurement: { version: 1, noiseDb: -50, speechDb: -20, clippedFraction: 0 },
      });
    });
    expect(result.current.activeDeviceId).toBeNull();
    expect(result.current.results[0]).toMatchObject({ deviceId: 'usb', speechDb: -20 });
    expect(bridge.controlMicrophoneTest.mock.calls.map(([command]) => command.kind)).toEqual([
      'start',
      'stop',
    ]);
    expect(bridge.appendVoiceAudio).not.toHaveBeenCalled();
    expect(bridge.sendAgentMessage).not.toHaveBeenCalled();
    expect(inventory.selectedDeviceId).toBe('default');
  });

  it('does not open audio when authorization arrives after cancellation', async () => {
    const bridge = createBridge();
    let grant:
      ((reply: Awaited<ReturnType<DesktopBridge['controlMicrophoneTest']>>) => void) | undefined;
    bridge.controlMicrophoneTest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const { result } = renderHook(() => useMicrophoneTests(true, createInventory()));
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.startTest('usb');
    });
    act(() => {
      result.current.cancelTest();
    });
    await act(async () => {
      grant?.({ kind: 'ok' });
      await pending;
    });
    expect(captures.startTest).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
  });

  it('ignores late measurements, clears results on sign-out and rejects saved callbacks', async () => {
    createBridge();
    const inventory = createInventory();
    const { result, rerender } = renderHook(
      ({ enabled }) => useMicrophoneTests(enabled, inventory),
      { initialProps: { enabled: true } },
    );
    const savedStart = result.current.startTest;
    await act(() => savedStart('usb'));
    rerender({ enabled: false });
    act(() => {
      captures.instances[0]?.receive({
        kind: 'result',
        measurement: { version: 1, noiseDb: -50, speechDb: -20, clippedFraction: 0 },
      });
    });
    await act(() => savedStart('usb'));
    expect(captures.startTest).toHaveBeenCalledOnce();
    expect(result.current.results).toEqual([]);
    expect(result.current.activeDeviceId).toBeNull();
    expect(captures.instances[0]?.dispose).toHaveBeenCalled();
  });

  it('stops an expired main-process lease and reports a recoverable error', async () => {
    const bridge = createBridge();
    const { result } = renderHook(() => useMicrophoneTests(true, createInventory()));
    await act(() => result.current.startTest('usb'));
    const command = bridge.controlMicrophoneTest.mock.calls[0]?.[0];
    if (!command) {
      throw new Error('Missing test command');
    }
    act(() => {
      bridge.subscribeMicrophoneTest.mock.calls[0]?.[0]({
        kind: 'canceled',
        testId: command.testId,
      });
    });
    expect(result.current.hasError).toBe(true);
    expect(result.current.activeDeviceId).toBeNull();
  });
});

it('cancels on device changes or visibility loss and removes its listeners on unmount', async () => {
  const bridge = createBridge();
  const devices = new EventTarget();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
  const { result, unmount } = renderHook(() => useMicrophoneTests(true, createInventory()));
  try {
    await act(() => result.current.startTest('usb'));
    act(() => {
      captures.instances[0]?.receive({
        kind: 'result',
        measurement: { version: 1, noiseDb: -50, speechDb: -20, clippedFraction: 0 },
      });
    });
    expect(result.current.results).toHaveLength(1);
    act(() => {
      devices.dispatchEvent(new Event('devicechange'));
    });
    expect(result.current.results).toEqual([]);
    await act(() => result.current.startTest('usb'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.activeDeviceId).toBeNull();
    await act(() => result.current.startTest('usb'));
    unmount();
    const calls = bridge.controlMicrophoneTest.mock.calls.length;
    devices.dispatchEvent(new Event('devicechange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(bridge.controlMicrophoneTest).toHaveBeenCalledTimes(calls);
    expect(captures.instances.at(-1)?.dispose).toHaveBeenCalled();
  } finally {
    unmount();
    Reflect.deleteProperty(navigator, 'mediaDevices');
    Reflect.deleteProperty(document, 'hidden');
  }
});

it('fails denied access without opening a microphone and reports capture errors without results', async () => {
  const bridge = createBridge();
  bridge.controlMicrophoneTest.mockResolvedValueOnce({ kind: 'failed' });
  const { result } = renderHook(() => useMicrophoneTests(true, createInventory()));
  await act(() => result.current.startTest('usb'));
  expect(captures.startTest).not.toHaveBeenCalled();
  expect(result.current.hasError).toBe(true);
  await act(() => result.current.startTest('usb'));
  act(() => {
    captures.instances.at(-1)?.fail();
  });
  expect(result.current.hasError).toBe(true);
  expect(result.current.activeDeviceId).toBeNull();
  expect(result.current.results).toEqual([]);
});
