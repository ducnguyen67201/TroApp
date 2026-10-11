// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthResult, AuthUser } from '#contracts/AuthSession.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import { useComputerUse } from '../../../src/desktop/renderer/UseComputerUse.js';
import { LocaleProvider } from '../../../src/desktop/renderer/localization/LocaleProvider.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../src/desktop/renderer/localization/Locale.js';

const savedUser: AuthUser = {
  id: 'saved-user',
  name: 'Alex Example',
  email: 'alex@example.test',
};
const otherUser: AuthUser = {
  id: 'other-user',
  name: 'Robin Example',
  email: 'robin@example.test',
};
const savedAccountId = '11111111-1111-4111-8111-111111111111';
const otherAccountId = '22222222-2222-4222-8222-222222222222';
const serviceFailure: AuthResult = {
  kind: 'failed',
  message: 'Could not reach the sign-in service.',
};

function createDesktopBridge() {
  return {
    readAppUpdate: vi
      .fn<DesktopBridge['readAppUpdate']>()
      .mockResolvedValue({ revision: 0, status: { state: 'disabled' } }),
    checkAppUpdate: vi
      .fn<DesktopBridge['checkAppUpdate']>()
      .mockResolvedValue({ kind: 'failed', reason: 'unavailable' }),
    downloadAppUpdate: vi
      .fn<DesktopBridge['downloadAppUpdate']>()
      .mockResolvedValue({ kind: 'failed', reason: 'unavailable' }),
    restartForAppUpdate: vi
      .fn<DesktopBridge['restartForAppUpdate']>()
      .mockResolvedValue({ kind: 'failed', reason: 'unavailable' }),
    subscribeAppUpdate: vi.fn<DesktopBridge['subscribeAppUpdate']>().mockReturnValue(() => {}),
    controlMicrophoneTest: vi
      .fn<DesktopBridge['controlMicrophoneTest']>()
      .mockResolvedValue({ kind: 'ok' }),
    subscribeMicrophoneTest: vi
      .fn<DesktopBridge['subscribeMicrophoneTest']>()
      .mockReturnValue(() => {}),
    updateVoiceMeter: vi.fn<DesktopBridge['updateVoiceMeter']>(),
    controlVoiceInput: vi.fn<DesktopBridge['controlVoiceInput']>().mockResolvedValue({
      kind: 'ok',
      status: { state: 'disabled', shortcut: 'command-control', globalShortcutAvailable: false },
    }),
    appendVoiceAudio: vi
      .fn<DesktopBridge['appendVoiceAudio']>()
      .mockResolvedValue({ kind: 'failed' }),
    subscribeVoiceInput: vi.fn<DesktopBridge['subscribeVoiceInput']>().mockReturnValue(() => {}),
    subscribeAgentProgress: vi
      .fn<DesktopBridge['subscribeAgentProgress']>()
      .mockReturnValue(() => {}),
    readSavedAccounts: vi.fn<NonNullable<DesktopBridge['readSavedAccounts']>>().mockResolvedValue({
      kind: 'accounts',
      activeAccountId: savedAccountId,
      accounts: [
        { id: savedAccountId, user: savedUser, role: null, requiresSignIn: false },
        { id: otherAccountId, user: otherUser, role: null, requiresSignIn: false },
      ],
    }),
    switchAccount: vi
      .fn<NonNullable<DesktopBridge['switchAccount']>>()
      .mockResolvedValue({ kind: 'signed-in', user: otherUser }),
    readAuthSession: vi
      .fn<DesktopBridge['readAuthSession']>()
      .mockResolvedValue({ kind: 'signed-in', user: savedUser }),
    signInWithGoogle: vi
      .fn<DesktopBridge['signInWithGoogle']>()
      .mockResolvedValue({ kind: 'signed-in', user: otherUser }),
    signOut: vi.fn<DesktopBridge['signOut']>().mockResolvedValue({ kind: 'signed-out' }),
    readDesktopPermissions: vi.fn<DesktopBridge['readDesktopPermissions']>().mockResolvedValue({
      kind: 'ready',
      accessibility: 'granted',
      screenRecording: 'granted',
    }),
    requestDesktopPermissions: vi
      .fn<DesktopBridge['requestDesktopPermissions']>()
      .mockResolvedValue({ kind: 'opened' }),
    openDesktopPermissionSettings: vi
      .fn<DesktopBridge['openDesktopPermissionSettings']>()
      .mockResolvedValue({ kind: 'opened' }),
    startCursorCompanion: vi
      .fn<DesktopBridge['startCursorCompanion']>()
      .mockResolvedValue({ kind: 'started', sessionId: savedAccountId }),
    startAgentSession: vi
      .fn<DesktopBridge['startAgentSession']>()
      .mockResolvedValue({ kind: 'started', sessionId: savedAccountId }),
    sendAgentMessage: vi
      .fn<DesktopBridge['sendAgentMessage']>()
      .mockResolvedValue({ kind: 'stopped' }),
    answerTeachingLesson: vi
      .fn<DesktopBridge['answerTeachingLesson']>()
      .mockResolvedValue({ kind: 'stopped' }),
    stopAgentSession: vi
      .fn<DesktopBridge['stopAgentSession']>()
      .mockResolvedValue({ kind: 'stopped' }),
  } satisfies DesktopBridge;
}

