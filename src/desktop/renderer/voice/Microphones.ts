import { z } from 'zod';

export const defaultMicrophoneId = 'default';

export const microphoneStorageKey = 'tro.desktop.microphone';

const MicrophoneIdSchema = z.string().min(1).max(512);

export const MicrophoneKind = {
  WIRED: 'wired',
  BUILT_IN: 'built-in',
  BLUETOOTH: 'bluetooth',
  VIRTUAL: 'virtual',
  UNKNOWN: 'unknown',
} as const;

export type MicrophoneKind = (typeof MicrophoneKind)[keyof typeof MicrophoneKind];

export interface Microphone {
  deviceId: string;
  label: string;
  kind: MicrophoneKind;
}

const microphonePriority = {
  [MicrophoneKind.WIRED]: 0,
  [MicrophoneKind.BUILT_IN]: 1,
  [MicrophoneKind.UNKNOWN]: 2,
  [MicrophoneKind.BLUETOOTH]: 3,
  [MicrophoneKind.VIRTUAL]: 4,
} satisfies Record<MicrophoneKind, number>;

/** Labels are hints, not reliable transport metadata or measured audio quality. */
export function classifyMicrophone(label: string): MicrophoneKind {
  if (/virtual|loopback|blackhole|soundflower|vb[- ]?audio|voicemeeter/i.test(label)) {
    return MicrophoneKind.VIRTUAL;
  }
  if (/bluetooth|airpods|hands[- ]?free/i.test(label)) {
    return MicrophoneKind.BLUETOOTH;
  }
  if (/built[- ]?in|internal|macbook|microphone array/i.test(label)) {
    return MicrophoneKind.BUILT_IN;
  }
  if (/\busb\b|wired/i.test(label)) {
    return MicrophoneKind.WIRED;
  }
  return MicrophoneKind.UNKNOWN;
}

/** Omit Chromium's default/communications aliases and devices without valid, bounded IDs. */
export function listMicrophones(devices: readonly MediaDeviceInfo[]): Microphone[] {
  const seenIds = new Set<string>();
  return devices
    .filter((device) => {
      if (
        device.kind !== 'audioinput' ||
        !MicrophoneIdSchema.safeParse(device.deviceId).success ||
        device.deviceId === defaultMicrophoneId ||
        device.deviceId === 'communications' ||
        seenIds.has(device.deviceId)
      ) {
        return false;
      }
      seenIds.add(device.deviceId);
      return true;
    })
    .map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      kind: classifyMicrophone(device.label),
    }))
    .sort(
      (first, second) =>
        microphonePriority[first.kind] - microphonePriority[second.kind] ||
        first.label.localeCompare(second.label) ||
        first.deviceId.localeCompare(second.deviceId),
    );
}

/** Suggest a known wired or built-in input; unfamiliar labels receive no quality claim. */
export function recommendMicrophone(microphones: readonly Microphone[]): Microphone | undefined {
  return (
    microphones.find((microphone) => microphone.kind === MicrophoneKind.WIRED) ??
    microphones.find((microphone) => microphone.kind === MicrophoneKind.BUILT_IN)
  );
}

export function readSavedMicrophone(): string {
  try {
    const parsed = MicrophoneIdSchema.safeParse(window.localStorage.getItem(microphoneStorageKey));
    return parsed.success ? parsed.data : defaultMicrophoneId;
  } catch {
    return defaultMicrophoneId;
  }
}

/** Auto-detect follows the OS. A specific choice must never silently select another input. */
export function createMicrophoneConstraints(deviceId: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
  };
  if (deviceId !== defaultMicrophoneId) {
    audio.deviceId = { exact: MicrophoneIdSchema.parse(deviceId) };
  }
  return { video: false, audio };
}
