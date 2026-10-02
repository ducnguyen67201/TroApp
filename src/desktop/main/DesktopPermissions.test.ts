import { describe, expect, it } from 'vitest';
import { parseCuaPermissionStatus } from './DesktopPermissions.js';

describe('Cua permission status', () => {
  it('enters the workspace only when the driver daemon reports both grants', () => {
    expect(
      parseCuaPermissionStatus(
        JSON.stringify({
          accessibility: true,
          screen_recording: true,
          source: { attribution: 'driver-daemon' },
        }),
      ),
    ).toEqual({ kind: 'ready', accessibility: 'granted', screenRecording: 'granted' });
  });

  it('shows the missing grant without treating an unknown check as success', () => {
    expect(
      parseCuaPermissionStatus(
        JSON.stringify({
          accessibility: true,
          screen_recording: false,
          source: { attribution: 'driver-daemon' },
        }),
      ),
    ).toEqual({ kind: 'needs-permission', accessibility: 'granted', screenRecording: 'missing' });
    expect(parseCuaPermissionStatus('{"daemon_running":true,"status":"unknown"}')).toEqual({
      kind: 'unknown',
      accessibility: 'unknown',
      screenRecording: 'unknown',
    });
  });

  it('does not accept grants belonging to a different process', () => {
    expect(
      parseCuaPermissionStatus(
        JSON.stringify({
          accessibility: true,
          screen_recording: true,
          source: { attribution: 'caller' },
        }),
      ).kind,
    ).toBe('unknown');
  });

  it('checks the selected companion executable even when another daemon has grants', () => {
    const companion = '/cache/tro/cua-companion/CuaDriver.app/Contents/MacOS/cua-driver';
    const status = (executable?: string): string =>
      JSON.stringify({
        accessibility: true,
        screen_recording: true,
        source: { attribution: 'driver-daemon', ...(executable ? { executable } : {}) },
      });

    expect(parseCuaPermissionStatus(status(companion), companion).kind).toBe('ready');
    expect(parseCuaPermissionStatus(status('/cache/tro/cua-driver'), companion).kind).toBe(
      'unknown',
    );
    expect(parseCuaPermissionStatus(status(), companion).kind).toBe('unknown');
  });
});
