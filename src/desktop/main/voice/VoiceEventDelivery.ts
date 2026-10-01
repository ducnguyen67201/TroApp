import type { VoiceEvent } from '#contracts/VoiceInput.js';

interface VoiceEventWindow {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: 'tro:voice-event', event: VoiceEvent): void;
  };
}

/** Window closure destroys Electron objects before voice cleanup emits its
 * final status. Drop those events so cancellation can finish without a renderer. */
export function sendVoiceEventToWindow(
  window: VoiceEventWindow | undefined,
  event: VoiceEvent,
): void {
  if (!window || window.isDestroyed()) {
    return;
  }
  const contents = window.webContents;
  if (!contents.isDestroyed()) {
    contents.send('tro:voice-event', event);
  }
}