function createDeferredAuthResult() {
  let resolveResult: (result: AuthResult) => void = () => {};
  const promise = new Promise<AuthResult>((resolve) => {
    resolveResult = resolve;
  });
  return { promise, resolve: resolveResult };
}

async function finishInitialRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advanceTime(durationMs: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(durationMs);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
  window.tro = createDesktopBridge();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('startup account recovery', () => {
  it.each(['Could not reach the sign-in service.', 'Could not check your sign-in.'])(
    'restores the verified saved account after backend startup: %s',
    async (message) => {
      const bridge = createDesktopBridge();
      bridge.readAuthSession.mockResolvedValueOnce({ kind: 'failed', message });
      window.tro = bridge;
      const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
      expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
      await finishInitialRead();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.user).toBeNull();
      expect(result.current.message).toBeTruthy();
      expect(result.current.savedAccounts?.activeAccountId).toBe(savedAccountId);
      expect(bridge.readSavedAccounts).toHaveBeenCalled();

      await advanceTime(999);
      expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
      await advanceTime(1);
      expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
      expect(result.current.user).toEqual(savedUser);
      expect(result.current.message).toBeNull();
      expect(bridge.signInWithGoogle).not.toHaveBeenCalled();
      await advanceTime(60_000);
      expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
    },
  );

  it('recovers from a rejected startup bridge request', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockRejectedValueOnce(new Error('Backend is starting'));
    window.tro = bridge;
    const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    expect(result.current.user).toBeNull();
    expect(result.current.isLoading).toBe(false);
    await advanceTime(1000);
    expect(result.current.user).toEqual(savedUser);
    expect(result.current.message).toBeNull();
    expect(bridge.signInWithGoogle).not.toHaveBeenCalled();
  });

  it.each<AuthResult>([
    { kind: 'signed-out' },
    { kind: 'failed', message: 'Secure account storage is unavailable.' },
    { kind: 'failed', message: 'Saved account storage is unavailable.' },
    { kind: 'failed', message: 'Could not read your sign-in.' },
    { kind: 'failed', message: 'An unknown persistent failure.' },
  ])('does not retry a terminal startup result: $kind $message', async (authResult) => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue(authResult);
    window.tro = bridge;
    const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    await advanceTime(120_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.message === null).toBe(authResult.kind === 'signed-out');
  });

  it('backs off persistent service failures and stops starting reads after one minute', async () => {
    const bridge = createDesktopBridge();
    const attemptTimes: number[] = [];
    bridge.readAuthSession.mockImplementation(() => {
      attemptTimes.push(Date.now());
      return Promise.resolve(serviceFailure);
    });
    window.tro = bridge;
    const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    await advanceTime(60_000);
    expect(attemptTimes.slice(0, 5)).toEqual([0, 1000, 3000, 7000, 12_000]);
    expect(attemptTimes.length).toBeGreaterThan(5);
    expect(attemptTimes.every((time) => time < 60_000)).toBe(true);
    const completedAttempts = bridge.readAuthSession.mock.calls.length;
    await advanceTime(120_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(completedAttempts);
    expect(result.current.user).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.message).toBe('Could not reach the sign-in service.');
  });

  it('waits for each verification reply before scheduling another read', async () => {
    const bridge = createDesktopBridge();
    const pending = createDeferredAuthResult();
    bridge.readAuthSession
      .mockResolvedValueOnce(serviceFailure)
      .mockReturnValueOnce(pending.promise);
    window.tro = bridge;
    const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    await advanceTime(1000);
    await advanceTime(20_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
    expect(result.current.user).toBeNull();
    await act(async () => {
      pending.resolve(serviceFailure);
      await Promise.resolve();
    });
    await advanceTime(1999);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
    await advanceTime(1);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(3);
    expect(result.current.user).toEqual(savedUser);
  });

  it('cancels queued recovery when unmounted', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValueOnce(serviceFailure);
    window.tro = bridge;
    const { unmount } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    unmount();
    await advanceTime(120_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
  });

  it('ignores a verification reply that arrives after unmount', async () => {
    const bridge = createDesktopBridge();
    const pending = createDeferredAuthResult();
    bridge.readAuthSession
      .mockResolvedValueOnce(serviceFailure)
      .mockReturnValueOnce(pending.promise);
    window.tro = bridge;
    const { unmount } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    await advanceTime(1000);
    const metadataReads = bridge.readSavedAccounts.mock.calls.length;
    unmount();
    await act(async () => {
      pending.resolve({ kind: 'signed-in', user: savedUser });
      await Promise.resolve();
    });
    await advanceTime(120_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
    expect(bridge.readSavedAccounts).toHaveBeenCalledTimes(metadataReads);
  });

  it('cancels queued recovery when Google sign-in succeeds', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValueOnce(serviceFailure);
    window.tro = bridge;
    const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    await act(async () => {
      await result.current.signInWithGoogle();
    });
    await advanceTime(120_000);
    expect(result.current.user).toEqual(otherUser);
    expect(result.current.message).toBeNull();
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
    expect(bridge.signInWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('preserves a newer account-action error when an old verification fails', async () => {
    const bridge = createDesktopBridge();
    const pending = createDeferredAuthResult();
    bridge.readAuthSession
      .mockResolvedValueOnce(serviceFailure)
      .mockReturnValueOnce(pending.promise);
    bridge.signInWithGoogle.mockResolvedValue({
      kind: 'failed',
      message: 'Could not open Google sign-in.',
    });
    window.tro = bridge;
    const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
    await finishInitialRead();
    await advanceTime(1000);
    await act(async () => {
      await result.current.signInWithGoogle();
    });
    const accountError = result.current.message;
    expect(accountError).toBeTruthy();
    await act(async () => {
      pending.resolve(serviceFailure);
      await Promise.resolve();
    });
    await advanceTime(120_000);
    expect(result.current.message).toBe(accountError);
    expect(result.current.user).toBeNull();
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
  });

  it.each(['Google sign-in', 'account switch', 'sign-out'])(
    'discards a pending startup reply superseded by %s',
    async (accountAction) => {
      const bridge = createDesktopBridge();
      const pending = createDeferredAuthResult();
      bridge.readAuthSession
        .mockResolvedValueOnce(serviceFailure)
        .mockReturnValueOnce(pending.promise);
      window.tro = bridge;
      const { result } = renderHook(useComputerUse, { wrapper: LocaleProvider });
      await finishInitialRead();
      await advanceTime(1000);
      await act(async () => {
        if (accountAction === 'Google sign-in') {
          await result.current.signInWithGoogle();
        } else if (accountAction === 'account switch') {
          await result.current.switchAccount(otherAccountId);
        } else {
          await result.current.signOut();
        }
      });
      const expectedUser = accountAction === 'sign-out' ? null : otherUser;
      expect(result.current.user).toEqual(expectedUser);
      const metadataReads = bridge.readSavedAccounts.mock.calls.length;
      await act(async () => {
        pending.resolve({ kind: 'signed-in', user: savedUser });
        await Promise.resolve();
      });
      await advanceTime(120_000);
      expect(result.current.user).toEqual(expectedUser);
      expect(result.current.message).toBeNull();
      expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
      expect(bridge.readSavedAccounts).toHaveBeenCalledTimes(metadataReads);
    },
  );
});
