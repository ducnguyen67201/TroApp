import { VoiceShortcut } from '#contracts/VoiceInput.js';

const Key = {
  ESCAPE: 1,
  CONTROL: 29,
  CONTROL_RIGHT: 3613,
  ALT: 56,
  SHIFT: 42,
  SHIFT_RIGHT: 54,
  COMMAND: 3675,
  COMMAND_RIGHT: 3676,
} as const;

/** Physical chord state is separate from capture state. Both modifiers must
 * be released before rearming. Right Alt is excluded to avoid Windows AltGr. */
export class VoiceChord {
  private readonly pressed = new Set<number>();
  private active = false;
  private armed = true;

  constructor(
    private readonly shortcut: VoiceShortcut,
    private readonly press: () => void,
    private readonly release: () => void,
    private readonly cancel: () => void,
    private readonly allReleased: () => void = () => {},
  ) {}

  updateKey(keycode: number, down: boolean): void {
    if (down) {
      this.pressed.add(keycode);
    } else {
      this.pressed.delete(keycode);
    }
    if (keycode === Key.ESCAPE && down) {
      this.cancel();
    }
    const control = this.pressed.has(Key.CONTROL) || this.pressed.has(Key.CONTROL_RIGHT);
    const command = this.pressed.has(Key.COMMAND) || this.pressed.has(Key.COMMAND_RIGHT);
    const shift = this.pressed.has(Key.SHIFT) || this.pressed.has(Key.SHIFT_RIGHT);
    const first = this.shortcut === VoiceShortcut.COMMAND_CONTROL ? command : control;
    const second =
      this.shortcut === VoiceShortcut.COMMAND_CONTROL
        ? control
        : this.shortcut === VoiceShortcut.CONTROL_ALT
          ? this.pressed.has(Key.ALT)
          : shift;
    if (this.active && (!first || !second)) {
      this.active = false;
      this.release();
    }
    if (!first && !second) {
      const wasArmed = this.armed;
      this.armed = true;
      if (!wasArmed) {
        this.allReleased();
      }
    }
    if (first && second && this.armed) {
      this.armed = false;
      this.active = true;
      this.press();
    }
  }

  reset(): void {
    this.pressed.clear();
    this.active = false;
    this.armed = true;
    this.cancel();
    this.allReleased();
  }
}

/** Load the native addon after signed-in startup and permission checks. */
export class GlobalVoiceShortcut {
  private stopListening: (() => void) | null = null;
  private chord: VoiceChord | null = null;

  async enableShortcut(
    shortcut: VoiceShortcut,
    press: () => void,
    release: () => void,
    cancel: () => void,
    allReleased: () => void,
  ): Promise<void> {
    this.disableShortcut();
    const { uIOhook } = await import('uiohook-napi');
    const chord = new VoiceChord(shortcut, press, release, cancel, allReleased);
    const keyDown = (event: { keycode: number }): void => {
      chord.updateKey(event.keycode, true);
    };
    const keyUp = (event: { keycode: number }): void => {
      chord.updateKey(event.keycode, false);
    };
    uIOhook.on('keydown', keyDown);
    uIOhook.on('keyup', keyUp);
    this.chord = chord;
    this.stopListening = () => {
      uIOhook.removeListener('keydown', keyDown);
      uIOhook.removeListener('keyup', keyUp);
      try {
        uIOhook.stop();
      } finally {
        chord.reset();
      }
    };
    try {
      uIOhook.start();
    } catch (error) {
      this.disableShortcut();
      throw error;
    }
  }

  reset(): void {
    this.chord?.reset();
  }

  disableShortcut(): void {
    const stopListening = this.stopListening;
    this.stopListening = null;
    this.chord = null;
    try {
      stopListening?.();
    } catch {
      // Listeners are already detached; a native stop failure must not skip capture cleanup.
    }
  }
}
