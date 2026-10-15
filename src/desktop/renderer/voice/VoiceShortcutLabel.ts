import { VoiceShortcut } from '#contracts/VoiceInput.js';

export const VoiceShortcutLabel = {
  [VoiceShortcut.COMMAND_CONTROL]: 'Command + Control',
  [VoiceShortcut.CONTROL_ALT]: 'Control + Left Alt',
  [VoiceShortcut.CONTROL_SHIFT]: 'Control + Shift',
} satisfies Record<VoiceShortcut, string>;
