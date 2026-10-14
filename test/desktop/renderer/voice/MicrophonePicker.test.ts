// @vitest-environment happy-dom
import { createElement, type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { LocaleProvider } from '../../../../src/desktop/renderer/localization/LocaleProvider.js';
import { localeStorageKey } from '../../../../src/desktop/renderer/localization/Locale.js';
import { MicrophonePicker } from '../../../../src/desktop/renderer/voice/MicrophonePicker.js';
import {
  defaultMicrophoneId,
  MicrophoneKind,
} from '../../../../src/desktop/renderer/voice/Microphones.js';
import { MicrophoneTestPhase } from '../../../../src/desktop/renderer/voice/MicrophoneMeasurements.js';
import type { MicrophoneView } from '../../../../src/desktop/renderer/voice/UseMicrophones.js';
import type { MicrophoneTestsView } from '../../../../src/desktop/renderer/voice/UseMicrophoneTests.js';
import type { MicrophonePreviewView } from '../../../../src/desktop/renderer/voice/UseMicrophonePreview.js';

type MicrophonePickerProps = Parameters<typeof MicrophonePicker>[0];

function createMicrophones(overrides: Partial<MicrophoneView> = {}) {
  return {
    microphones: [
      { deviceId: 'built-in', label: 'MacBook Pro Microphone', kind: MicrophoneKind.BUILT_IN },
      { deviceId: 'usb', label: 'USB Microphone', kind: MicrophoneKind.WIRED },
    ],
    selectedDeviceId: 'built-in',
    recommendedDeviceId: 'built-in',
    defaultLabel: 'MacBook Pro Microphone',
    isLoading: false,
    hasLoaded: true,
    hasError: false,
    isSaved: true,
    isSelectedUnavailable: false,
    hasCustomRanking: false,
    selectMicrophone: vi.fn<MicrophoneView['selectMicrophone']>(),
    moveMicrophone: vi.fn<MicrophoneView['moveMicrophone']>(),
    resetRanking: vi.fn<MicrophoneView['resetRanking']>(),
    refreshMicrophones: vi.fn<MicrophoneView['refreshMicrophones']>().mockResolvedValue(),
    ...overrides,
  } satisfies MicrophoneView;
}

function createTests(overrides: Partial<MicrophoneTestsView> = {}) {
  return {
    activeDeviceId: null,
    phase: MicrophoneTestPhase.OPENING,
    secondsRemaining: 0,
    inputLevelDb: null,
    results: [],
    hasError: false,
    startTest: vi.fn<MicrophoneTestsView['startTest']>().mockResolvedValue(),
    cancelTest: vi.fn<MicrophoneTestsView['cancelTest']>(),
    ...overrides,
  } satisfies MicrophoneTestsView;
}

function createPreview(overrides: Partial<MicrophonePreviewView> = {}) {
  return {
    activeDeviceId: 'built-in',
    inputLevelDb: null,
    isStarting: false,
    hasError: false,
    stopPreview: vi.fn<MicrophonePreviewView['stopPreview']>().mockResolvedValue(),
    ...overrides,
  } satisfies MicrophonePreviewView;
}

function createPicker(props: Partial<MicrophonePickerProps> = {}): ReactElement {
  return createElement(MantineProvider, {
    env: 'test',
    children: createElement(LocaleProvider, {
      children: createElement(MicrophonePicker, {
        opened: true,
        onClose: vi.fn<() => void>(),
        onExitTransitionEnd: vi.fn<() => void>(),
        microphones: createMicrophones(),
        tests: createTests(),
        preview: createPreview(),
        canTest: true,
        isEnabled: true,
        hasVoiceError: false,
        isRetryingVoice: false,
        retryVoice: vi.fn<() => Promise<void>>().mockResolvedValue(),
        ...props,
      }),
    }),
  });
}

beforeEach(() => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('automatic microphone input preview', () => {
  it('updates the meter from silence to speech without a test click', () => {
    const microphones = createMicrophones();
    const tests = createTests();
    const preview = createPreview({ inputLevelDb: -120 });
    const picker = render(createPicker({ microphones, tests, preview }));
    const meter = screen.getByRole('meter', { name: 'Input level' });
    const inputLevel = screen.getByRole('region', { name: 'Input level' });
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    expect(meter.getAttribute('aria-valuetext')).toBe('-120 dBFS');
    expect(within(inputLevel).getByRole('status').textContent).toBe('Listening');
    expect(screen.queryByRole('button', { name: 'Test input' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel test' })).toBeNull();
    expect(tests.startTest).not.toHaveBeenCalled();

    picker.rerender(
      createPicker({ microphones, tests, preview: { ...preview, inputLevelDb: -30 } }),
    );
    expect(meter.getAttribute('aria-valuenow')).toBe('50');
    expect(meter.getAttribute('aria-valuetext')).toBe('-30 dBFS');
    picker.rerender(createPicker({ microphones, tests, preview: { ...preview, inputLevelDb: 0 } }));
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(tests.startTest).not.toHaveBeenCalled();
  });

  it('keeps microphone selection enabled during the live preview without starting a comparison', () => {
    const microphones = createMicrophones();
    const tests = createTests();
    render(createPicker({ microphones, tests, preview: createPreview({ inputLevelDb: -30 }) }));
    const radio = screen.getByRole('radio', { name: 'USB Microphone' });
    expect(radio).toHaveProperty('disabled', false);
    expect(radio.closest('fieldset')).toHaveProperty('disabled', false);
    fireEvent.click(radio);
    expect(microphones.selectMicrophone).toHaveBeenCalledExactlyOnceWith('usb');
    expect(tests.startTest).not.toHaveBeenCalled();
  });

  it('shows the OS default input preview without requiring a specific microphone', () => {
    const tests = createTests();
    render(
      createPicker({
        microphones: createMicrophones({ selectedDeviceId: defaultMicrophoneId }),
        tests,
        preview: createPreview({ activeDeviceId: defaultMicrophoneId, inputLevelDb: -30 }),
      }),
    );
    const inputLevel = screen.getByRole('region', { name: 'Input level' });
    expect(within(inputLevel).getByText('Auto-detect')).toBeTruthy();
    expect(within(inputLevel).getByRole('status').textContent).toBe('Listening');
    expect(screen.getByRole('radio', { name: 'Auto-detect' })).toHaveProperty('checked', true);
    expect(screen.getByRole('meter', { name: 'Input level' }).getAttribute('aria-valuenow')).toBe(
      '50',
    );
    expect(screen.queryByText('Choose a specific microphone below to test its input.')).toBeNull();
    expect(tests.startTest).not.toHaveBeenCalled();
  });

  it('shows startup status and clears stale levels when the preview is paused', () => {
    const preview = createPreview({ isStarting: true });
    const picker = render(createPicker({ preview }));
    const inputLevel = screen.getByRole('region', { name: 'Input level' });
    const meter = screen.getByRole('meter', { name: 'Input level' });
    expect(within(inputLevel).getByRole('status').textContent).toBe('Opening microphone…');
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    expect(meter.getAttribute('aria-valuetext')).toBe('Opening microphone…');
    picker.rerender(
      createPicker({
        canTest: false,
        preview: { ...preview, activeDeviceId: null, isStarting: false, inputLevelDb: -10 },
      }),
    );
    expect(meter.getAttribute('aria-valuenow')).toBe('0');
    expect(meter.getAttribute('aria-valuetext')).toBe('Not listening');
    expect(within(inputLevel).getByRole('status').textContent).toBe('Not listening');
    expect(screen.getByText('Input preview is paused while Tro is busy.')).toBeTruthy();
  });

  it('uses the actual comparison input and level without adding comparison controls to the bar', () => {
    render(
      createPicker({
        preview: createPreview({ inputLevelDb: -50 }),
        tests: createTests({
          activeDeviceId: 'usb',
          phase: MicrophoneTestPhase.SPEAKING,
          secondsRemaining: 3,
          inputLevelDb: -30,
        }),
      }),
    );
    const inputLevel = screen.getByRole('region', { name: 'Input level' });
    expect(within(inputLevel).getByText('USB Microphone')).toBeTruthy();
    expect(within(inputLevel).queryByText('MacBook Pro Microphone')).toBeNull();
    expect(within(inputLevel).getByRole('status').textContent).toBe('Listening');
    expect(within(inputLevel).getByRole('meter').getAttribute('aria-valuenow')).toBe('50');
    expect(screen.queryByRole('button', { name: 'Cancel test' })).toBeNull();
    expect(screen.queryByText(/Speak now/)).toBeNull();
    expect(
      screen.queryByText('“This is a microphone test. I want my voice to sound clear.”'),
    ).toBeNull();
    expect(screen.getByRole('radio', { name: 'MacBook Pro Microphone' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('keeps comparison start, instructions and cancellation in the expanded comparison tools', () => {
    const tests = createTests();
    const preview = createPreview({ inputLevelDb: -40 });
    const picker = render(createPicker({ tests, preview }));
    expect(screen.queryByRole('button', { name: 'Test USB Microphone' })).toBeNull();
    expect(tests.startTest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Compare microphones' }));
    expect(tests.startTest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test USB Microphone' }));
    expect(tests.startTest).toHaveBeenCalledExactlyOnceWith('usb');

    picker.rerender(
      createPicker({
        tests: {
          ...tests,
          activeDeviceId: 'usb',
          phase: MicrophoneTestPhase.SPEAKING,
          secondsRemaining: 3,
          inputLevelDb: -20,
        },
        preview: { ...preview, activeDeviceId: null, inputLevelDb: null },
      }),
    );
    const inputLevel = screen.getByRole('region', { name: 'Input level' });
    expect(within(inputLevel).queryByText(/Speak now/)).toBeNull();
    expect(within(inputLevel).queryByRole('button', { name: 'Cancel test' })).toBeNull();
    expect(screen.getByText('USB Microphone · Speak now · 3s')).toBeTruthy();
    expect(
      screen.getByText('“This is a microphone test. I want my voice to sound clear.”'),
    ).toBeTruthy();
    expect(
      screen.getByRole('radio', { name: 'USB Microphone' }).closest('fieldset'),
    ).toHaveProperty('disabled', true);
    vi.mocked(tests.cancelTest).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel test' }));
    expect(tests.cancelTest).toHaveBeenCalledOnce();
  });

  it('reports preview failures before the comparison tools are expanded', () => {
    render(createPicker({ preview: createPreview({ activeDeviceId: null, hasError: true }) }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not preview this microphone. Check microphone access or choose another input.',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test USB Microphone' })).toBeNull();
    expect(
      screen.getByRole('radio', { name: 'USB Microphone' }).closest('fieldset'),
    ).toHaveProperty('disabled', false);
  });
});
