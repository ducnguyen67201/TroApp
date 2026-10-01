import { describe, expect, it, vi } from 'vitest';
import { VoiceShortcut } from '#contracts/VoiceInput.js';
import { VoiceChord } from './GlobalVoiceShortcut.js';

describe('physical voice chord', () => {
  it.each([
    [3675, 29],
    [29, 3675],
  ])('starts in either modifier order and rearms only after both releases', (first, second) => {
    const press = vi.fn<() => void>();
    const release = vi.fn<() => void>();
    const allReleased = vi.fn<() => void>();
    const chord = new VoiceChord(
      VoiceShortcut.COMMAND_CONTROL,
      press,
      release,
      () => {},
      allReleased,
    );
    chord.updateKey(first, true);
    expect(press).not.toHaveBeenCalled();
    chord.updateKey(second, true);
    chord.updateKey(second, true);
    expect(press).toHaveBeenCalledTimes(1);
    chord.updateKey(first, false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(allReleased).not.toHaveBeenCalled();
    chord.updateKey(first, true);
    expect(press).toHaveBeenCalledTimes(1);
    chord.updateKey(first, false);
    chord.updateKey(second, false);
    expect(allReleased).toHaveBeenCalledTimes(1);
    chord.updateKey(second, true);
    chord.updateKey(first, true);
    expect(press).toHaveBeenCalledTimes(2);
  });

  it('excludes right Alt/AltGr and cancels on Escape and reset', () => {
    const press = vi.fn<() => void>();
    const cancel = vi.fn<() => void>();
    const chord = new VoiceChord(VoiceShortcut.CONTROL_ALT, press, () => {}, cancel);
    chord.updateKey(29, true);
    chord.updateKey(3640, true);
    expect(press).not.toHaveBeenCalled();
    chord.updateKey(56, true);
    expect(press).toHaveBeenCalledTimes(1);
    chord.updateKey(1, true);
    chord.reset();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
