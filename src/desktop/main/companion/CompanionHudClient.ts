import { randomUUID } from 'node:crypto';
import { utilityProcess, type UtilityProcess } from 'electron';
import { CompanionHudPhase, type CompanionHudSnapshot } from '#contracts/CompanionHud.js';
import { CompanionHudWorkerReplySchema } from '#contracts/CompanionHudWorker.js';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
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

  constructor(private readonly workerEntryPath: string) {}

  start(): Promise<void> {
    this.enabled = true;
    if (this.connecting) {
      return this.connecting;
    }
    if (this.worker) {
      return Promise.resolve();
    }
    const child = utilityProcess.fork(this.workerEntryPath, [], {
      serviceName: 'Tro companion presentation',
    });
    this.worker = child;
    this.connecting = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 30_000);
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      child.once('spawn', () => {
        child.postMessage({ kind: 'connect', group: this.group, snapshot: this.latest });
      });
      child.on('message', (message: unknown) => {
        const reply = CompanionHudWorkerReplySchema.safeParse(message);
        if (reply.success) {
          if (reply.data.ready && this.worker === child) {
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
          if (this.enabled && this.attempts++ < 3) {
            this.retry = setTimeout(() => {
              this.retry = null;
              void this.start();
            }, 5000);
            this.retry.unref();
          }
        }
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
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
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.latest = { ...this.latest, phase: CompanionHudPhase.IDLE, level: 0 };
    this.worker?.kill();
    this.worker = null;
  }
}
