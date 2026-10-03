import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../../../src/desktop/main/AuthClient.js';

const actions = vi.hoisted(() => ({
  setupMain: vi.fn<(config: unknown) => void>(),
  requestAuth: vi.fn<(options: { provider: 'google' }) => Promise<void>>(),
  getCookie: vi.fn<() => string>(() => ''),
  signOut: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('better-auth/client', () => ({ createAuthClient: () => actions }));
vi.mock('@better-auth/electron/client', () => ({
  electronClient: () => ({ getActions: () => actions, fetchPlugins: [] }),
}));

describe('desktop authentication handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explicitly enables the SDK protocol handler without enabling its IPC bridge', () => {
    const client = new AuthClient('http://127.0.0.1:3000', '/unused-test-storage');
    const getWindow = (): BrowserWindow | undefined => undefined;

    client.registerDeepLink(getWindow);

    expect(actions.setupMain).toHaveBeenCalledExactlyOnceWith({
      csp: false,
      bridges: false,
      scheme: true,
      getWindow,
    });
  });
});
