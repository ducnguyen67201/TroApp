import { StudentAccessKind, StudentStaffAccessKinds } from '#contracts/StudentAccess.js';
import { DesktopAuthProtocol } from '../DesktopAuthProtocol.js';
import {
  EncryptedStudentDevice,
  type StudentDeviceStorage,
} from './accounts/EncryptedStudentDevice.js';
import {
  StudentAccessPath,
  StudentAccessReplySchema,
  StudentDeviceCredentialSchema,
  StudentEnrollmentReplySchema,
  StudentSessionCookie,
  type StudentAccessCommand,
  type StudentAccessReply,
} from '#contracts/StudentAccess.js';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import {
  DesktopAuthCallbackError,
  ensureDesktopAuthCallback,
} from './accounts/DesktopAuthCallback.js';
import { AccountSessions } from './accounts/AccountSessions.js';
import { EncryptedAccountVault } from './accounts/EncryptedAccountVault.js';
import type { AccountVault } from './accounts/AccountSessions.js';
import type { AccountReply } from '#contracts/DesktopAccounts.js';
import {
  TranscriptionCredentialSchema,
  type TranscriptionCredential,
} from '#contracts/Transcription.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { createAuthClient, type BetterAuthClientPlugin } from 'better-auth/client';
import { electronClient } from '@better-auth/electron/client';
import { z } from 'zod';
import type { AgentChatAuth } from './AgentChatPorts.js';
import {
  ModelCredentialSchema,
  type AuthResult,
  type ModelCredential,
} from '#contracts/AuthSession.js';

/* SDK 1.7.6 advertises kElectron in types but omits its runtime export. Keep
   the pinned SDK's state-map key at this adapter boundary and test compatibility. */
const ElectronPendingSignInKey = Symbol.for('better-auth:electron');

const googleAvailabilitySchema = z.strictObject({ available: z.boolean() });

interface ElectronActions {
  setupMain(config: {
    csp: false;
    bridges: false;
    scheme: true;
    getWindow: () => BrowserWindow | undefined;
  }): void;
  requestAuth(options: {
    provider: 'google';
    additionalParams?: { prompt: 'select_account' };
  }): Promise<void>;
  getCookie(): string;
  signOut(): Promise<unknown>;
}

/** Better Auth owns the OAuth exchange; main stores only its OS-encrypted session data. */
export class AuthClient implements AgentChatAuth {
  private readonly client: ElectronActions;
  private readonly accounts: AccountSessions;
  private loginGeneration = 0;
  private studentDeviceLoaded = false;

