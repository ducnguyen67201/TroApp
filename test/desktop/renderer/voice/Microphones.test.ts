// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMicrophone,
  createMicrophoneConstraints,
  defaultMicrophoneId,
  listMicrophones,
  MicrophoneKind,
  microphoneStorageKey,
  readSavedMicrophone,
  recommendMicrophone,
} from '../../../../src/desktop/renderer/voice/Microphones.js';

function createMediaDevice(
  deviceId: string,
  label: string,
  kind: MediaDeviceKind = 'audioinput',
): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: deviceId, toJSON: () => ({ deviceId, label, kind }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('microphone recommendations', () => {
  it('removes aliases, output devices and duplicates, and suggests a physical USB input', () => {
    const microphones = listMicrophones([
      createMediaDevice('default', 'Default - AirPods'),
      createMediaDevice('communications', 'AirPods'),
      createMediaDevice('airpods', 'AirPods Pro'),
      createMediaDevice('internal', 'MacBook Pro Microphone'),
      createMediaDevice('usb', 'HyperX USB'),
      createMediaDevice('virtual', 'USB Virtual Surround'),
      createMediaDevice('unknown', 'Duc Ng'),
      createMediaDevice('speaker', 'USB speaker', 'audiooutput'),
      createMediaDevice('usb', 'HyperX USB'),
      createMediaDevice('', ''),
      createMediaDevice('a'.repeat(513), 'Invalid USB input'),
    ]);
    expect(microphones.map((microphone) => microphone.deviceId)).toEqual([
      'usb',
      'internal',
      'unknown',
      'airpods',
      'virtual',
    ]);
    expect(recommendMicrophone(microphones)?.deviceId).toBe('usb');
    expect(classifyMicrophone('USB Virtual Surround')).toBe(MicrophoneKind.VIRTUAL);
    expect(classifyMicrophone('Bluetooth USB headset')).toBe(MicrophoneKind.BLUETOOTH);
  });

  it('suggests a built-in input when there is no recognized wired input', () => {
    expect(
      recommendMicrophone(
        listMicrophones([
          createMediaDevice('wireless', 'Hands-Free headset'),
          createMediaDevice('internal', 'Built-in microphone'),
        ]),
      )?.deviceId,
    ).toBe('internal');
  });

  it('makes no best-microphone claim from unfamiliar or wireless names', () => {
    expect(
      recommendMicrophone(
        listMicrophones([
          createMediaDevice('unknown', 'Duc Ng'),
          createMediaDevice('airpods', 'AirPods'),
        ]),
      ),
    ).toBeUndefined();
  });
});

describe('microphone preference and capture', () => {
  it('defaults safely for missing, invalid or inaccessible storage', () => {
    expect(readSavedMicrophone()).toBe(defaultMicrophoneId);
    window.localStorage.setItem(microphoneStorageKey, '');
    expect(readSavedMicrophone()).toBe(defaultMicrophoneId);
    window.localStorage.setItem(microphoneStorageKey, 'a'.repeat(513));
    expect(readSavedMicrophone()).toBe(defaultMicrophoneId);
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('Blocked');
    });
    expect(readSavedMicrophone()).toBe(defaultMicrophoneId);
  });

  it('keeps the OS default unconstrained and a saved choice exact', () => {
    window.localStorage.setItem(microphoneStorageKey, 'usb-input');
    expect(readSavedMicrophone()).toBe('usb-input');
    expect(createMicrophoneConstraints('usb-input')).toEqual({
      video: false,
      audio: {
        deviceId: { exact: 'usb-input' },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    expect(createMicrophoneConstraints(defaultMicrophoneId)).toEqual({
      video: false,
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  });
});

it('prefers wired inputs even when the caller provides an unordered inventory', () => {
  expect(
    recommendMicrophone([
      { deviceId: 'internal', label: 'Built-in Microphone', kind: MicrophoneKind.BUILT_IN },
      { deviceId: 'usb', label: 'USB Microphone', kind: MicrophoneKind.WIRED },
    ])?.deviceId,
  ).toBe('usb');
});
