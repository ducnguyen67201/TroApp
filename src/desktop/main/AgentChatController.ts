import { randomUUID } from 'node:crypto';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { AuthResult } from '#contracts/AuthSession.js';
import { DesktopPermissionState } from '#contracts/DesktopPermissions.js';
import { AgentWorkerClient } from './AgentWorkerClient.js';
import { AuthClient } from './AuthClient.js';
import { DesktopPermissions } from './DesktopPermissions.js';

const idleMs = 15 * 60_000;
const credentialBufferMs = 60_000;

/** Main owns login and the one warm worker; agent turns do not share history. */
export class AgentChatController {
  private activeSessionId: string | null = null;
  private credentialExpiresAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private turnInProgress = false;

  constructor(
    private readonly auth: AuthClient,
    private readonly worker: AgentWorkerClient,
    private readonly gatewayBaseUrl: string,
    private readonly permissions: DesktopPermissions,
  ) {}

  async readAuthSession(): Promise<AuthResult> {
    return this.auth.readSession();
  }

  async signInWithGoogle(): Promise<AuthResult> {
    await this.stopWorker();
    return this.auth.signInWithGoogle();
  }

  async signOut(): Promise<AuthResult> {
    await this.stopWorker();
    return this.auth.signOut();
  }

  async startTaskSession(): Promise<AgentResult> {
    const accessFailure = await this.checkTaskAccess();
    if (accessFailure) return accessFailure;

    return { kind: 'started', sessionId: randomUUID() };
  }

  async sendMessage(sessionId: string, message: string): Promise<AgentResult> {
    if (this.turnInProgress) {
      return { kind: 'failed', message: 'Wait for the current task to finish.' };
    }
    this.turnInProgress = true;
    this.clearIdleTimer();
    try {
      const accessFailure = await this.checkTaskAccess();
      if (accessFailure) return accessFailure;

      if (
        this.activeSessionId !== sessionId ||
        !this.worker.isRunning() ||
        Date.now() + credentialBufferMs >= this.credentialExpiresAt
      ) {
        await this.stopWorker();
        const credential = await this.auth.fetchModelCredential();
        const result = await this.worker.start(sessionId, credential.token, this.gatewayBaseUrl);
        if (result.kind !== 'started') return result;
        this.activeSessionId = sessionId;
        this.credentialExpiresAt = Date.parse(credential.expiresAt);
      }

      return await this.worker.sendMessage(sessionId, message);
    } catch {
      return { kind: 'failed', message: 'Could not complete this task. Try again.' };
    } finally {
      this.turnInProgress = false;
      if (this.worker.isRunning()) this.scheduleIdleStop();
    }
  }

  async stopSession(sessionId: string): Promise<AgentResult> {
    if (this.activeSessionId === sessionId) await this.stopWorker();
    return { kind: 'stopped' };
  }

  dispose(): void {
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
    if (!(await this.isSignedIn())) {
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