  constructor(
    private readonly apiBaseUrl: string,
    userDataPath: string,
    private readonly request: typeof fetch = fetch,
    vault: AccountVault = new EncryptedAccountVault(userDataPath),
    private readonly prepareCallback: () => Promise<void> = ensureDesktopAuthCallback,
    private readonly studentDevice: StudentDeviceStorage = new EncryptedStudentDevice(userDataPath),
  ) {
    const storageDirectory = join(userDataPath, 'AuthStorage');
    const plugin = electronClient({
      signInURL: `${apiBaseUrl}/sign-in`,
      protocol: DesktopAuthProtocol.SCHEME,
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
      fetchOptions: {
        customFetchImpl: async (...parameters: Parameters<typeof fetch>): Promise<Response> => {
          const generation = this.loginGeneration;
          const response = await request(...parameters);
          const data = await response.arrayBuffer();
          if (generation !== this.loginGeneration) {
            throw new Error('The sign-in attempt ended.');
          }
          return new Response(response.status === 204 ? null : data, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      },
      plugins: [plugin],
    });
    if (!hasElectronActions(created)) throw new Error('Electron authentication is unavailable.');
    this.client = created;
    this.accounts = new AccountSessions(
      vault,
      () => this.client.getCookie() || null,
      request,
      apiBaseUrl,
    );
  }

  registerDeepLink(getWindow: () => BrowserWindow | undefined): void {
    /* With an explicit config, the SDK enables only explicitly true options.
       Keep its protocol handler while using Tro's own validated IPC bridge. */
    this.client.setupMain({ csp: false, bridges: false, scheme: true, getWindow });
  }

  async readSession(): Promise<AuthResult> {
    try {
      this.loadStudentDevice();
      const wasAdding = this.accounts.isAddingAccount();
      const result = await this.accounts.readSession();
      if (wasAdding && !this.accounts.isAddingAccount()) {
        this.invalidateLoginAttempt();
      }
      return result;
    } catch {
      return { kind: 'failed', message: 'Secure account storage is unavailable.' };
    }
  }

  listAccounts(): AccountReply {
    try {
      this.loadStudentDevice();
      return this.accounts.listAccounts();
    } catch {
      return { kind: 'failed', message: 'Secure account storage is unavailable.' };
    }
  }

  private loadStudentDevice(): void {
    if (!this.studentDeviceLoaded) {
      const device = this.studentDevice.read();
      this.accounts.configureStudentMode(device?.context.mode === StudentDeviceMode.SHARED);
      this.studentDeviceLoaded = true;
    }
  }

  isSharedStudent(): boolean {
    return this.accounts.isSharedStudent();
  }

  async controlStudentAccess(
    command: StudentAccessCommand,
    beforeStudentSelection?: () => Promise<void>,
  ): Promise<StudentAccessReply> {
    try {
      this.loadStudentDevice();
      const device = this.studentDevice.read();
      if (command.kind === StudentAccessKind.ACTIVATE && device) {
        return {
          kind: 'failed',
          message: 'Remove the current computer authorization before activating another code.',
        };
      }
      if (
        command.kind === StudentAccessKind.ACTIVATE &&
        command.mode !== StudentDeviceMode.PERSONAL &&
        !this.accounts.canAuthorizeCompanyComputer()
      ) {
        return {
          kind: 'failed',
          message: 'Sign out all saved personal accounts before authorizing a company computer.',
        };
      }
      if (
        command.kind === StudentAccessKind.ACTIVATE &&
        command.mode === StudentDeviceMode.PERSONAL &&
        !this.accounts.canStartStudentSignIn()
      ) {
        return {
          kind: 'failed',
          message: 'Finish the current sign-in before authorizing QR access.',
        };
      }
      if (
        (command.kind === StudentAccessKind.ACTIVATE ||
          command.kind === StudentAccessKind.DEACTIVATE) &&
        this.accounts.isSharedStudent()
      ) {
        return {
          kind: 'failed',
          message: 'Sign out the current student before changing computer authorization.',
        };
      }
      if (command.kind === StudentAccessKind.STATUS && !device) {
        return { kind: 'unconfigured' };
      }
      if (
        command.kind === StudentAccessKind.ENROLL &&
        (!device || !this.accounts.canStartStudentSignIn())
      ) {
        return {
          kind: 'failed',
          message: 'Set up this device and end the current shared lesson before signing in.',
        };
      }
      const staff = StudentStaffAccessKinds.includes(command.kind);
      const cookie = staff ? this.readCookie() : null;
      const response = await this.request(`${this.apiBaseUrl}${StudentAccessPath}/command`, {
        method: 'POST',
        headers: {
          origin: 'app.tro.desktop:/',
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(device && !staff ? { 'x-tro-student-device': device.credential } : {}),
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        return { kind: 'failed', message: 'This server does not support student QR access yet.' };
      }
      const body: unknown = await response.json();
      if (!response.ok) {
        return StudentAccessReplySchema.parse(body);
      }
      if (command.kind === StudentAccessKind.ACTIVATE) {
        const activated = StudentDeviceCredentialSchema.parse(body);
        if (activated.context.mode !== (command.mode ?? StudentDeviceMode.SHARED)) {
          return {
            kind: 'failed',
            message: 'The computer authorization mode did not match this sign-in.',
          };
        }
        this.accounts.configureStudentMode(activated.context.mode === StudentDeviceMode.SHARED);
        this.studentDevice.save(activated);
        return { kind: 'ready', context: activated.context };
      }
      if (command.kind === StudentAccessKind.ENROLL) {
        const enrolled = StudentEnrollmentReplySchema.parse(body);
        const result = await this.accounts.addStudent(
          `${StudentSessionCookie}=${enrolled.credential}`,
          enrolled.user,
          beforeStudentSelection,
        );
        return result.kind === 'signed-in' || result.kind === 'failed'
          ? result
          : { kind: 'failed', message: 'Could not finish student sign-in.' };
      }
      if (command.kind === StudentAccessKind.DEACTIVATE) {
        const result = StudentAccessReplySchema.parse(body);
        if (result.kind === 'done') {
          this.studentDevice.clear();
          this.accounts.configureStudentMode(false);
        }
        return result;
      }
      return StudentAccessReplySchema.parse(body);
    } catch {
      return {
        kind: 'failed',
        message:
          'Could not finish student access. Check your connection and secure device storage, then retry.',
      };
    }
  }

  isAddingAccount(): boolean {
    return this.accounts.isAddingAccount();
  }

  async switchAccount(accountId: string): Promise<AuthResult> {
    try {
      this.invalidateLoginAttempt();
      return await this.accounts.switchAccount(accountId);
    } catch {
      return { kind: 'failed', message: 'Secure account storage is unavailable.' };
    }
  }

  async cancelAccountSignIn(): Promise<AuthResult> {
    try {
      this.invalidateLoginAttempt();
      this.accounts.cancelSignIn();
      return await this.readSession();
    } catch {
      return { kind: 'failed', message: 'Secure account storage is unavailable.' };
    }
  }

  addGoogleAccount(): Promise<AuthResult> {
    return this.openGoogleSignIn(true);
  }

  signInWithGoogle(): Promise<AuthResult> {
    return this.openGoogleSignIn(false);
  }

  private async openGoogleSignIn(chooseAccount: boolean): Promise<AuthResult> {
    if (this.accounts.isAddingAccount()) {
      return { kind: 'failed', message: 'An account change is already in progress.' };
    }
    const current = await this.readSession();
    if (current.kind === 'failed') {
      return current;
    }
    try {
      const response = await this.request(`${this.apiBaseUrl}/api/v1/auth/google`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { kind: 'failed', message: 'Could not reach the sign-in service.' };
      const body: unknown = await response.json();
      if (!googleAvailabilitySchema.parse(body).available) {
        return { kind: 'failed', message: 'Google sign-in is not configured on the backend yet.' };
      }
      await this.prepareCallback();
      this.invalidateLoginAttempt();
      try {
        this.accounts.beginSignIn();
      } catch {
        return { kind: 'failed', message: 'Secure account storage is unavailable.' };
      }
      await this.client.requestAuth({
        provider: 'google',
        ...(chooseAccount ? { additionalParams: { prompt: 'select_account' } as const } : {}),
      });
      return { kind: 'pending' };
    } catch (error) {
      this.invalidateLoginAttempt();
      this.accounts.cancelSignIn();
      const callbackMessages: readonly string[] = Object.values(DesktopAuthCallbackError);
      return {
        kind: 'failed',
        message:
          error instanceof Error && callbackMessages.includes(error.message)
            ? error.message
            : 'Could not open Google sign-in.',
      };
    }
  }

  async signOut(): Promise<AuthResult> {
    try {
      this.invalidateLoginAttempt();
      return await this.accounts.signOut();
    } catch {
      return { kind: 'failed', message: 'Could not sign out.' };
    }
  }

  private invalidateLoginAttempt(): void {
    this.loginGeneration += 1;
    /* The pinned SDK keeps pending PKCE states in this process-wide map without
       a cancel action. This client is its sole owner; discard canceled proofs. */
    const pendingProofs: unknown = Reflect.get(globalThis, ElectronPendingSignInKey);
    if (pendingProofs instanceof Map) {
      pendingProofs.clear();
    }
  }

  readCookie(): string | null {
    return this.accounts.readCookie();
  }

  async releaseUnusedTranscription(captureId: string): Promise<void> {
    const cookie = this.readCookie();
    if (!cookie) {
      return;
    }
    await this.request(`${this.apiBaseUrl}/api/v1/transcription/cancel`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ captureId }),
      signal: AbortSignal.timeout(5000),
    });
  }

  async fetchTranscriptionCredential(
    captureId: string,
    locale: DesktopLocale,
  ): Promise<TranscriptionCredential> {
    const cookie = this.readCookie();
    if (!cookie) {
      throw new Error('Sign in to use voice.');
    }
    const response = await this.request(`${this.apiBaseUrl}/api/v1/transcription/credential`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ captureId, locale }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error('Voice is unavailable.');
    }
    const body: unknown = await response.json();
    return TranscriptionCredentialSchema.parse(body);
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
