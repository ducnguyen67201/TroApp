import {
  WhatsNewCommand,
  WhatsNewReplyKind,
  WhatsNewCommandSchema,
  WhatsNewFailure,
  type WhatsNewReply,
  type WhatsNewStatus,
} from '#contracts/WhatsNew.js';
import {
  findInstalledReleaseNotes,
  isNewerAppVersion,
  type AppReleaseNotes,
} from '../../updates/ReleaseNotes.js';
import type { SavedWhatsNewPreferences, WhatsNewStore } from './WhatsNewPreferences.js';

/** Shows one introduction per installed release, independently of accounts and
 * update feeds. First launch establishes a baseline without an automatic tour. */
export class WhatsNewController {
  private preferences: SavedWhatsNewPreferences;
  private readonly release: AppReleaseNotes | null;
  private initialization: Promise<void> | undefined;
  private canSave = true;

  constructor(
    private readonly store: WhatsNewStore,
    private readonly installedVersion: string,
    releases?: readonly AppReleaseNotes[],
  ) {
    this.release = findInstalledReleaseNotes(installedVersion, releases);
    this.preferences = {
      schemaVersion: 1,
      lastRunVersion: installedVersion,
      lastSeenWhatsNewReleaseId: null,
      pendingReleaseId: null,
    };
  }

  async execute(raw: unknown, isTrusted: boolean): Promise<WhatsNewReply> {
    const command = WhatsNewCommandSchema.safeParse(raw);
    if (!isTrusted || !command.success) {
      return { kind: WhatsNewReplyKind.FAILED, reason: WhatsNewFailure.UNAVAILABLE };
    }
    this.initialization ??= this.loadPreferences();
    await this.initialization;
    if (command.data.kind === WhatsNewCommand.MARK_SEEN && this.release) {
      this.preferences = {
        ...this.preferences,
        lastSeenWhatsNewReleaseId: this.release.id,
        pendingReleaseId: null,
      };
      try {
        if (!this.canSave) {
          throw new Error('Whats new storage is unavailable');
        }
        await this.store.savePreferences(this.preferences);
      } catch {
        console.warn('whats-new.preferences.failed', { stage: 'mark-seen' });
        return { kind: WhatsNewReplyKind.FAILED, reason: WhatsNewFailure.UNAVAILABLE };
      }
    }
    return { kind: WhatsNewReplyKind.OK, status: this.readStatus() };
  }

  private readStatus(): WhatsNewStatus {
    return {
      installedVersion: this.installedVersion,
      releaseId: this.release?.id ?? null,
      hasUnseenRelease: Boolean(
        this.release && this.preferences.lastSeenWhatsNewReleaseId !== this.release.id,
      ),
      shouldAutoShow: Boolean(
        this.release && this.preferences.pendingReleaseId === this.release.id,
      ),
    };
  }

  private choosePendingRelease(saved: SavedWhatsNewPreferences): string | null {
    const isUpgrade = isNewerAppVersion(this.installedVersion, saved.lastRunVersion);
    const hasNewHighlights =
      this.release !== null &&
      isNewerAppVersion(this.release.version, saved.lastRunVersion) &&
      this.release.id !== saved.lastSeenWhatsNewReleaseId;
    if (isUpgrade && hasNewHighlights) {
      return this.release.id;
    }
    if (saved.lastRunVersion === this.installedVersion || isUpgrade) {
      return saved.pendingReleaseId;
    }
    return null;
  }

  private async loadPreferences(): Promise<void> {
    try {
      const saved = await this.store.readPreferences();
      if (saved) {
        const pendingReleaseId = this.choosePendingRelease(saved);
        this.preferences = {
          ...saved,
          lastRunVersion: this.installedVersion,
          pendingReleaseId,
        };
      }
      if (!saved || saved.lastRunVersion !== this.installedVersion) {
        await this.store.savePreferences(this.preferences);
      }
    } catch {
      this.canSave = false;
      this.preferences.pendingReleaseId = null;
      console.warn('whats-new.preferences.failed', { stage: 'load' });
    }
  }
}
