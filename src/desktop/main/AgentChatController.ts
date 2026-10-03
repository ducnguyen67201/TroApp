import type { VoiceoverController } from './voiceover/VoiceoverController.js';
import type { TeachingMessage } from '#contracts/TeachingStep.js';
import { AgentTaskMode, GuidanceReason, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { randomUUID } from 'node:crypto';
import type { AgentResult } from '#contracts/AgentSession.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { AuthResult } from '#contracts/AuthSession.js';
import { DesktopPermissionState } from '#contracts/DesktopPermissions.js';
import type {
  AgentChatAuth,
  AgentChatPermissions,
  AgentChatWorker,
  AgentCancelShortcut,
} from './AgentChatPorts.js';

const idleMs = 15 * 60_000;
const credentialBufferMs = 60_000;

/** Main owns login and one warm worker; an active lesson retains its goal across SDK runs. */
export class AgentChatController {
  private waitingLessonId: string | null = null;
  private credentialTimer: NodeJS.Timeout | null = null;
  private refreshingCredential = false;

  receiveProgress(progress: AgentProgress): void {
    if (progress.sessionId !== this.pendingSessionId || !this.turnInProgress) {
      return;
    }
    this.voiceover?.receiveProgress(progress);
    if (progress.presentationPending || progress.presentationRevoked) {
      return;
    }
    this.waitingLessonId =
      progress.phase === AgentProgressPhase.NEEDS_INPUT ||
      progress.phase === AgentProgressPhase.PAUSED
        ? (progress.lessonId ?? null)
        : null;
  }

  receivePresentedMessage(message: TeachingMessage | null): void {
    this.voiceover?.receiveVisibleMessage(message);
  }

  async updateTeachingLocale(sessionId: string, locale: DesktopLocale): Promise<AgentResult> {
    if (
      sessionId !== this.pendingSessionId ||
      !this.turnInProgress ||
      !this.worker.updateTeachingLocale
    ) {
      return { kind: 'failed', message: 'No active teaching lesson.' };
    }
    this.voiceover?.setLocale(locale);
    return this.worker.updateTeachingLocale(sessionId, locale);
  }

  async answerLesson(
    sessionId: string,
    lessonId: string,
    message: string,
    locale: DesktopLocale,
  ): Promise<AgentResult> {
    if (
      sessionId !== this.pendingSessionId ||
      lessonId !== this.waitingLessonId ||
      !this.worker.answerLesson
    ) {
      return { kind: 'failed', message: 'This lesson is not waiting for an answer.' };
    }
    const generation = this.taskGeneration;
    const failure = await this.checkTaskAccess();
    if (generation !== this.taskGeneration || this.waitingLessonId !== lessonId) {
      return { kind: 'failed', message: 'The lesson changed.' };
    }
    if (failure) {
      return failure;
    }
    return this.worker.answerLesson(sessionId, lessonId, message, locale);
  }

  private startCredentialRenewal(): void {
    this.credentialTimer = setInterval(() => {
      const sessionId = this.activeSessionId;
      if (
        !sessionId ||
        this.refreshingCredential ||
        Date.now() + credentialBufferMs < this.credentialExpiresAt ||
        !this.worker.refreshCredential
      ) {
        return;
      }
      const generation = this.taskGeneration;
      this.refreshingCredential = true;
      void (async () => {
        const credential = await this.auth.fetchModelCredential();
        if (
          generation !== this.taskGeneration ||
          this.activeSessionId !== sessionId ||
          !this.worker.refreshCredential
        ) {
          return;
        }
        const result = await this.worker.refreshCredential(
          sessionId,
          credential.token,
          this.gatewayBaseUrl,
        );
        if (result.kind === 'started' && generation === this.taskGeneration) {
          this.credentialExpiresAt = Date.parse(credential.expiresAt);
        }
      })()
        .catch(() => {})
        .finally(() => {
          this.refreshingCredential = false;
        });
    }, 30000);
    this.credentialTimer.unref();
  }

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
    private readonly cancelShortcut?: AgentCancelShortcut,
    private readonly voiceover?: VoiceoverController,
  ) {}

  isBusy(): boolean {
    return this.turnInProgress && this.waitingLessonId === null;
  }

  async readAuthSession(): Promise<AuthResult> {
    return this.auth.readSession();
  }

  async signInWithGoogle(): Promise<AuthResult> {
    this.voiceover?.clearTask();
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
    this.voiceover?.clearTask();
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

    return {
      kind: 'started',
      sessionId:
        this.waitingLessonId && this.pendingSessionId ? this.pendingSessionId : randomUUID(),
    };
  }

  async sendMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode: AgentTaskMode = AgentTaskMode.EXECUTE,
  ): Promise<AgentResult> {
    if (this.turnInProgress) {
      if (this.waitingLessonId && sessionId === this.pendingSessionId) {
        return this.answerLesson(sessionId, this.waitingLessonId, message, locale);
      }
      return { kind: 'failed', message: 'Wait for the current task to finish.' };
    }
    this.voiceover?.startTask(sessionId, locale);
    this.turnInProgress = true;
    this.pendingSessionId = sessionId;
    const generation = this.taskGeneration;
    this.clearIdleTimer();
    const escapeCancellation = { requested: false };
    const readInterruptedResult = (): AgentResult =>
      escapeCancellation.requested
        ? {
            kind: 'teaching',
            result: { outcome: TeachingOutcome.CANCELED, reason: GuidanceReason.EXPLICIT_STOP },
          }
        : { kind: 'failed', message: 'The agent session ended.' };
    try {
      if (mode === AgentTaskMode.TEACH) {
        this.cancelShortcut?.enable(() => {
          if (!escapeCancellation.requested) {
            escapeCancellation.requested = true;
            void this.stopSession(sessionId).catch(() => {});
          }
        });
      }
      await this.companionStartup;
      if (generation !== this.taskGeneration) {
        return readInterruptedResult();
      }
      const accessFailure = await this.checkTaskAccess();
      if (generation !== this.taskGeneration) {
        return readInterruptedResult();
      }
      if (accessFailure) return accessFailure;

      if (
        this.activeSessionId !== sessionId ||
        !this.worker.isRunning() ||
        Date.now() + credentialBufferMs >= this.credentialExpiresAt
      ) {
        await this.stopWorker();
        if (generation !== this.taskGeneration) {
          return readInterruptedResult();
        }
        const credential = await this.auth.fetchModelCredential();
        if (generation !== this.taskGeneration) {
          return readInterruptedResult();
        }
        const result = await this.worker.start(sessionId, credential.token, this.gatewayBaseUrl);
        if (generation !== this.taskGeneration) {
          return readInterruptedResult();
        }
        if (result.kind !== 'started') return result;
        this.activeSessionId = sessionId;
        this.credentialExpiresAt = Date.parse(credential.expiresAt);
      }

      if (mode === AgentTaskMode.TEACH) {
        this.startCredentialRenewal();
      }
      const result = await this.worker.sendMessage(sessionId, message, locale, mode);
      if (
        result.kind === 'failed' ||
        result.kind === 'stopped' ||
        (result.kind === 'teaching' &&
          [TeachingOutcome.CANCELED, TeachingOutcome.FAILED].some(
            (outcome) => outcome === result.result.outcome,
          ))
      ) {
        this.voiceover?.clearTask();
      }
      return escapeCancellation.requested ? readInterruptedResult() : result;
    } catch {
      this.voiceover?.clearTask();
      if (escapeCancellation.requested) {
        return readInterruptedResult();
      }
      return { kind: 'failed', message: 'Could not complete this task. Try again.' };
    } finally {
      if (this.credentialTimer) {
        clearInterval(this.credentialTimer);
        this.credentialTimer = null;
      }
      this.waitingLessonId = null;
      this.cancelShortcut?.disable();
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
      this.voiceover?.clearTask();
    }
    if (this.activeSessionId === sessionId || this.pendingSessionId === sessionId) {
      this.cancelShortcut?.disable();
      this.taskGeneration += 1;
      await this.stopWorker();
    }
    if (this.companionRequested) await this.startCursorCompanion();
    return { kind: 'stopped' };
  }

  dispose(): void {
    this.voiceover?.clearTask();
    if (this.credentialTimer) {
      clearInterval(this.credentialTimer);
      this.credentialTimer = null;
    }
    this.waitingLessonId = null;
    this.cancelShortcut?.disable();
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
    this.waitingLessonId = null;
    if (this.credentialTimer) {
      clearInterval(this.credentialTimer);
      this.credentialTimer = null;
    }
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
