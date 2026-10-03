import type { AgentCancelShortcut } from './AgentChatPorts.js';

export interface GlobalShortcutPort {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Registers only Esc for an active lesson. Registration can fail when another
 * app owns the accelerator; the workspace Esc control remains available. */
export class GlobalTaskCancelShortcut implements AgentCancelShortcut {
  private generation = 0;
  private registered = false;

  constructor(private readonly shortcuts: GlobalShortcutPort) {}

  enable(cancel: () => void): boolean {
    this.disable();
    const generation = this.generation;
    try {
      this.registered = this.shortcuts.register('Escape', () => {
        if (this.registered && generation === this.generation) {
          cancel();
        }
      });
    } catch {
      this.registered = false;
    }
    return this.registered;
  }

  disable(): void {
    this.generation += 1;
    if (this.registered) {
      this.registered = false;
      this.shortcuts.unregister('Escape');
    }
  }
}
