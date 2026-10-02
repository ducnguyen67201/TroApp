// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MicrophoneKind, type Microphone } from './Microphones.js';
import {
  microphoneRankingStorageKey,
  moveMicrophone,
  orderMicrophones,
  readSavedMicrophoneRanking,
} from './MicrophoneRanking.js';

const microphones: Microphone[] = [
  { deviceId: 'usb', label: 'USB', kind: MicrophoneKind.WIRED },
  { deviceId: 'internal', label: 'Internal', kind: MicrophoneKind.BUILT_IN },
  { deviceId: 'wireless', label: 'Bluetooth', kind: MicrophoneKind.BLUETOOTH },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('local microphone ranking', () => {
  it('moves connected devices and preserves absent preferences for reconnect', () => {
    const ranking = moveMicrophone(microphones, ['absent', 'wireless', 'usb'], 'internal', -1);
    expect(ranking).toEqual(['wireless', 'internal', 'usb', 'absent']);
    expect(orderMicrophones(microphones, ranking).map((microphone) => microphone.deviceId)).toEqual(
      ['wireless', 'internal', 'usb'],
    );
    expect(moveMicrophone(microphones, ranking, 'wireless', -1)).toEqual(ranking);
    expect(
      orderMicrophones(microphones, ['absent', 'internal']).map(
        (microphone) => microphone.deviceId,
      ),
    ).toEqual(['internal', 'usb', 'wireless']);
  });

  it.each([
    'not-json',
    '["usb","usb"]',
    '["default"]',
    '["communications"]',
    '[42]',
    JSON.stringify(new Array<string>(65).fill('usb')),
  ])('discards malformed or invalid stored order: %s', (raw) => {
    window.localStorage.setItem(microphoneRankingStorageKey, raw);
    expect(readSavedMicrophoneRanking()).toEqual([]);
  });

  it('recovers from denied storage and keeps valid stored IDs', () => {
    window.localStorage.setItem(microphoneRankingStorageKey, '["wireless","usb"]');
    expect(readSavedMicrophoneRanking()).toEqual(['wireless', 'usb']);
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('Denied');
    });
    expect(readSavedMicrophoneRanking()).toEqual([]);
  });
});
