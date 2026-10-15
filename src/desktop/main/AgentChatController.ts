import { AgentWorkerLifecycle } from './agent/AgentWorkerLifecycle.js';
import { readClassroomMessages } from '../localization/ClassroomMessages.js';
import type { VoiceoverController } from './voiceover/VoiceoverController.js';
import type { TeachingMessage } from '#contracts/TeachingStep.js';
import { AgentTaskMode, GuidanceReason, TeachingOutcome } from '#contracts/CursorCompanion.js';
import { AgentProgressPhase, type AgentProgress } from '#contracts/CompanionHud.js';
import { randomUUID } from 'node:crypto';
import type { AgentResult } from '#contracts/AgentSession.js';
import { AnalyticsEvent, type AnalyticsEventInput } from '#contracts/Analytics.js';
import type { ClassroomTaskContext } from './classroom/ClassroomSessionController.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { AuthResult } from '#contracts/AuthSession.js';
import { DesktopPermissionState } from '#contracts/DesktopPermissions.js';
import type {
  AgentChatAuth,
  AgentChatPermissions,
  AgentChatWorker,
  AgentCancelShortcut,
  AgentCursorPresentation,
} from './AgentChatPorts.js';

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
      (progress.phase === AgentProgressPhase.WAITING && progress.canAcceptAnswer) ||
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
  private readonly lifecycle: AgentWorkerLifecycle;
  private turnInProgress = false;
  private pendingSessionId: string | null = null;
  private taskGeneration = 0;
  private authChangeInProgress = false;
  private classroomTask = false;

  constructor(
    private readonly auth: AgentChatAuth,
    private readonly worker: AgentChatWorker,
    private readonly gatewayBaseUrl: string,
    private readonly permissions: AgentChatPermissions,
    private readonly cancelShortcut?: AgentCancelShortcut,
    private readonly voiceover?: VoiceoverController,
    private readonly classroom?: ClassroomTaskContext,
    private readonly recordUsage?: (event: AnalyticsEventInput) => void,
    private readonly cursor?: AgentCursorPresentation,
  ) {
    this.lifecycle = new AgentWorkerLifecycle(() => {
      this.worker.dispose();
    });
  }

  cancelClassroomTask(): void {
    if (this.classroomTask && this.pendingSessionId) {
      void this.stopSession(this.pendingSessionId).catch(() => {});
    }
  }

  isBusy(): boolean {
    return this.turnInProgress && this.waitingLessonId === null;
  }

  async readAuthSession(): Promise<AuthResult> {
    return this.auth.readSession();
  }

  signInWithGoogle(): Promise<AuthResult> {
    return this.changeAccount(() => this.auth.signInWithGoogle());
  }

  signOut(): Promise<AuthResult> {
    return this.changeAccount(() => this.auth.signOut());
  }

  /** Tear down credentials and task presentation before changing the active identity. */
  async changeAccount(action: () => Promise<AuthResult>): Promise<AuthResult> {
    this.voiceover?.clearTask();
    this.authChangeInProgress = true;
    this.lifecycle.invalidate();
    this.taskGeneration += 1;
    try {
      await this.stopWorker();
      return await action();
    } finally {
      this.authChangeInProgress = false;
    }
  }

  /** Content-free speculative work; permission checks do not delay voice capture. */
  beginAgentPreparation(userId: string): { release(): void } {
    const lease = this.lifecycle.acquireWork(false);
    const generation = this.taskGeneration;
    void (async () => {
      const session = await this.auth.readSession();
      if (
        !lease.isCurrent() ||
        generation !== this.taskGeneration ||
        session.kind !== 'signed-in' ||
        session.user.id !== userId ||
        this.authChangeInProgress
      ) {
        return;
      }
      const failure = await this.checkTaskAccess();
      if (failure || !lease.isCurrent() || generation !== this.taskGeneration) {
        return;
      }
      await this.worker.prepare();
    })().catch(() => {
      console.warn('agent.worker.warmup.failed', { stage: 'prepare' });
    });
    return {
      release: () => {
        lease.release();
      },
    };
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
    const startedAt = performance.now();
    this.captureUsage({ event: AnalyticsEvent.AGENT_TASK_STARTED, mode, locale });
    const result = await this.runTaskMessage(sessionId, message, locale, mode);
    this.captureUsage({
      event: AnalyticsEvent.AGENT_TASK_FINISHED,
      mode,
      locale,
      result: result.kind,
      ...(result.kind === 'completed' && result.completion.kind === 'task'
        ? { outcome: result.completion.outcome.status }
        : {}),
      ...(result.kind === 'teaching' ? { teachingOutcome: result.result.outcome } : {}),
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  }

  /** Usage contains only fixed result categories, never instructions or model answers. */
  private captureUsage(event: AnalyticsEventInput): void {
    try {
      this.recordUsage?.(event);
    } catch {
      // Optional analytics must not change task admission or completion.
    }
  }

  private async runTaskMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode: AgentTaskMode,
  ): Promise<AgentResult> {
    this.voiceover?.startTask(sessionId, locale);
    this.turnInProgress = true;
    this.pendingSessionId = sessionId;
    const generation = ++this.taskGeneration;
    const work = this.lifecycle.acquireWork(true);
    let taskBound = false;
    let cleanupConfirmed = true;
    let cursorSuspended = false;
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
      if (generation !== this.taskGeneration) {
        return readInterruptedResult();
      }
      const accessFailure = await this.checkTaskAccess();
      if (generation !== this.taskGeneration) {
        return readInterruptedResult();
      }
      if (accessFailure) return accessFailure;

      const classroomContext = await this.classroom?.readTeachingContext(message);
      this.classroomTask = Boolean(classroomContext);
      if (classroomContext && mode !== AgentTaskMode.TEACH) {
        return {
          kind: 'failed',
          message: readClassroomMessages(locale).errorClassroomTeachMode,
        };
      }
      if (generation !== this.taskGeneration) {
        return readInterruptedResult();
      }

      await this.worker.prepare();
      if (generation !== this.taskGeneration || !work.isCurrent()) {
        return readInterruptedResult();
      }
      const credential = await this.auth.fetchModelCredential();
      if (generation !== this.taskGeneration || !work.isCurrent()) {
        return readInterruptedResult();
      }
      const refreshedFailure = await this.checkTaskAccess();
      if (generation !== this.taskGeneration || !work.isCurrent()) {
        return readInterruptedResult();
      }
      if (refreshedFailure) {
        return refreshedFailure;
      }
      if (classroomContext && !this.classroom?.isContextCurrent(classroomContext)) {
        return { kind: 'failed', message: readClassroomMessages(locale).errorClassroomTeachMode };
      }
      cursorSuspended = true;
      await this.cursor?.suspendFollowing();
      if (generation !== this.taskGeneration || !work.isCurrent()) {
        return readInterruptedResult();
      }
      cleanupConfirmed = false;
      const started = await this.worker.start(sessionId, credential.token, this.gatewayBaseUrl);
      if (generation !== this.taskGeneration || !work.isCurrent()) {
        return readInterruptedResult();
      }
      if (started.kind !== 'started') {
        this.worker.dispose();
        return started;
      }
      taskBound = true;
      this.activeSessionId = sessionId;
      this.credentialExpiresAt = Date.parse(credential.expiresAt);

      if (mode === AgentTaskMode.TEACH) {
        this.startCredentialRenewal();
      }
      const result = classroomContext
        ? await this.worker.sendMessage(sessionId, message, locale, mode, classroomContext)
        : await this.worker.sendMessage(sessionId, message, locale, mode);
      if (classroomContext && !this.classroom?.isContextCurrent(classroomContext)) {
        this.voiceover?.clearTask();
        return {
          kind: 'failed',
          message: readClassroomMessages(locale).errorClassroomContextChanged,
        };
      }
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
      this.classroomTask = false;
      if (this.credentialTimer) {
        clearInterval(this.credentialTimer);
        this.credentialTimer = null;
      }
      this.waitingLessonId = null;
      this.cancelShortcut?.disable();
      if (generation === this.taskGeneration) {
        if (taskBound) {
          try {
            await this.worker.finish(sessionId);
            cleanupConfirmed = true;
          } catch {
            this.worker.dispose();
          }
        }
        this.activeSessionId = null;
        this.credentialExpiresAt = 0;
        if (cursorSuspended && cleanupConfirmed) {
          try {
            await this.cursor?.resumeFollowing();
          } catch {
            console.warn('companion.following.failed', { stage: 'resume' });
          }
        }
      }
      this.turnInProgress = false;
      this.pendingSessionId = null;
      work.release();
    }
  }

  async stopSession(sessionId: string): Promise<AgentResult> {
    if (this.activeSessionId === sessionId || this.pendingSessionId === sessionId) {
      this.voiceover?.clearTask();
    }
    if (this.activeSessionId === sessionId || this.pendingSessionId === sessionId) {
      this.cancelShortcut?.disable();
      this.taskGeneration += 1;
      const stopped = await this.stopWorker();
      if (stopped) {
        await this.cursor?.resumeFollowing().catch(() => {
          console.warn('companion.following.failed', { stage: 'cancel-resume' });
        });
      }
    }
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
    this.lifecycle.invalidate();
    this.taskGeneration += 1;
    this.pendingSessionId = null;
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

  private async stopWorker(): Promise<boolean> {
    this.lifecycle.invalidate();
    this.waitingLessonId = null;
    if (this.credentialTimer) {
      clearInterval(this.credentialTimer);
      this.credentialTimer = null;
    }
    const sessionId = this.activeSessionId;
    this.activeSessionId = null;
    this.credentialExpiresAt = 0;
    if (sessionId && this.worker.isRunning()) {
      const result = await this.worker.stop(sessionId);
      return result.kind === 'stopped';
    }
    this.worker.dispose();
    return true;
  }
}
