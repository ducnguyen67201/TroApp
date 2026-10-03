// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { useVoiceover } from '../../../../src/desktop/renderer/voiceover/UseVoiceover.js';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'tro');
  localStorage.clear();
});

it('uses the main cancellation path for local Esc and removes its listener on teardown', () => {
  const cancelGuidance = vi.fn<NonNullable<DesktopBridge['cancelGuidance']>>().mockResolvedValue();
  const bridge = {
    cancelGuidance,
    subscribeVoiceover: vi
      .fn<NonNullable<DesktopBridge['subscribeVoiceover']>>()
      .mockReturnValue(() => {}),
    acknowledgeVoiceover: vi
      .fn<NonNullable<DesktopBridge['acknowledgeVoiceover']>>()
      .mockResolvedValue(),
    setVoiceoverEnabled: vi
      .fn<NonNullable<DesktopBridge['setVoiceoverEnabled']>>()
      .mockResolvedValue(),
    stopSpeaking: vi.fn<NonNullable<DesktopBridge['stopSpeaking']>>().mockResolvedValue(true),
  } satisfies Pick<
    DesktopBridge,
    | 'cancelGuidance'
    | 'subscribeVoiceover'
    | 'acknowledgeVoiceover'
    | 'setVoiceoverEnabled'
    | 'stopSpeaking'
  >;
  Object.defineProperty(window, 'tro', { configurable: true, value: bridge });
  const hook = renderHook(() => useVoiceover('student'), { wrapper: LocaleProvider });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }));
  expect(cancelGuidance).not.toHaveBeenCalled();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(cancelGuidance).toHaveBeenCalledOnce();
  hook.unmount();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(cancelGuidance).toHaveBeenCalledOnce();
});
