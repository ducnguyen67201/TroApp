import { describe, expect, it } from 'vitest';
import { isMicrophonePermissionAllowed } from './MicrophonePermission.js';

const audioRequest = {
  permission: 'media',
  isTrustedFrame: true,
  isMainFrame: true,
  mediaTypes: ['audio'],
  isAudioAuthorized: true,
};

describe('microphone permission boundary', () => {
  it('allows audio metadata checks for authorized voice and capture requests', () => {
    expect(isMicrophonePermissionAllowed(audioRequest)).toBe(true);
  });

  it.each([
    { isTrustedFrame: false },
    { isMainFrame: false },
    { isAudioAuthorized: false },
    { permission: 'display-capture' },
    { mediaTypes: ['video'] },
    { mediaTypes: ['audio', 'video'] },
    { mediaTypes: ['unknown'] },
    { mediaTypes: [] },
  ])('denies unauthorized frames, disabled voice and non-audio access: %j', (changes) => {
    expect(isMicrophonePermissionAllowed({ ...audioRequest, ...changes })).toBe(false);
  });
});
