import { describe, expect, it, vi } from 'vitest';
import {
  GlobalTaskCancelShortcut,
  type GlobalShortcutPort,
} from '../../../src/desktop/main/GlobalTaskCancelShortcut.js';

describe('lesson Esc shortcut', () => {
  it('registers only Esc while active and fences late callbacks after cleanup', () => {
    const register = vi.fn<GlobalShortcutPort['register']>().mockReturnValue(true);
    const unregister = vi.fn<GlobalShortcutPort['unregister']>();
    const shortcut = new GlobalTaskCancelShortcut({ register, unregister });
    const cancel = vi.fn<() => void>();
    expect(shortcut.enable(cancel)).toBe(true);
    expect(register.mock.calls[0]?.[0]).toBe('Escape');
    const invoke = register.mock.calls[0]?.[1];
    invoke?.();
    expect(cancel).toHaveBeenCalledOnce();
    shortcut.disable();
    invoke?.();
    expect(cancel).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledExactlyOnceWith('Escape');
  });

  it('never unregisters another app’s Esc binding after registration fails', () => {
    const register = vi.fn<GlobalShortcutPort['register']>().mockReturnValue(false);
    const unregister = vi.fn<GlobalShortcutPort['unregister']>();
    const shortcut = new GlobalTaskCancelShortcut({ register, unregister });
    const cancel = vi.fn<() => void>();
    expect(shortcut.enable(cancel)).toBe(false);
    register.mock.calls[0]?.[1]();
    shortcut.disable();
    expect(cancel).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it('retiring an old listener cannot cancel a later lesson', () => {
    const register = vi.fn<GlobalShortcutPort['register']>().mockReturnValue(true);
    const shortcut = new GlobalTaskCancelShortcut({ register, unregister: () => {} });
    const oldCancel = vi.fn<() => void>();
    const newCancel = vi.fn<() => void>();
    shortcut.enable(oldCancel);
    shortcut.enable(newCancel);
    register.mock.calls[0]?.[1]();
    expect(oldCancel).not.toHaveBeenCalled();
    register.mock.calls[1]?.[1]();
    expect(newCancel).toHaveBeenCalledOnce();
    shortcut.disable();
  });
});
