import { PracticeShortcut } from '#contracts/PracticeShortcut.js';
import type { GlobalShortcutPort } from './GlobalTaskCancelShortcut.js';

/** A single review shortcut, registered only while a student can practice. */
export class GlobalPracticeShortcut {
  private registered = false;
  private generation = 0;

  private readonly accelerator: string;

  constructor(
    private readonly shortcuts: GlobalShortcutPort,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.accelerator =
      platform === 'darwin'
        ? PracticeShortcut.MAC_ACCELERATOR
        : PracticeShortcut.WINDOWS_ACCELERATOR;
  }

  enable(openReview: () => void): boolean {
    this.disable();
    const generation = this.generation;
    try {
      this.registered = this.shortcuts.register(this.accelerator, () => {
        if (this.registered && generation === this.generation) {
          openReview();
        }
      });
    } catch {
      this.registered = false;
    }
    return this.registered;
  }

  isAvailable(): boolean {
    return this.registered;
  }

  disable(): void {
    this.generation += 1;
    if (this.registered) {
      this.shortcuts.unregister(this.accelerator);
    }
    this.registered = false;
  }
}
