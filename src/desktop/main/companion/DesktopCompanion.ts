import type { AgentResult } from '#contracts/AgentSession.js';
import {
  CompanionHudController,
  type CompanionHudClock,
  type CompanionHudPort,
  type CompanionHudTransition,
} from './CompanionHudController.js';

/** Cursor operations delegate to the authenticated chat controller. Its worker
 * is shared with tasks, so disposing presentation must not dispose that worker. */
export interface DesktopCompanionCursor {
  startFollowing(): Promise<AgentResult>;
}

/** Main supplies platform, sign-in and verified desktop-permission checks. */
export interface CompanionAccessPort {
  canShow(): Promise<boolean>;
}

/** A persistent presentation connection, independent of the cursor/task worker. */
export interface CompanionPresentationPort extends CompanionHudPort {
  start(): Promise<void>;
  dispose(): void;
}

/** One desktop entry point for cursor guidance and the attached voice HUD.
 * Composes their interfaces without merging native ownership or worker lifetimes.
 * Voice/task events enter this.hud; Cua still renders both surfaces. */
export class DesktopCompanion {
  readonly hud: CompanionHudController;
  private presentationGeneration = 0;

  constructor(
    readonly cursor: DesktopCompanionCursor,
    private readonly access: CompanionAccessPort,
    private readonly presentation: CompanionPresentationPort,
    clock: CompanionHudClock,
    reportTransition?: (transition: CompanionHudTransition) => void,
  ) {
    this.hud = new CompanionHudController(presentation, clock, reportTransition);
  }

  /** Register presentation before the task worker binds its native cursor.
   * Cursor startup retains its own authorization checks and error reporting. */
  async startFollowing(): Promise<AgentResult> {
    const generation = this.presentationGeneration;
    await this.startPresentation();
    if (generation !== this.presentationGeneration) {
      return { kind: 'stopped' };
    }
    return this.cursor.startFollowing();
  }

  /** Optional presentation must not block voice admission or task execution.
   * Call without awaiting from voice startup; following awaits native binding. */
  async startPresentation(): Promise<void> {
    const generation = this.presentationGeneration;
    try {
      if (!(await this.access.canShow()) || generation !== this.presentationGeneration) {
        return;
      }
      await this.presentation.start();
    } catch {
      /* Existing workspace controls and cursor error reporting remain available. */
    }
  }

  /** Clear transient UI while keeping the transport and cursor lease alive. */
  reset(): void {
    this.hud.reset();
  }

  /** Fence pending startup and stop presentation on disable, sign-out or close.
   * A later authorized startup may reuse this facade. Chat owns task teardown. */
  dispose(): void {
    this.presentationGeneration += 1;
    this.reset();
    this.presentation.dispose();
  }
}
