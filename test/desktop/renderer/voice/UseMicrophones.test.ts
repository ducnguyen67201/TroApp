// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMicrophones } from '../../../../src/desktop/renderer/voice/UseMicrophones.js';
import { microphoneRankingStorageKey } from '../../../../src/desktop/renderer/voice/MicrophoneRanking.js';
import { microphoneStorageKey } from '../../../../src/desktop/renderer/voice/Microphones.js';

function createDevice(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    label,
    kind: 'audioinput',
    groupId: deviceId,
    toJSON: () => ({ deviceId, label }),
  };
}

function createDevices() {
  const events = new EventTarget();
  return {
    enumerateDevices: vi
      .fn<MediaDevices['enumerateDevices']>()
      .mockResolvedValue([
        createDevice('default', 'Default - Built-in Microphone'),
        createDevice('built-in', 'Built-in Microphone'),
        createDevice('usb', 'USB Microphone'),
      ]),
    getUserMedia: vi.fn<MediaDevices['getUserMedia']>(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.restoreAllMocks();
});

describe('microphone inventory lifecycle', () => {
  it('persists selection, follows hot-plug and keeps a missing choice without recording', async () => {
    const devices = createDevices();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    const { result, unmount } = renderHook(() => useMicrophones(true));
    await waitFor(() => {
      expect(result.current.hasLoaded).toBe(true);
    });
    expect(result.current.recommendedDeviceId).toBe('usb');
    act(() => {
      result.current.selectMicrophone('usb');
    });
    expect(window.localStorage.getItem(microphoneStorageKey)).toBe('usb');
    devices.enumerateDevices.mockResolvedValue([createDevice('built-in', 'Built-in Microphone')]);
    act(() => {
      devices.dispatchEvent(new Event('devicechange'));
    });
    await waitFor(() => {
      expect(result.current.isSelectedUnavailable).toBe(true);
    });
    expect(result.current.selectedDeviceId).toBe('usb');
    devices.enumerateDevices.mockResolvedValue([createDevice('usb', 'USB Microphone')]);
    act(() => {
      devices.dispatchEvent(new Event('devicechange'));
    });
    await waitFor(() => {
      expect(result.current.isSelectedUnavailable).toBe(false);
    });
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    unmount();
    const calls = devices.enumerateDevices.mock.calls.length;
    devices.dispatchEvent(new Event('devicechange'));
    expect(devices.enumerateDevices).toHaveBeenCalledTimes(calls);
  });

  it('ignores late inventories after sign-out and does not enumerate while disabled', async () => {
    const devices = createDevices();
    let finish: ((devices: MediaDeviceInfo[]) => void) | undefined;
    devices.enumerateDevices.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    const { result, rerender } = renderHook(({ enabled }) => useMicrophones(enabled), {
      initialProps: { enabled: false },
    });
    expect(devices.enumerateDevices).not.toHaveBeenCalled();
    rerender({ enabled: true });
    rerender({ enabled: false });
    await act(async () => {
      finish?.([createDevice('private', 'USB microphone')]);
      await Promise.resolve();
    });
    expect(result.current.microphones).toEqual([]);
    expect(result.current.hasLoaded).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('keeps only the latest refresh result', async () => {
    const devices = createDevices();
    let finishOld: ((devices: MediaDeviceInfo[]) => void) | undefined;
    devices.enumerateDevices.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    const { result } = renderHook(() => useMicrophones(true));
    await act(async () => {
      await result.current.refreshMicrophones();
    });
    await act(async () => {
      finishOld?.([createDevice('old', 'Old USB microphone')]);
      await Promise.resolve();
    });
    expect(result.current.recommendedDeviceId).toBe('usb');
  });

  it('reports enumeration and storage failure without losing the session choice', async () => {
    const devices = createDevices();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    const { result } = renderHook(() => useMicrophones(true));
    await waitFor(() => {
      expect(result.current.hasLoaded).toBe(true);
    });
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('Blocked');
    });
    act(() => {
      result.current.selectMicrophone('usb');
    });
    expect(result.current.selectedDeviceId).toBe('usb');
    expect(result.current.isSaved).toBe(false);
    devices.enumerateDevices.mockRejectedValue(new Error('Permission denied'));
    await act(async () => {
      await result.current.refreshMicrophones();
    });
    expect(result.current.hasError).toBe(true);
    expect(result.current.selectedDeviceId).toBe('usb');
  });
});

it('ignores saved refresh and selection callbacks after sign-out or unmount', async () => {
  const devices = createDevices();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
  const { result, rerender, unmount } = renderHook(({ enabled }) => useMicrophones(enabled), {
    initialProps: { enabled: true },
  });
  await waitFor(() => {
    expect(result.current.hasLoaded).toBe(true);
  });
  act(() => {
    result.current.selectMicrophone('usb');
  });
  const savedRefresh = result.current.refreshMicrophones;
  const savedSelect = result.current.selectMicrophone;
  const callCount = devices.enumerateDevices.mock.calls.length;
  rerender({ enabled: false });
  await act(async () => {
    await savedRefresh();
  });
  act(() => {
    savedSelect('default');
  });
  expect(devices.enumerateDevices).toHaveBeenCalledTimes(callCount);
  expect(result.current.microphones).toEqual([]);
  expect(window.localStorage.getItem(microphoneStorageKey)).toBe('usb');
  unmount();
  await savedRefresh();
  expect(devices.enumerateDevices).toHaveBeenCalledTimes(callCount);
});

it('persists custom priority separately from selection and recovers when ranked devices reconnect', async () => {
  const devices = createDevices();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
  const { result } = renderHook(() => useMicrophones(true));
  await waitFor(() => {
    expect(result.current.hasLoaded).toBe(true);
  });
  act(() => {
    result.current.moveMicrophone('built-in', -1);
  });
  expect(result.current.recommendedDeviceId).toBe('built-in');
  expect(result.current.selectedDeviceId).toBe('default');
  expect(window.localStorage.getItem(microphoneRankingStorageKey)).toBe('["built-in","usb"]');
  devices.enumerateDevices.mockResolvedValue([createDevice('usb', 'USB')]);
  await act(() => result.current.refreshMicrophones());
  expect(result.current.recommendedDeviceId).toBe('usb');
  devices.enumerateDevices.mockResolvedValue([
    createDevice('built-in', 'Built-in'),
    createDevice('usb', 'USB'),
  ]);
  await act(() => result.current.refreshMicrophones());
  expect(result.current.recommendedDeviceId).toBe('built-in');
  act(() => {
    result.current.resetRanking();
  });
  expect(result.current.hasCustomRanking).toBe(false);
  expect(result.current.recommendedDeviceId).toBe('usb');
  expect(devices.getUserMedia).not.toHaveBeenCalled();
});
