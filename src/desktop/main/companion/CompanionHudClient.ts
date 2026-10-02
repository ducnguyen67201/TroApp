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
        if (reply.success) {
          if (reply.data.ready) {
            this.attempts = 0;
            child.postMessage({ kind: 'snapshot', snapshot: this.latest });
          } else {
            child.kill();
          }
          finish();
        }
      });
      child.once('exit', () => {
        finish();
        if (this.worker === child) {
          this.worker = null;
          this.scheduleReconnect();
        }
      });
    });
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
    this.enabled = false;
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
