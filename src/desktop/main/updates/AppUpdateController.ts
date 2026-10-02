import {
  AppUpdateState,
  AppUpdatePhase,
  AppUpdateFailure,
  type AppUpdateStatus,
  type AppUpdateSnapshot,
  type AppUpdateReply,
} from '#contracts/AppUpdate.js';

export type AppUpdaterEvent =
  | { kind: 'available'; version: string }
  | { kind: 'current' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'failed' };

export interface AppUpdaterPort {
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
  subscribe(listener: (event: AppUpdaterEvent) => void): () => void;
}

export interface AppUpdatePorts {
  updater: AppUpdaterPort | null;
  emit(snapshot: AppUpdateSnapshot): void;
  canRestart(): boolean;
  requestRestart(): void;
}

/** Owns update state independently of sign-in. Downloads and installation require
 * explicit actions; only a completed download can enter the shutdown path. */
export class AppUpdateController {
  private snapshot: AppUpdateSnapshot;
  private unsubscribe: (() => void) | undefined;
  private isDisposed = false;
  private downloadedVersion: string | null = null;

  constructor(private readonly ports: AppUpdatePorts) {
    this.snapshot = {
      revision: 0,
      status: { state: ports.updater ? AppUpdateState.CURRENT : AppUpdateState.DISABLED },
    };
    this.unsubscribe = ports.updater?.subscribe((event) => {
      this.receiveUpdateEvent(event);
    });
  }

  readStatus(): AppUpdateSnapshot {
    return this.snapshot;
  }

  async checkForUpdates(): Promise<AppUpdateReply> {
    const { updater } = this.ports;
    const { status } = this.snapshot;
    if (!updater || this.isDisposed) {
      return this.failUnavailable();
    }
    if (
      status.state !== AppUpdateState.CURRENT &&
      !(status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.CHECK)
    ) {
      return this.replyWithStatus();
    }
    this.setStatus({ state: AppUpdateState.CHECKING });
    try {
      await updater.checkForUpdates();
      if (this.snapshot.status.state === AppUpdateState.CHECKING) {
        this.setStatus({ state: AppUpdateState.CURRENT });
      }
    } catch {
      this.recordFailure();
    }
    return this.replyWithStatus();
  }

  async downloadUpdate(): Promise<AppUpdateReply> {
    const { updater } = this.ports;
    const { status } = this.snapshot;
    if (!updater || this.isDisposed) {
      return this.failUnavailable();
    }
    if (
      status.state !== AppUpdateState.AVAILABLE &&
      !(status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.DOWNLOAD)
    ) {
      return this.failUnavailable();
    }
    if (!status.version) {
      return this.failUnavailable();
    }
    this.downloadedVersion = null;
    this.setStatus({ state: AppUpdateState.DOWNLOADING, version: status.version, percent: 0 });
    try {
      await updater.downloadUpdate();
      if (this.snapshot.status.state === AppUpdateState.DOWNLOADING) {
        this.recordFailure();
      }
    } catch {
      this.recordFailure();
    }
    return this.replyWithStatus();
  }

  restartForUpdate(): AppUpdateReply {
    const { status } = this.snapshot;
    const canInstall =
      status.state === AppUpdateState.READY ||
      (status.state === AppUpdateState.ERROR && status.phase === AppUpdatePhase.INSTALL);
    if (this.isDisposed || !this.ports.updater || !canInstall || !this.downloadedVersion) {
      return this.failUnavailable();
    }
    if (!this.ports.canRestart()) {
      return { kind: 'failed', reason: AppUpdateFailure.BUSY };
    }
    this.setStatus({ state: AppUpdateState.RESTARTING, version: this.downloadedVersion });
    try {
      this.ports.requestRestart();
    } catch {
      this.recordFailure();
    }
    return this.replyWithStatus();
  }

  /** Called by main after its normal worker/driver shutdown completes. */
  installAfterShutdown(): void {
    if (!this.isDisposed && this.snapshot.status.state === AppUpdateState.RESTARTING) {
      try {
        this.ports.updater?.quitAndInstall();
      } catch {
        this.recordFailure();
      }
    }
  }

  dispose(): void {
    this.isDisposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private receiveUpdateEvent(event: AppUpdaterEvent): void {
    if (this.isDisposed) {
      return;
    }
    const { status } = this.snapshot;
    switch (event.kind) {
      case 'available':
        if (status.state === AppUpdateState.CHECKING) {
          this.setStatus({ state: AppUpdateState.AVAILABLE, version: event.version });
        }
        break;
      case 'current':
        if (status.state === AppUpdateState.CHECKING) {
          this.setStatus({ state: AppUpdateState.CURRENT });
        }
        break;
      case 'progress':
        if (status.state === AppUpdateState.DOWNLOADING && Number.isFinite(event.percent)) {
          this.setStatus({ ...status, percent: Math.max(0, Math.min(100, event.percent)) });
        }
        break;
      case 'downloaded':
        if (status.state === AppUpdateState.DOWNLOADING && event.version === status.version) {
          this.downloadedVersion = event.version;
          this.setStatus({ state: AppUpdateState.READY, version: event.version });
        }
        break;
      case 'failed':
        this.recordFailure();
        break;
    }
  }

  private recordFailure(): void {
    const { status } = this.snapshot;
    if (status.state === AppUpdateState.CHECKING) {
      this.setStatus({ state: AppUpdateState.ERROR, phase: AppUpdatePhase.CHECK, version: null });
    } else if (status.state === AppUpdateState.DOWNLOADING) {
      this.setStatus({
        state: AppUpdateState.ERROR,
        phase: AppUpdatePhase.DOWNLOAD,
        version: status.version,
      });
    } else if (status.state === AppUpdateState.RESTARTING) {
      this.setStatus({
        state: AppUpdateState.ERROR,
        phase: AppUpdatePhase.INSTALL,
        version: status.version,
      });
    }
  }

  private setStatus(status: AppUpdateStatus): void {
    if (this.isDisposed) {
      return;
    }
    this.snapshot = { revision: this.snapshot.revision + 1, status };
    this.ports.emit(this.snapshot);
  }

  private replyWithStatus(): AppUpdateReply {
    return { kind: 'ok', snapshot: this.snapshot };
  }

  private failUnavailable(): AppUpdateReply {
    return { kind: 'failed', reason: AppUpdateFailure.UNAVAILABLE };
  }
}
