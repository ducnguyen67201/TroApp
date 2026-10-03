import type { AgentCancelShortcut } from './AgentChatPorts.js';

export interface GlobalShortcutPort {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Registers Esc while a lesson or its narration is active. Registration can fail when another
 * app owns the accelerator; the workspace Esc control remains available. */
export class GlobalTaskCancelShortcut implements AgentCancelShortcut {
  private generation = 0;
  private registered = false;
  private cancelTask: (() => void) | null = null;
  private cancelVoiceover: (() => void) | null = null;

  constructor(private readonly shortcuts: GlobalShortcutPort) {}

  enable(cancel: () => void): boolean {
    this.releaseRegistration();
    this.cancelTask = cancel;
    return this.registerCancellation();
  }

  setVoiceoverCancel(cancel: (() => void) | null): void {
    if (cancel === this.cancelVoiceover) {
      return;
    }
    this.releaseRegistration();
    this.cancelVoiceover = cancel;
    this.registerCancellation();
  }

  /** Shared by the global accelerator and the trusted renderer fallback. */
  cancelGuidance(): void {
    const cancelTask = this.cancelTask;
    const cancelVoiceover = this.cancelVoiceover;
    cancelTask?.();
    cancelVoiceover?.();
  }

  private registerCancellation(): boolean {
    if (!this.cancelTask && !this.cancelVoiceover) {
      return false;
    }
    const generation = this.generation;
    try {
      this.registered = this.shortcuts.register('Escape', () => {
        if (this.registered && generation === this.generation) {
          this.cancelGuidance();
        }
      });
    } catch {
      this.registered = false;
    }
    return this.registered;
  }

  disable(): void {
    this.releaseRegistration();
    this.cancelTask = null;
    this.registerCancellation();
  }

  private releaseRegistration(): void {
    this.generation += 1;
    if (this.registered) {
      this.registered = false;
      this.shortcuts.unregister('Escape');
    }
  }
}
