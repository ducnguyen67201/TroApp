import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopPermissions,
  readHostPermissionStatus,
} from '../../../src/desktop/main/DesktopPermissions.js';
import { loadCuaSdk, type CuaSdk } from '../../../src/desktop/main/LoadCuaSdk.js';

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}));
vi.mock('electron', () => ({ shell: { openExternal } }));
vi.mock('../../../src/desktop/main/LoadCuaSdk.js', () => ({ loadCuaSdk: vi.fn() }));

const sdk: CuaSdk = {
  readPermissions: vi.fn<CuaSdk['readPermissions']>(),
  requestPermissions: vi.fn<CuaSdk['requestPermissions']>(),
  createHost: vi.fn<CuaSdk['createHost']>(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadCuaSdk).mockResolvedValue(sdk);
});

describe('Tro host permissions', () => {
  it('enters the workspace only when the host has both grants', () => {
    expect(readHostPermissionStatus({ accessibility: true, screenRecording: true })).toEqual({
      kind: 'ready',
      accessibility: 'granted',
      screenRecording: 'granted',
    });
    expect(readHostPermissionStatus({ accessibility: true, screenRecording: false })).toEqual({
      kind: 'needs-permission',
      accessibility: 'granted',
      screenRecording: 'missing',
    });
  });

  it('checks the host without requesting access or starting the driver', async () => {
    if (process.platform !== 'darwin') return;
    vi.mocked(sdk.readPermissions).mockReturnValue({ accessibility: true, screenRecording: false });
    expect((await new DesktopPermissions().readStatus()).kind).toBe('needs-permission');
    expect(sdk.requestPermissions).not.toHaveBeenCalled();
    expect(sdk.createHost).not.toHaveBeenCalled();
  });

  it('leaves unavailable native checks unresolved', async () => {
    if (process.platform !== 'darwin') return;
    vi.mocked(loadCuaSdk).mockRejectedValueOnce(new Error('SDK unavailable'));
    expect((await new DesktopPermissions().readStatus()).kind).toBe('unknown');
  });

  it('requests permissions in the host and opens a fixed Settings destination', async () => {
    if (process.platform !== 'darwin') return;
    openExternal.mockResolvedValue(undefined);
    expect(await new DesktopPermissions().requestPermissions()).toEqual({ kind: 'opened' });
    expect(sdk.requestPermissions).toHaveBeenCalledOnce();
    expect(sdk.createHost).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  });
});
