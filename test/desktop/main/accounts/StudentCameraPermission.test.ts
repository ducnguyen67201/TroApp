import { describe, expect, it } from 'vitest';
import { isStudentCameraAllowed } from '../../../../src/desktop/main/accounts/StudentCameraPermission.js';

describe('student scan camera permission', () => {
  const request = {
    permission: 'media',
    trustedFrame: true,
    mainFrame: true,
    mediaTypes: ['video'],
    leaseUntilMs: 200,
    nowMs: 100,
  };
  it('permits only video in the trusted main frame during the scan lease', () => {
    expect(isStudentCameraAllowed(request)).toBe(true);
    for (const change of [
      { permission: 'geolocation' },
      { trustedFrame: false },
      { mainFrame: false },
      { mediaTypes: ['audio'] },
      { mediaTypes: ['audio', 'video'] },
      { mediaTypes: [] },
      { nowMs: 200 },
    ]) {
      expect(isStudentCameraAllowed({ ...request, ...change })).toBe(false);
    }
  });
});
