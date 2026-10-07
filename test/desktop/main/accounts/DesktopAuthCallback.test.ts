import { beforeEach, expect, it, vi } from 'vitest';
import { DesktopAuthProtocol } from '../../../../src/desktop/DesktopAuthProtocol.js';
import {
  DesktopAuthCallbackError,
  ensureDesktopAuthCallback,
} from '../../../../src/desktop/main/accounts/DesktopAuthCallback.js';

vi.mock('electron', () => ({ app: {} }));

const bundlePath = '/repo/.tro-development/Tro.app';
const registration = {
  platform: 'darwin',
  executablePath: `${bundlePath}/Contents/MacOS/Electron`,
  usesDefaultApp: false,
  entryPath: undefined,
  setDefault: vi.fn<(scheme: string, executable?: string, args?: string[]) => boolean>(),
  readApplication: vi.fn<(url: string) => Promise<{ path: string }>>(),
  resolvePath: vi.fn<(path: string) => Promise<string>>(),
} satisfies Parameters<typeof ensureDesktopAuthCallback>[0];

beforeEach(() => {
  vi.clearAllMocks();
  registration.setDefault.mockReturnValue(true);
  registration.readApplication.mockResolvedValue({ path: bundlePath });
  registration.resolvePath.mockImplementation((path) => Promise.resolve(path));
});

it('registers the active bundle and verifies the actual macOS callback destination', async () => {
  await ensureDesktopAuthCallback(registration);
  expect(registration.setDefault).toHaveBeenCalledExactlyOnceWith(DesktopAuthProtocol.SCHEME);
  expect(registration.readApplication).toHaveBeenCalledExactlyOnceWith(
    DesktopAuthProtocol.CALLBACK_URL,
  );
  expect(registration.resolvePath).toHaveBeenCalledWith(bundlePath);
});

it('rejects a stale checkout instead of starting a browser login it cannot finish', async () => {
  registration.readApplication.mockResolvedValue({
    path: '/old-checkout/.tro-development/Tro.app',
  });
  await expect(ensureDesktopAuthCallback(registration)).rejects.toThrow(
    DesktopAuthCallbackError.WRONG_APP,
  );
});

it('accepts symlink aliases only when both paths resolve to the same actual bundle', async () => {
  registration.readApplication.mockResolvedValue({ path: '/alias/Tro.app' });
  registration.resolvePath.mockResolvedValue(bundlePath);
  await expect(ensureDesktopAuthCallback(registration)).resolves.toBeUndefined();
});

it('reports failed registration without exposing OS diagnostics', async () => {
  registration.setDefault.mockReturnValue(false);
  await expect(ensureDesktopAuthCallback(registration)).rejects.toThrow(
    DesktopAuthCallbackError.REGISTRATION,
  );
  expect(registration.readApplication).not.toHaveBeenCalled();
});

it('reports an unavailable handler without exposing OS diagnostics', async () => {
  registration.readApplication.mockRejectedValue(new Error('private OS diagnostic'));
  await expect(ensureDesktopAuthCallback(registration)).rejects.toThrow(
    DesktopAuthCallbackError.REGISTRATION,
  );
});

it('reports an inaccessible application path without exposing OS diagnostics', async () => {
  registration.resolvePath.mockRejectedValue(new Error('private OS path'));
  await expect(ensureDesktopAuthCallback(registration)).rejects.toThrow(
    DesktopAuthCallbackError.REGISTRATION,
  );
});

it('preserves the command-line app argument for direct Electron launches', async () => {
  await ensureDesktopAuthCallback({ ...registration, usesDefaultApp: true, entryPath: '/repo' });
  expect(registration.setDefault).toHaveBeenCalledExactlyOnceWith(
    DesktopAuthProtocol.SCHEME,
    registration.executablePath,
    ['/repo'],
  );
});

it('leaves Windows registration to Electron without macOS bundle inspection', async () => {
  await ensureDesktopAuthCallback({ ...registration, platform: 'win32' });
  expect(registration.setDefault).toHaveBeenCalledOnce();
  expect(registration.readApplication).not.toHaveBeenCalled();
});
