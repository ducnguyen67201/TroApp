import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { randomUUID } from 'node:crypto';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { AuthResult } from '#contracts/AuthSession.js';
import { DesktopPermissionState } from '#contracts/DesktopPermissions.js';
import type { AgentChatAuth, AgentChatPermissions, AgentChatWorker } from './AgentChatPorts.js';

const idleMs = 15 * 60_000;
const credentialBufferMs = 60_000;

/** Main owns login and the one warm worker; agent turns do not share history. */
export class AgentChatController {
  private activeSessionId: string | null = null;
  private credentialExpiresAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private turnInProgress = false;
  private pendingSessionId: string | null = null;
  private taskGeneration = 0;
  private companionRequested = false;
  private authChangeInProgress = false;
  private companionStartup: Promise<AgentResult> | null = null;

  constructor(
    private readonly auth: AgentChatAuth,
    private readonly worker: AgentChatWorker,
    private readonly gatewayBaseUrl: string,
    private readonly permissions: AgentChatPermissions,
  ) {}

  isBusy(): boolean {
    return this.turnInProgress;
  }

  async readAuthSession(): Promise<AuthResult> {
    return this.auth.readSession();
  }

  async signInWithGoogle(): Promise<AuthResult> {
    this.authChangeInProgress = true;
    this.companionRequested = false;
    this.taskGeneration += 1;
    try {
      await this.stopWorker();
      return await this.auth.signInWithGoogle();
    } finally {
      this.authChangeInProgress = false;
    }
  }

  async signOut(): Promise<AuthResult> {
    this.authChangeInProgress = true;
    this.companionRequested = false;
    this.taskGeneration += 1;
    try {
      await this.stopWorker();
      return await this.auth.signOut();
    } finally {
      this.authChangeInProgress = false;
    }
  }

  /** Start only local pointer presentation; no gateway credential or model call. */
  startCursorCompanion(): Promise<AgentResult> {
    if (this.authChangeInProgress) {
      return Promise.resolve({ kind: 'failed', message: 'Sign in to use Tro.' });
    }
    this.companionRequested = true;
    if (this.companionStartup) return this.companionStartup;
    if (this.turnInProgress) return Promise.resolve({ kind: 'stopped' });
    const generation = this.taskGeneration;
    this.companionStartup = (async (): Promise<AgentResult> => {
      const accessFailure = await this.checkTaskAccess();
      if (generation !== this.taskGeneration)
        return { kind: 'failed', message: 'The agent session ended.' };
      if (accessFailure) return accessFailure;
      if (this.activeSessionId && this.worker.isRunning()) {
        return { kind: 'started', sessionId: this.activeSessionId };
      }
      const sessionId = randomUUID();
      const result = await this.worker.startCompanion(sessionId);
      if (generation !== this.taskGeneration)
        return { kind: 'failed', message: 'The agent session ended.' };
      if (result.kind === 'started') {
        this.activeSessionId = sessionId;
        this.credentialExpiresAt = 0;
      }
      return result;
    })()
      .catch((): AgentResult => ({
        kind: 'failed',
        message: 'Could not start the cursor companion.',
      }))
      .finally(() => {
        this.companionStartup = null;
      });
    return this.companionStartup;
  }

  async startTaskSession(): Promise<AgentResult> {
    const accessFailure = await this.checkTaskAccess();
    if (accessFailure) return accessFailure;

    return { kind: 'started', sessionId: randomUUID() };
  }

  async sendMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode: AgentTaskMode = AgentTaskMode.EXECUTE,
  ): Promise<AgentResult> {
    if (this.turnInProgress) {
      return { kind: 'failed', message: 'Wait for the current task to finish.' };
    }
    this.turnInProgress = true;
    this.pendingSessionId = sessionId;
    const generation = this.taskGeneration;
    this.clearIdleTimer();
    try {
      await this.companionStartup;
      if (generation !== this.taskGeneration) {
        return { kind: 'failed', message: 'The agent session ended.' };
      }
      const accessFailure = await this.checkTaskAccess();
      if (generation !== this.taskGeneration) {
        return { kind: 'failed', message: 'The agent session ended.' };
      }
      if (accessFailure) return accessFailure;

      if (
        this.activeSessionId !== sessionId ||
        !this.worker.isRunning() ||
        Date.now() + credentialBufferMs >= this.credentialExpiresAt
      ) {
        await this.stopWorker();
        if (generation !== this.taskGeneration) {
          return { kind: 'failed', message: 'The agent session ended.' };
        }
        const credential = await this.auth.fetchModelCredential();
        if (generation !== this.taskGeneration) {
          return { kind: 'failed', message: 'The agent session ended.' };
        }
        const result = await this.worker.start(sessionId, credential.token, this.gatewayBaseUrl);
        if (generation !== this.taskGeneration) {
          return { kind: 'failed', message: 'The agent session ended.' };
        }
        if (result.kind !== 'started') return result;
        this.activeSessionId = sessionId;
        this.credentialExpiresAt = Date.parse(credential.expiresAt);
      }

      return await this.worker.sendMessage(sessionId, message, locale, mode);
    } catch {
      return { kind: 'failed', message: 'Could not complete this task. Try again.' };
    } finally {
      this.turnInProgress = false;
      this.pendingSessionId = null;
      if (this.companionRequested) {
        if (!this.worker.isRunning()) void this.startCursorCompanion();
      } else if (this.worker.isRunning()) {
        this.scheduleIdleStop();
      }
    }
  }

  async stopSession(sessionId: string): Promise<AgentResult> {
    if (this.activeSessionId === sessionId || this.pendingSessionId === sessionId) {
      this.taskGeneration += 1;
      await this.stopWorker();
    }
    if (this.companionRequested) await this.startCursorCompanion();
    return { kind: 'stopped' };
  }

  dispose(): void {
    this.companionRequested = false;
    this.taskGeneration += 1;
    this.pendingSessionId = null;
    this.clearIdleTimer();
    this.worker.dispose();
    this.activeSessionId = null;
    this.credentialExpiresAt = 0;
  }

  private async isSignedIn(): Promise<boolean> {
    const session = await this.auth.readSession();
    return session.kind === 'signed-in';
  }

  /** Check on both session creation and each turn so a revoked grant cannot
   * reach the worker or trigger a model-credential request. */
  private async checkTaskAccess(): Promise<Extract<AgentResult, { kind: 'failed' }> | null> {
    if (this.authChangeInProgress || !(await this.isSignedIn())) {
      return { kind: 'failed', message: 'Sign in to use Tro.' };
    }
    if ((await this.permissions.readStatus()).kind !== DesktopPermissionState.READY) {
      return { kind: 'failed', message: 'Finish desktop permission setup before starting a task.' };
    }
    return null;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.turnInProgress) void this.stopWorker();
    }, idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async stopWorker(): Promise<void> {
    this.clearIdleTimer();
    const sessionId = this.activeSessionId;
    this.activeSessionId = null;
    this.credentialExpiresAt = 0;
    if (sessionId && this.worker.isRunning()) {
      await this.worker.stop(sessionId);
    } else {
      this.worker.dispose();
    }
  }
}
