import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { createAuthClient, type BetterAuthClientPlugin } from 'better-auth/client';
import { electronClient } from '@better-auth/electron/client';
import { z } from 'zod';
import {
  ModelCredentialSchema,
  type AuthResult,
  type ModelCredential,
} from '#contracts/AuthSession.js';

const sessionResponseSchema = z.looseObject({
  user: z.looseObject({ id: z.string().min(1), name: z.string().min(1), email: z.email() }),
});
const googleAvailabilitySchema = z.strictObject({ available: z.boolean() });

interface ElectronActions {
  setupMain(config: {
    csp: false;
    bridges: false;
    scheme: true;
    getWindow: () => BrowserWindow | undefined;
  }): void;
  requestAuth(options: { provider: 'google' }): Promise<void>;
  getCookie(): string;
  signOut(): Promise<unknown>;
}

/** Better Auth owns the OAuth exchange; main stores only its OS-encrypted session data. */
export class AuthClient {
  private readonly client: ElectronActions;

  constructor(
    private readonly apiBaseUrl: string,
    userDataPath: string,
    private readonly request: typeof fetch = fetch,
  ) {
    const storageDirectory = join(userDataPath, 'AuthStorage');
    const plugin = electronClient({
      signInURL: `${apiBaseUrl}/sign-in`,
      protocol: 'app.tro.desktop',
      userImageProxy: { enabled: false },
      storage: {
        getItem(key) {
          try {
            return readFileSync(join(storageDirectory, hashStorageKey(key)), 'utf8');
          } catch {
            return null;
          }
        },
        setItem(key, value) {
          mkdirSync(storageDirectory, { recursive: true });
          writeFileSync(join(storageDirectory, hashStorageKey(key)), String(value), {
            mode: 0o600,
          });
        },
      },
    });
    if (!isCompatiblePlugin(plugin)) throw new Error('Electron authentication is unavailable.');
    const created: unknown = createAuthClient({
      baseURL: apiBaseUrl,
      plugins: [plugin],
    });
    if (!hasElectronActions(created)) throw new Error('Electron authentication is unavailable.');
    this.client = created;
  }

  registerDeepLink(getWindow: () => BrowserWindow | undefined): void {
    /* With an explicit config, the SDK enables only explicitly true options.
       Keep its protocol handler while using Tro's own validated IPC bridge. */
    this.client.setupMain({ csp: false, bridges: false, scheme: true, getWindow });
  }

  async readSession(): Promise<AuthResult> {
    const cookie = this.readCookie();
    if (!cookie) return { kind: 'signed-out' };
    try {
      const response = await this.request(`${this.apiBaseUrl}/api/auth/get-session`, {
        headers: { cookie },
      });
      if (!response.ok) return { kind: 'failed', message: 'Could not check your sign-in.' };
      const text = await response.text();
      if (!text) return { kind: 'signed-out' };
      const body: unknown = JSON.parse(text);
      if (body === null) return { kind: 'signed-out' };
      const parsed = sessionResponseSchema.safeParse(body);
      if (!parsed.success) return { kind: 'failed', message: 'Could not read your sign-in.' };
      const { id, name, email } = parsed.data.user;
      return { kind: 'signed-in', user: { id, name, email } };
    } catch {
      return { kind: 'failed', message: 'Could not reach the sign-in service.' };
    }
  }

  async signInWithGoogle(): Promise<AuthResult> {
    try {
      const response = await this.request(`${this.apiBaseUrl}/api/v1/auth/google`);
      if (!response.ok) return { kind: 'failed', message: 'Could not reach the sign-in service.' };
      const body: unknown = await response.json();
      if (!googleAvailabilitySchema.parse(body).available) {
        return { kind: 'failed', message: 'Google sign-in is not configured on the backend yet.' };
      }
      await this.client.requestAuth({ provider: 'google' });
      return { kind: 'pending' };
    } catch {
      return { kind: 'failed', message: 'Could not open Google sign-in.' };
    }
  }

  async signOut(): Promise<AuthResult> {
    try {
      await this.client.signOut();
      return { kind: 'signed-out' };
    } catch {
      return { kind: 'failed', message: 'Could not sign out.' };
    }
  }

  readCookie(): string | null {
    const cookie = this.client.getCookie();
    return cookie ? cookie : null;
  }

  async fetchModelCredential(): Promise<ModelCredential> {
    const cookie = this.readCookie();
    if (!cookie) throw new Error('Sign in before using the assistant.');
    const response = await this.request(`${this.apiBaseUrl}/api/v1/model/credential`, {
      headers: { cookie },
    });
    if (!response.ok) {
      throw new Error('Could not start the model. Check your sign-in and backend configuration.');
    }
    const body: unknown = await response.json();
    return ModelCredentialSchema.parse(body);
  }
}

/* The SDK's published fetch option types currently differ under
   exactOptionalPropertyTypes. Verify the runtime plugin shape at this boundary. */
function isCompatiblePlugin(
  plugin: ReturnType<typeof electronClient>,
): plugin is ReturnType<typeof electronClient> & BetterAuthClientPlugin {
  return (
    typeof plugin.getActions === 'function' &&
    Array.isArray(plugin.fetchPlugins) &&
    plugin.fetchPlugins.every((item) => typeof item.init === 'function')
  );
}

function hasElectronActions(value: unknown): value is ElectronActions {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  /* Better Auth returns a Proxy, so its virtual actions need property access
     rather than the `in` operator to verify their presence. */
  return ['setupMain', 'requestAuth', 'getCookie', 'signOut'].every(
    (name) => typeof Reflect.get(value, name) === 'function',
  );
}

function hashStorageKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
