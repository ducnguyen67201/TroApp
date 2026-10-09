import { expect, it, vi } from 'vitest';
import { GlobalPracticeShortcut } from '../../../src/desktop/main/GlobalPracticeShortcut.js';
import { PracticeShortcut } from '#contracts/PracticeShortcut.js';
import type { GlobalShortcutPort } from '../../../src/desktop/main/GlobalTaskCancelShortcut.js';

it('registers the review chord and fences callbacks after leave or account change', () => {
  const register = vi.fn<GlobalShortcutPort['register']>().mockReturnValue(true);
  const unregister = vi.fn<GlobalShortcutPort['unregister']>();
  const open = vi.fn<() => void>();
  const shortcut = new GlobalPracticeShortcut({ register, unregister }, 'darwin');
  expect(shortcut.enable(open)).toBe(true);
  expect(register).toHaveBeenCalledWith(PracticeShortcut.MAC_ACCELERATOR, expect.any(Function));
  const old = register.mock.calls[0]?.[1];
  old?.();
  expect(open).toHaveBeenCalledOnce();
  shortcut.disable();
  expect(unregister).toHaveBeenCalledWith(PracticeShortcut.MAC_ACCELERATOR);
  shortcut.enable(open);
  old?.();
  expect(open).toHaveBeenCalledOnce();
  register.mock.calls[1]?.[1]();
  expect(open).toHaveBeenCalledTimes(2);
});

it('allows an in-app fallback when registration is reserved or throws', () => {
  const register = vi.fn<GlobalShortcutPort['register']>().mockReturnValue(false);
  const unregister = vi.fn<GlobalShortcutPort['unregister']>();
  const shortcut = new GlobalPracticeShortcut({ register, unregister }, 'darwin');
  expect(shortcut.enable(() => {})).toBe(false);
  register.mockImplementation(() => {
    throw new Error('Unavailable');
  });
  expect(shortcut.enable(() => {})).toBe(false);
  expect(shortcut.isAvailable()).toBe(false);
  shortcut.disable();
  expect(unregister).not.toHaveBeenCalled();
});

it('registers and releases Alt+K on Windows', () => {
  const register = vi.fn<GlobalShortcutPort['register']>().mockReturnValue(true);
  const unregister = vi.fn<GlobalShortcutPort['unregister']>();
  const shortcut = new GlobalPracticeShortcut({ register, unregister }, 'win32');
  expect(shortcut.enable(() => {})).toBe(true);
  expect(register).toHaveBeenCalledWith('Alt+K', expect.any(Function));
  shortcut.disable();
  expect(unregister).toHaveBeenCalledWith('Alt+K');
});
