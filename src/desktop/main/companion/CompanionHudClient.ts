import type { AgentResult } from '#contracts/AgentSession.js';
import type { TeachingMessage } from '#contracts/TeachingStep.js';
import { randomUUID } from 'node:crypto';
import { utilityProcess, type UtilityProcess } from 'electron';
import { CompanionHudPhase, type CompanionHudSnapshot } from '#contracts/CompanionHud.js';
import { CompanionHudWorkerReplySchema } from '#contracts/CompanionHudWorker.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { DesktopDriverPort } from '../DesktopDriverPort.js';
import type { CompanionPresentationPort } from './DesktopCompanion.js';

/** Separate presentation worker survives agent replacement and long MCP gestures.
 * Only the latest snapshot is replayed; no credentials, audio or actions enter this port. */
export class CompanionHudClient implements CompanionPresentationPort {
  readonly group = randomUUID();
  private worker: UtilityProcess | null = null;
  private ready = false;
  private followingRequested = false;
  private followingSuspended = false;
  private readonly followingReplies = new Map<string, (applied: boolean) => void>();
  private connecting: Promise<void> | null = null;
  private latest: CompanionHudSnapshot = {
    phase: CompanionHudPhase.IDLE,
    locale: DesktopLocale.ENGLISH,
    level: 0,
  };
  private enabled = false;
  private retry: NodeJS.Timeout | null = null;
  private attempts = 0;
  private generation = 0;
  private connectingGeneration = 0;
  private readonly onDriverExit = (): void => {
    this.worker?.kill();
  };

  constructor(
    private readonly workerEntryPath: string,
    private readonly desktopDriver: DesktopDriverPort,
    private readonly receiveMessage?: (message: TeachingMessage | null) => void,
  ) {}

  start(): Promise<void> {
    this.enabled = true;
    if (this.connecting) {
      if (this.connectingGeneration === this.generation) {
        return this.connecting;
      }
      return this.connecting.then(() => (this.enabled ? this.start() : undefined));
    }
    if (this.worker) {
      return Promise.resolve();
    }
    const generation = this.generation;
    this.connectingGeneration = generation;
    this.connecting = this.startWorker(generation)
      .catch(() => {
        console.warn('companion.presentation.failed', {
          stage: 'start',
          reason: 'driver_unavailable',
        });
        if (generation === this.generation) {
          this.scheduleReconnect();
        }
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async startWorker(generation: number): Promise<void> {
    const connection = await this.desktopDriver.start(this.onDriverExit);
    if (!this.enabled || generation !== this.generation) {
      return;
    }
    const child = utilityProcess.fork(this.workerEntryPath, [], {
      serviceName: 'Tro companion presentation',
    });
    this.worker = child;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn('companion.presentation.failed', { stage: 'connect', reason: 'timeout' });
        child.kill();
        resolve();
      }, 30_000);
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      child.once('spawn', () => {
        child.postMessage({
          kind: 'connect',
          group: this.group,
          snapshot: this.latest,
          desktopDriver: connection,
        });
      });
      child.on('message', (message: unknown) => {
        if (this.worker !== child) {
          return;
        }
        const reply = CompanionHudWorkerReplySchema.safeParse(message);
        if (reply.success && 'kind' in reply.data) {
          if (reply.data.kind === 'following') {
            this.followingReplies.get(reply.data.requestId)?.(reply.data.applied);
          } else {
            this.receiveMessage?.(reply.data.message);
          }
          return;
        }
        if (reply.success && 'ready' in reply.data) {
          if (reply.data.ready) {
            this.ready = true;
            this.attempts = 0;
            if (this.followingRequested && !this.followingSuspended) {
              void this.sendFollowing(true).catch(() => {});
            }
            child.postMessage({ kind: 'snapshot', snapshot: this.latest });
          } else {
            console.warn('companion.presentation.failed', {
              stage: 'connect',
              reason: 'native_presentation_unavailable',
            });
            child.kill();
          }
          finish();
        }
      });
      child.once('exit', () => {
        finish();
        if (this.worker === child) {
          this.receiveMessage?.(null);
          this.worker = null;
          this.ready = false;
          this.failFollowingReplies();
          this.scheduleReconnect();
        }
      });
    });
  }

  async startCursorFollowing(): Promise<AgentResult> {
    this.followingRequested = true;
    const generation = this.generation;
    await this.start();
    if (generation !== this.generation) {
      return { kind: 'stopped' };
    }
    try {
      if (!this.followingSuspended) {
        await this.sendFollowing(true);
      }
      return { kind: 'started', sessionId: this.group };
    } catch {
      return { kind: 'failed', message: 'Could not start the cursor companion.' };
    }
  }

  async suspendFollowing(): Promise<void> {
    this.followingSuspended = true;
    if (this.worker || this.connecting) {
      await this.connecting;
      await this.sendFollowing(false);
    }
  }

  async resumeFollowing(): Promise<void> {
    const generation = this.generation;
    this.followingSuspended = false;
    if (this.enabled && this.followingRequested) {
      await this.start();
      if (!this.canResumeFollowing(generation)) {
        return;
      }
      await this.sendFollowing(true);
    }
  }

  private canResumeFollowing(generation: number): boolean {
    return generation === this.generation && !this.followingSuspended && this.enabled;
  }

  private sendFollowing(enabled: boolean): Promise<void> {
    const worker = this.worker;
    if (!worker || !this.ready) {
      return Promise.reject(new Error('Cursor presentation is unavailable.'));
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(false);
      }, 2000);
      const finish = (applied: boolean): void => {
        clearTimeout(timer);
        this.followingReplies.delete(requestId);
        if (applied) {
          resolve();
        } else {
          reject(new Error('Cursor ownership transition failed.'));
        }
      };
      this.followingReplies.set(requestId, finish);
      try {
        worker.postMessage({ kind: 'following', requestId, enabled });
      } catch {
        finish(false);
      }
    });
  }

  private failFollowingReplies(): void {
    for (const finish of [...this.followingReplies.values()]) {
      finish(false);
    }
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.retry || this.attempts++ >= 3) {
      return;
    }
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, 5000);
    this.retry.unref();
  }

  showSnapshot(snapshot: CompanionHudSnapshot): void {
    this.latest = { ...snapshot };
    try {
      this.worker?.postMessage({ kind: 'snapshot', snapshot: this.latest });
    } catch {
      /* Optional HUD transport. */
    }
  }

  dispose(): void {
    this.receiveMessage?.(null);
    this.enabled = false;
    this.ready = false;
    this.followingRequested = false;
    this.followingSuspended = false;
    this.failFollowingReplies();
    this.generation += 1;
    this.attempts = 0;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.latest = { ...this.latest, phase: CompanionHudPhase.IDLE, level: 0 };
    this.worker?.kill();
    this.worker = null;
  }
}
