import { OnboardingService } from '../../../src/desktop/onboarding/application/OnboardingService.js';
import type { OnboardingStore } from '../../../src/desktop/onboarding/application/OnboardingStore.js';
import { createOnboardingProgress } from '../../../src/desktop/onboarding/domain/OnboardingProgress.js';
import type { OnboardingProgress } from '#contracts/Onboarding.js';
import { OnboardingAction } from '#contracts/OnboardingValues.js';
import { MaterialEditor } from '../../../src/desktop/renderer/classroom/MaterialEditor.js';
import {
  MaterialState,
  type MaterialCollection,
  type MaterialReply,
} from '#contracts/ClassroomMaterials.js';
// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentDeviceMode } from '#contracts/StudentIdentity.js';
import { AccountRole } from '#contracts/AccountRole.js';
import { OrganizationAction, type OrganizationReply } from '#contracts/Organizations.js';
import { createTeachingContext } from '../../server/features/classroom/ClassroomFixtures.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import type { AccountReply } from '#contracts/DesktopAccounts.js';
import type { AuthResult, AuthUser } from '#contracts/AuthSession.js';
import type { AgentResult } from '#contracts/AgentSession.js';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { VoiceShortcut, VoiceState, type VoiceReply } from '#contracts/VoiceInput.js';
import {
  AppUpdateState,
  type AppUpdateSnapshot,
  type AppUpdateReply,
} from '#contracts/AppUpdate.js';
import { CompletionMode, TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import { microphoneStorageKey } from '../../../src/desktop/renderer/voice/Microphones.js';
import { App } from '../../../src/desktop/renderer/App.js';
import { AnalyticsScreen } from '#contracts/Analytics.js';
import {
  DesktopPermissionState,
  PermissionGrant,
  type DesktopPermissionStatus,
} from '#contracts/DesktopPermissions.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../src/desktop/renderer/localization/Locale.js';
import { LocaleProvider } from '../../../src/desktop/renderer/localization/LocaleProvider.js';
import { desktopTheme, resolveDesktopCssVariables } from '../../../src/desktop/renderer/Theme.js';

const testUser = {
  id: 'test-user',
  name: 'Alex Example',
  email: 'alex@example.test',
  isAdmin: false,
} satisfies AuthUser;
const sessionId = 'a8f6d44a-5c18-4ce3-9237-44624549f63f';

const microphonePreviews = vi.hoisted(() => ({
  instances: new Array<{
    receive: (levelDb: number) => void;
    dispose: () => void;
  }>(),
  startPreview: vi.fn<(deviceId: string) => Promise<void>>().mockResolvedValue(),
}));

vi.mock('../../../src/desktop/renderer/voice/MicrophonePreviewCapture.js', () => ({
  MicrophonePreviewCapture: class {
    dispose = vi.fn<() => void>();
    startPreview = microphonePreviews.startPreview;

    constructor(readonly receive: (levelDb: number) => void) {
      microphonePreviews.instances.push(this);
    }
  },
}));

function createDesktopBridge() {
  return {
    controlClassroom: vi.fn<NonNullable<DesktopBridge['controlClassroom']>>().mockResolvedValue({
      kind: 'home',
      home: { role: AccountRole.STUDENT, isAdmin: false, courses: [], classes: [] },
    }),
    readAppUpdate: vi
      .fn<DesktopBridge['readAppUpdate']>()
      .mockResolvedValue({ revision: 0, status: { state: AppUpdateState.DISABLED } }),
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
    controlVoiceInput: vi.fn<DesktopBridge['controlVoiceInput']>().mockImplementation((command) =>
      Promise.resolve<VoiceReply>({
        kind: 'ok',
        status: {
          state: command.kind === 'enable' ? 'idle' : 'disabled',
          shortcut: 'command-control',
          globalShortcutAvailable: command.kind === 'enable',
        },
      }),
    ),
    appendVoiceAudio: vi
      .fn<DesktopBridge['appendVoiceAudio']>()
      .mockResolvedValue({ kind: 'failed' }),
    subscribeVoiceInput: vi.fn<DesktopBridge['subscribeVoiceInput']>().mockReturnValue(() => {}),
    subscribeAgentProgress: vi
      .fn<DesktopBridge['subscribeAgentProgress']>()
      .mockReturnValue(() => {}),
    readAuthSession: vi
      .fn<DesktopBridge['readAuthSession']>()
      .mockResolvedValue({ kind: 'signed-in', user: testUser }),
    signInWithGoogle: vi
      .fn<DesktopBridge['signInWithGoogle']>()
      .mockResolvedValue({ kind: 'signed-in', user: testUser }),
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
      .mockResolvedValue({ kind: 'started', sessionId: '11111111-1111-4111-8111-111111111111' }),
    startAgentSession: vi
      .fn<DesktopBridge['startAgentSession']>()
      .mockResolvedValue({ kind: 'started', sessionId }),
    sendAgentMessage: vi.fn<DesktopBridge['sendAgentMessage']>().mockResolvedValue({
      kind: 'completed',
      completion: { kind: 'response' },
      answer: 'Here is your answer.',
    }),
    answerTeachingLesson: vi.fn<DesktopBridge['answerTeachingLesson']>(),
    stopAgentSession: vi
      .fn<DesktopBridge['stopAgentSession']>()
      .mockResolvedValue({ kind: 'stopped' }),
  } satisfies DesktopBridge;
}

function renderDesktop(): void {
  render(
    createElement(MantineProvider, {
      theme: desktopTheme,
      cssVariablesResolver: resolveDesktopCssVariables,
      forceColorScheme: 'light',
      env: 'test',
      children: createElement(LocaleProvider, { children: createElement(App) }),
    }),
  );
}

beforeAll(() => {
  /* happy-dom has no FontFaceSet; Mantine's autosizing textarea listens for
     font load events that real Electron/Chromium provides. */
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
});

afterAll(() => {
  Reflect.deleteProperty(document, 'fonts');
});

beforeEach(() => {
  microphonePreviews.instances.length = 0;
  microphonePreviews.startPreview.mockClear();
  window.location.hash = '#/workspace';
  window.localStorage.clear();
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
  window.tro = createDesktopBridge();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('optional usage sharing', () => {
  function createAnalyticsBridge(configured = true) {
    return {
      ...createDesktopBridge(),
      readAnalyticsStatus: vi
        .fn<NonNullable<DesktopBridge['readAnalyticsStatus']>>()
        .mockResolvedValue({ kind: 'ok', status: { configured, enabled: false } }),
      setAnalyticsEnabled: vi
        .fn<NonNullable<DesktopBridge['setAnalyticsEnabled']>>()
        .mockImplementation((enabled) =>
          Promise.resolve({ kind: 'ok', status: { configured, enabled } }),
        ),
      trackScreenView: vi.fn<NonNullable<DesktopBridge['trackScreenView']>>().mockResolvedValue(),
    } satisfies DesktopBridge;
  }

  it.each([
    { locale: DesktopLocale.ENGLISH, settingsLabel: 'Settings', sharingLabel: 'Share app usage' },
    {
      locale: DesktopLocale.VIETNAMESE,
      settingsLabel: 'Cài đặt',
      sharingLabel: 'Chia sẻ dữ liệu sử dụng',
    },
  ])(
    'keeps $settingsLabel open when the initial permission read finishes',
    async ({ locale, settingsLabel, sharingLabel }) => {
      window.localStorage.setItem(localeStorageKey, locale);
      const bridge = createAnalyticsBridge();
      let completePermissionRead: (status: DesktopPermissionStatus) => void = () => {
        throw new Error('Permission read was not initialized.');
      };
      const permissionRead = new Promise<DesktopPermissionStatus>((resolve) => {
        completePermissionRead = resolve;
      });
      bridge.readDesktopPermissions.mockReturnValue(permissionRead);
      const reactErrors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
        if (typeof message === 'string') {
          reactErrors.push(message);
        }
      });
      window.tro = bridge;
      renderDesktop();
      await screen.findByText(testUser.email);
      fireEvent.click(screen.getByRole('button', { name: settingsLabel }));
      expect(await screen.findByRole('switch', { name: sharingLabel })).toBeTruthy();
      await act(async () => {
        completePermissionRead({
          kind: DesktopPermissionState.READY,
          accessibility: PermissionGrant.GRANTED,
          screenRecording: PermissionGrant.GRANTED,
        });
        await permissionRead;
      });
      expect(screen.getByRole('dialog', { name: settingsLabel })).toBeTruthy();
      fireEvent.click(screen.getByRole('switch', { name: sharingLabel }));
      await waitFor(() => {
        expect(bridge.setAnalyticsEnabled).toHaveBeenCalledWith(true);
      });
      expect(reactErrors.some((message) => message.includes('same key'))).toBe(false);
    },
  );

  it.each([DesktopPermissionState.NEEDS_PERMISSION, DesktopPermissionState.UNKNOWN])(
    'still closes Settings after a verified recovery from %s',
    async (initialKind) => {
      const bridge = createAnalyticsBridge();
      bridge.readDesktopPermissions.mockResolvedValueOnce({
        kind: initialKind,
        accessibility:
          initialKind === DesktopPermissionState.NEEDS_PERMISSION
            ? PermissionGrant.MISSING
            : PermissionGrant.UNKNOWN,
        screenRecording: PermissionGrant.GRANTED,
      });
      window.tro = bridge;
      renderDesktop();
      await screen.findByRole('heading', { name: 'Give Tro access to your desktop.' });
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
      fireEvent.focus(window);
      await screen.findByRole('textbox', { name: 'Your message' });
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
      });
    },
  );

  it('explains installation sharing and keeps it unavailable without a project', async () => {
    const bridge = createAnalyticsBridge(false);
    window.tro = bridge;
    renderDesktop();
    await screen.findByText(testUser.email);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('switch', { name: 'Share app usage' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Names, emails, screenshots, audio and student work/)).toHaveProperty(
      'textContent',
      expect.stringContaining('all accounts on this installation'),
    );
    expect(bridge.trackScreenView).not.toHaveBeenCalled();
  });

  it('tracks the enabled default without opening settings or a first-launch sharing prompt', async () => {
    const bridge = createAnalyticsBridge();
    bridge.readAnalyticsStatus.mockResolvedValue({
      kind: 'ok',
      status: { configured: true, enabled: true },
    });
    window.tro = bridge;
    renderDesktop();
    await screen.findByText(testUser.email);
    await waitFor(() => {
      expect(bridge.trackScreenView).toHaveBeenCalledExactlyOnceWith(AnalyticsScreen.WORKSPACE);
    });
    expect(bridge.setAnalyticsEnabled).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Share app usage' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('switch', { name: 'Share app usage' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByText(/On by default/)).toBeTruthy();
  });

  it('tracks only fixed screen names after re-enabling and stops after opt-out', async () => {
    const bridge = createAnalyticsBridge();
    window.tro = bridge;
    renderDesktop();
    await screen.findByText(testUser.email);
    expect(bridge.trackScreenView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Share app usage' }));
    await waitFor(() => {
      expect(bridge.trackScreenView).toHaveBeenCalledExactlyOnceWith(AnalyticsScreen.WORKSPACE);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Classroom' }));
    await waitFor(() => {
      expect(bridge.trackScreenView).toHaveBeenLastCalledWith(AnalyticsScreen.CLASSROOM);
    });
    act(() => {
      window.location.hash = '#/classroom/11111111-1111-4111-8111-111111111111';
    });
    await waitFor(() => {
      expect(window.location.hash).toContain('11111111');
    });
    expect(bridge.trackScreenView.mock.calls).toEqual([
      [AnalyticsScreen.WORKSPACE],
      [AnalyticsScreen.CLASSROOM],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Share app usage' }));
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Share app usage' })).toHaveProperty(
        'checked',
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    expect(bridge.trackScreenView).toHaveBeenCalledTimes(2);
  });

  it('shows and retries a save error in Vietnamese without silently enabling sharing', async () => {
    window.localStorage.setItem(localeStorageKey, DesktopLocale.VIETNAMESE);
    const bridge = createAnalyticsBridge();
    bridge.setAnalyticsEnabled.mockResolvedValueOnce({ kind: 'failed' });
    window.tro = bridge;
    renderDesktop();
    await screen.findByText(testUser.email);
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    fireEvent.click(await screen.findByRole('switch', { name: 'Chia sẻ dữ liệu sử dụng' }));
    await screen.findByText(/Không thể lưu tùy chọn này/);
    expect(screen.getByRole('switch', { name: 'Chia sẻ dữ liệu sử dụng' })).toHaveProperty(
      'checked',
      false,
    );
    expect(bridge.trackScreenView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Thử lại$/ }));
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Chia sẻ dữ liệu sử dụng' })).toHaveProperty(
        'checked',
        true,
      );
    });
    expect(bridge.setAnalyticsEnabled).toHaveBeenLastCalledWith(true);
    expect(screen.queryByText(/Không thể lưu tùy chọn này/)).toBeNull();
  });
});

describe('startup sign-in checks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  async function advanceSignInCheckTime(durationMs: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(durationMs);
    });
  }

  it.each([
    {
      kind: 'failed',
      message: 'Could not reach the sign-in service.',
      retryable: true,
    } satisfies AuthResult,
    { kind: 'pending' } satisfies AuthResult,
  ])(
    'restores the saved session after a transient $kind result without an alert',
    async (initial) => {
      const bridge = createDesktopBridge();
      bridge.readAuthSession.mockResolvedValueOnce(initial);
      window.tro = bridge;
      renderDesktop();
      await advanceSignInCheckTime(0);
      expect(screen.getByText('Checking sign-in…')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull();
      await advanceSignInCheckTime(999);
      expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
      await advanceSignInCheckTime(1);
      expect(screen.getByRole('heading', { name: 'Welcome back, Alex' })).toBeTruthy();
      expect(screen.getByText(testUser.email)).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(bridge.readAuthSession).toHaveBeenCalledTimes(2);
      expect(bridge.signInWithGoogle).not.toHaveBeenCalled();
    },
  );

  it('stops automatic checks after the startup window and retries on request without opening Google', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue({
      kind: 'failed',
      message: 'Could not reach the sign-in service.',
      retryable: true,
    });
    let finishSavedAccountsRead: ((result: AccountReply) => void) | undefined;
    const pendingSavedAccounts = new Promise<AccountReply>((resolve) => {
      finishSavedAccountsRead = resolve;
    });
    const readSavedAccounts = vi
      .fn<NonNullable<DesktopBridge['readSavedAccounts']>>()
      .mockResolvedValue({
        kind: 'accounts',
        accounts: [
          { id: sessionId, user: testUser, role: AccountRole.STUDENT, requiresSignIn: false },
        ],
        activeAccountId: sessionId,
      })
      .mockImplementationOnce(() => pendingSavedAccounts);
    window.tro = { ...bridge, readSavedAccounts };
    renderDesktop();
    await advanceSignInCheckTime(14_999);
    expect(screen.getByText('Checking sign-in…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await advanceSignInCheckTime(1);
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the sign-in service.');
    const completedChecks = bridge.readAuthSession.mock.calls.length;
    await advanceSignInCheckTime(30_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(completedChecks);

    let finishRetry: ((result: AuthResult) => void) | undefined;
    const pendingRetry = new Promise<AuthResult>((resolve) => {
      finishRetry = resolve;
    });
    bridge.readAuthSession.mockImplementationOnce(() => pendingRetry);
    const retryButton = screen.getByRole('button', { name: 'Retry sign-in check' });
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });
    await advanceSignInCheckTime(0);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(completedChecks + 1);
    expect(screen.getByText('Checking sign-in…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(bridge.signInWithGoogle).not.toHaveBeenCalled();
    expect(bridge.signOut).not.toHaveBeenCalled();
    await act(async () => {
      finishRetry?.({
        kind: 'failed',
        message: 'Could not reach the sign-in service.',
        retryable: true,
      });
      await pendingRetry;
    });
    bridge.readAuthSession.mockResolvedValue({ kind: 'signed-in', user: testUser });
    await advanceSignInCheckTime(1000);
    expect(screen.getByRole('heading', { name: 'Welcome back, Alex' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(completedChecks + 2);
    expect(readSavedAccounts).toHaveBeenCalledTimes(2);
    expect(bridge.signInWithGoogle).not.toHaveBeenCalled();
    expect(bridge.signOut).not.toHaveBeenCalled();
    await act(async () => {
      finishSavedAccountsRead?.({ kind: 'failed', message: 'Could not load saved accounts.' });
      await pendingSavedAccounts;
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Welcome back, Alex' })).toBeTruthy();
  });

  it('offers a manual retry when the initial session stays pending past the startup window', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue({ kind: 'pending' });
    window.tro = bridge;
    renderDesktop();
    await advanceSignInCheckTime(15_000);
    expect(screen.getByRole('alert').textContent).toContain('Could not check sign-in.');
    expect(screen.getByRole('button', { name: 'Retry sign-in check' })).toBeTruthy();
    const completedChecks = bridge.readAuthSession.mock.calls.length;
    await advanceSignInCheckTime(10_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(completedChecks);
  });

  it.each([
    { kind: 'signed-out' } satisfies AuthResult,
    { kind: 'failed', message: 'Could not reach the sign-in service.' } satisfies AuthResult,
  ])('does not automatically retry a $kind result without retry permission', async (initial) => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue(initial);
    window.tro = bridge;
    renderDesktop();
    await advanceSignInCheckTime(0);
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    expect(screen.queryByText('Checking sign-in…')).toBeNull();
    if (initial.kind === 'failed') {
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not reach the sign-in service.',
      );
    } else {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry sign-in check' })).toBeNull();
    }
    await advanceSignInCheckTime(30_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
  });

  it('cancels a scheduled startup retry when the app unmounts', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue({
      kind: 'failed',
      message: 'Could not reach the sign-in service.',
      retryable: true,
    });
    window.tro = bridge;
    renderDesktop();
    await advanceSignInCheckTime(0);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
    cleanup();
    await advanceSignInCheckTime(30_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
  });

  it('ignores an initial session reply received after the app unmounts', async () => {
    const bridge = createDesktopBridge();
    let finishSessionRead: ((result: AuthResult) => void) | undefined;
    const pendingSessionRead = new Promise<AuthResult>((resolve) => {
      finishSessionRead = resolve;
    });
    bridge.readAuthSession.mockImplementationOnce(() => pendingSessionRead);
    const readSavedAccounts = vi
      .fn<NonNullable<DesktopBridge['readSavedAccounts']>>()
      .mockResolvedValue({ kind: 'accounts', accounts: [], activeAccountId: null });
    window.tro = { ...bridge, readSavedAccounts };
    renderDesktop();
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
    await advanceSignInCheckTime(5000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
    cleanup();
    await act(async () => {
      finishSessionRead?.({
        kind: 'failed',
        message: 'Could not reach the sign-in service.',
        retryable: true,
      });
      await pendingSessionRead;
    });
    await advanceSignInCheckTime(30_000);
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
    expect(readSavedAccounts).not.toHaveBeenCalled();
  });
});

describe('desktop scaffold', () => {
  it('hides the sidebar until Google returns and enters the workspace', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValueOnce({ kind: 'signed-out' });
    bridge.signInWithGoogle.mockResolvedValue({ kind: 'pending' });
    window.tro = bridge;
    renderDesktop();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(document.querySelector('.desktop-sidebar')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await screen.findByRole('button', { name: 'Waiting for Google…' });
    expect(screen.queryByRole('navigation')).toBeNull();
    const account = await screen.findByRole('region', { name: 'Your account' });
    await waitFor(
      () => {
        expect(within(account).getByText(testUser.email)).toBeTruthy();
      },
      { timeout: 2500 },
    );
    await screen.findByRole('heading', { name: 'Welcome back, Alex' });
    expect(bridge.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
  });

  it('shows the signed-in account in the sidebar and classroom navigation and account role', async () => {
    renderDesktop();
    const account = await screen.findByRole('region', { name: 'Your account' });
    await within(account).findByText(testUser.email);
    expect(within(account).getByText(testUser.name)).toBeTruthy();
    expect(within(account).getByRole('button', { name: 'Switch account' })).toBeTruthy();
    expect(within(account).queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Workspace' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Guided Lessons (Beta)' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Welcome back, Alex' })).toBeTruthy();
  });

  it('does not offer retired lesson navigation for Vietnamese accounts', async () => {
    window.localStorage.setItem(localeStorageKey, DesktopLocale.VIETNAMESE);
    renderDesktop();
    await screen.findByRole('button', { name: 'Lớp học' });
    expect(screen.queryByRole('button', { name: 'Bài giảng hướng dẫn (Thử nghiệm)' })).toBeNull();
  });

  it('preserves the draft, messages and session when switching to Settings and back', async () => {
    const bridge = createDesktopBridge();
    window.tro = bridge;
    renderDesktop();
    const input = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(input, { target: { value: 'Help with this app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await screen.findByText('Here is your answer.');
    fireEvent.change(input, { target: { value: 'A draft to keep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(settings).getByRole('tab', { name: 'Account' }));
    expect(within(settings).getByText(testUser.email)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.getByText('Here is your answer.')).toBeTruthy();
    const restoredInput = screen.getByRole('textbox', { name: 'Your message' });
    expect(restoredInput).toHaveProperty('value', 'A draft to keep');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await waitFor(() => {
      expect(bridge.sendAgentMessage).toHaveBeenCalledTimes(2);
    });
    expect(bridge.startAgentSession).toHaveBeenCalledTimes(1);
    expect(bridge.sendAgentMessage).toHaveBeenLastCalledWith(
      sessionId,
      'A draft to keep',
      DesktopLocale.ENGLISH,
      AgentTaskMode.TEACH,
    );
    expect(bridge.stopAgentSession).not.toHaveBeenCalled();
  });

  it('shows compact General preferences and switches to Account without leaving the workspace', async () => {
    const bridge = createDesktopBridge();
    window.tro = bridge;
    renderDesktop();
    const input = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(within(dialog).getByText('Command + Control')).toBeTruthy();
    expect(within(dialog).getByText('Auto-detect')).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Language' })).toHaveProperty(
      'value',
      'en',
    );
    expect(within(dialog).getByText('Light')).toBeTruthy();
    expect(within(dialog).queryByText(testUser.email)).toBeNull();
    const petsTab = within(dialog).getByRole('tab', { name: 'Pets' });
    act(() => {
      petsTab.focus();
    });
    fireEvent.keyDown(petsTab, { key: 'ArrowDown' });
    expect(within(dialog).getByRole('tab', { name: 'Account' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: 'Account' }));
    expect(within(dialog).getByText(testUser.email)).toBeTruthy();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'General' }));
    expect(within(dialog).getByRole('combobox', { name: 'Language' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close settings' }));
    expect(screen.getByRole('textbox', { name: 'Your message' })).toBe(input);
    expect(input).toHaveProperty('value', 'Keep this draft');
    expect(bridge.startAgentSession).not.toHaveBeenCalled();
  });

  it('clears account, draft and conversation after successful account-menu sign-out', async () => {
    const bridge = createDesktopBridge();
    window.tro = bridge;
    renderDesktop();
    const input = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(input, { target: { value: 'A private task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await screen.findByText('Here is your answer.');
    fireEvent.change(input, { target: { value: 'A private draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of this account' }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(screen.queryByText(testUser.email)).toBeNull();
    expect(screen.queryByText('Here is your answer.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByRole('textbox', { name: 'Your message' });
    expect(screen.getByRole('textbox', { name: 'Your message' })).toHaveProperty('value', '');
    expect(screen.queryByText('Here is your answer.')).toBeNull();
    expect(bridge.signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the account menu disabled during an active task, including on Settings', async () => {
    const bridge = createDesktopBridge();
    let completeTask: ((result: AgentResult) => void) | undefined;
    bridge.sendAgentMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeTask = resolve;
        }),
    );
    window.tro = bridge;
    renderDesktop();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your message' }), {
      target: { value: 'Do this task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await waitFor(() => {
      expect(bridge.sendAgentMessage).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Switch account', hidden: true })).toHaveProperty(
      'disabled',
      true,
    );
    completeTask?.({
      kind: 'completed',
      completion: { kind: 'response' },
      answer: 'Task finished.',
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Switch account', hidden: true })).toHaveProperty(
        'disabled',
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.getByText('Task finished.')).toBeTruthy();
  });

  it('shows sign-out failures without hiding the account', async () => {
    const bridge = createDesktopBridge();
    bridge.signOut.mockRejectedValue(new Error('Unavailable'));
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Switch account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of this account' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Could not sign out.'),
    );
    expect(screen.getByText(testUser.email)).toBeTruthy();
  });

  it('recovers from an initial session read failure and allows Google sign-in', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockRejectedValue(new Error('Unavailable'));
    window.tro = bridge;
    renderDesktop();
    await screen.findByRole('alert');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await screen.findByText(testUser.email);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows setup after sign-in and enters the workspace only after both grants are verified', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValueOnce({ kind: 'signed-out' });
    bridge.readDesktopPermissions
      .mockResolvedValueOnce({
        kind: 'needs-permission',
        accessibility: 'missing',
        screenRecording: 'granted',
      })
      .mockResolvedValueOnce({
        kind: 'ready',
        accessibility: 'granted',
        screenRecording: 'granted',
      });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }));
    await screen.findByRole('heading', { name: 'Give Tro access to your desktop.' });
    expect(screen.queryByRole('textbox', { name: 'Your message' })).toBeNull();
    expect(bridge.startAgentSession).not.toHaveBeenCalled();
    expect(bridge.startCursorCompanion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Ask for permission' }));
    await waitFor(() => {
      expect(bridge.requestDesktopPermissions).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByRole('heading', { name: 'Welcome back, Alex' });
    expect(screen.getByRole('textbox', { name: 'Your message' })).toBeTruthy();
  });

  it('keeps an unknown permission status in setup and rechecks when Tro regains focus', async () => {
    const bridge = createDesktopBridge();
    bridge.readDesktopPermissions.mockResolvedValue({
      kind: 'unknown',
      accessibility: 'unknown',
      screenRecording: 'unknown',
    });
    window.tro = bridge;
    renderDesktop();
    await screen.findByRole('heading', { name: 'Give Tro access to your desktop.' });
    expect(screen.getAllByText('Not verified')).toHaveLength(2);
    const screenRecordingButton = screen.getAllByRole('button', { name: 'Open Settings' })[1];
    if (!screenRecordingButton) throw new Error('Screen Recording settings button is missing.');
    fireEvent.click(screenRecordingButton);
    await waitFor(() => {
      expect(bridge.openDesktopPermissionSettings).toHaveBeenCalledWith('screen-recording');
    });
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => {
      expect(bridge.readDesktopPermissions).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByRole('textbox', { name: 'Your message' })).toBeNull();
  });
});

describe('desktop language', () => {
  it('translates permission onboarding and keeps its status when the language changes', async () => {
    window.localStorage.clear();
    const bridge = createDesktopBridge();
    bridge.readDesktopPermissions.mockResolvedValue({
      kind: 'needs-permission',
      accessibility: 'missing',
      screenRecording: 'granted',
    });
    window.tro = bridge;
    renderDesktop();
    await screen.findByRole('heading', { name: 'Cho phép Tro truy cập máy tính của bạn.' });
    expect(await screen.findByText('Chưa bật')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Ngôn ngữ' }), {
      target: { value: 'en' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.getByRole('heading', { name: 'Give Tro access to your desktop.' })).toBeTruthy();
    expect(screen.getByText('Not enabled')).toBeTruthy();
    expect(bridge.readDesktopPermissions).toHaveBeenCalledTimes(1);
  });

  it('defaults to Vietnamese and exposes the language setting before sign-in', async () => {
    window.localStorage.clear();
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue({ kind: 'signed-out' });
    window.tro = bridge;
    renderDesktop();
    expect(await screen.findByRole('button', { name: 'Tiếp tục với Google' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('vi');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    const language = screen.getByRole('combobox', { name: 'Ngôn ngữ' });
    expect(language).toHaveProperty('value', 'vi');
    expect(within(language).getByRole('option', { name: 'Tiếng Việt' })).toBeTruthy();
    expect(within(language).getByRole('option', { name: 'English' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chọn micrô' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('tab', { name: 'Tài khoản' }));
    expect(screen.getByText('Đăng nhập để xem tài khoản của bạn.')).toBeTruthy();
  });

  it('switches immediately, preserves draft and messages, and restores the saved locale', async () => {
    window.localStorage.clear();
    const bridge = createDesktopBridge();
    window.tro = bridge;
    renderDesktop();
    const input = await screen.findByRole('textbox', { name: 'Tin nhắn của bạn' });
    fireEvent.change(input, { target: { value: 'Một tác vụ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi cho Tro' }));
    await screen.findByText('Here is your answer.');
    fireEvent.change(input, { target: { value: 'Bản nháp tiếng Việt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Ngôn ngữ' }), {
      target: { value: 'en' },
    });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(window.localStorage.getItem(localeStorageKey)).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.getByRole('textbox', { name: 'Your message' })).toHaveProperty(
      'value',
      'Bản nháp tiếng Việt',
    );
    expect(screen.getByText('Here is your answer.')).toBeTruthy();
    expect(bridge.stopAgentSession).not.toHaveBeenCalled();
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
    cleanup();
    renderDesktop();
    await screen.findByRole('textbox', { name: 'Your message' });
    expect(document.documentElement.lang).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), {
      target: { value: 'vi' },
    });
    expect(screen.getByRole('heading', { name: 'Cài đặt' })).toBeTruthy();
    expect(window.localStorage.getItem(localeStorageKey)).toBe('vi');
    cleanup();
    renderDesktop();
    expect(await screen.findByRole('heading', { name: 'Chào mừng trở lại, Alex' })).toBeTruthy();
  });

  it('keeps an active task running while switching languages in Settings', async () => {
    const bridge = createDesktopBridge();
    let completeTask: ((result: AgentResult) => void) | undefined;
    bridge.sendAgentMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeTask = resolve;
        }),
    );
    window.tro = bridge;
    renderDesktop();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your message' }), {
      target: { value: 'Keep working' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await waitFor(() => {
      expect(bridge.sendAgentMessage).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), {
      target: { value: 'vi' },
    });
    expect(screen.getByRole('button', { name: 'Chuyển tài khoản', hidden: true })).toHaveProperty(
      'disabled',
      true,
    );
    expect(bridge.stopAgentSession).not.toHaveBeenCalled();
    completeTask?.({
      kind: 'completed',
      completion: { kind: 'response' },
      answer: 'Completed in the original language.',
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Chuyển tài khoản', hidden: true })).toHaveProperty(
        'disabled',
        false,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Đóng cài đặt' }));
    expect(screen.getByText('Completed in the original language.')).toBeTruthy();
    expect(screen.getByText('Keep working')).toBeTruthy();
    expect(bridge.sendAgentMessage).toHaveBeenLastCalledWith(
      sessionId,
      'Keep working',
      DesktopLocale.ENGLISH,
      AgentTaskMode.TEACH,
    );
    bridge.sendAgentMessage.mockResolvedValue({
      kind: 'completed',
      completion: { kind: 'response' },
      answer: 'Đã hoàn tất.',
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tin nhắn của bạn' }), {
      target: { value: 'Mở YouTube' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gửi cho Tro' }));
    await waitFor(() => {
      expect(bridge.sendAgentMessage).toHaveBeenCalledTimes(2);
    });
    expect(bridge.sendAgentMessage).toHaveBeenLastCalledWith(
      sessionId,
      'Mở YouTube',
      DesktopLocale.VIETNAMESE,
      AgentTaskMode.TEACH,
    );
    expect(await screen.findByText('Đã hoàn tất.')).toBeTruthy();
    expect(bridge.startAgentSession).toHaveBeenCalledTimes(1);
  });

  it.each(['fr', '', 'toString', '{"locale":"en"}'])(
    'uses Vietnamese for unsupported saved preference %s',
    async (value) => {
      window.localStorage.setItem(localeStorageKey, value);
      renderDesktop();
      expect(await screen.findByRole('heading', { name: 'Chào mừng trở lại, Alex' })).toBeTruthy();
      expect(document.documentElement.lang).toBe('vi');
    },
  );

  it('still works when local preferences cannot be read or saved', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('Blocked');
    });
    renderDesktop();
    await screen.findByRole('heading', { name: 'Chào mừng trở lại, Alex' });
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Ngôn ngữ' }), {
      target: { value: 'en' },
    });
    expect(document.documentElement.lang).toBe('en');
    expect(
      within(screen.getByRole('dialog', { name: 'Settings' }))
        .getAllByRole('status')
        .map((status) => status.textContent),
    ).toContain('The language changed for now, but could not be saved on this device.');
  });

  it('translates bridge errors and retranslates an existing alert when the language changes', async () => {
    window.localStorage.clear();
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue({
      kind: 'failed',
      message: 'Could not reach the sign-in service.',
    });
    window.tro = bridge;
    renderDesktop();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Không thể kết nối với dịch vụ đăng nhập.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Ngôn ngữ' }), {
      target: { value: 'en' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the sign-in service.');
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'In class, choose Show me so you perform the learning actions.',
      'Trong lớp học, hãy chọn “Chỉ cho tôi” để tự thực hiện bài tập.',
    ],
    [
      'The class context changed. Send your request again.',
      'Nội dung buổi học đã thay đổi. Hãy gửi lại yêu cầu.',
    ],
  ])(
    'preserves the classroom error and translates it when locale changes: %s',
    async (englishMessage, vietnameseMessage) => {
      window.localStorage.clear();
      const bridge = createDesktopBridge();
      bridge.sendAgentMessage.mockResolvedValue({ kind: 'failed', message: vietnameseMessage });
      window.tro = bridge;
      renderDesktop();
      await screen.findByRole('heading', { name: 'Chào mừng trở lại, Alex' });
      fireEvent.change(screen.getByRole('textbox', { name: 'Tin nhắn của bạn' }), {
        target: { value: 'Help with my class' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Gửi cho Tro' }));
      expect((await screen.findByRole('alert')).textContent).toContain(vietnameseMessage);
      fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
      fireEvent.change(screen.getByRole('combobox', { name: 'Ngôn ngữ' }), {
        target: { value: 'en' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
      expect(screen.getByRole('alert').textContent).toContain(englishMessage);
    },
  );

  it('uses a localized fallback for an unknown bridge error after voice startup', async () => {
    window.localStorage.clear();
    const bridge = createDesktopBridge();
    let finishVoiceStartup: ((reply: VoiceReply) => void) | undefined;
    const voiceStartup = new Promise<VoiceReply>((resolve) => {
      finishVoiceStartup = resolve;
    });
    bridge.controlVoiceInput.mockImplementation((command) =>
      command.kind === 'enable'
        ? voiceStartup
        : Promise.resolve({
            kind: 'ok',
            status: {
              state: VoiceState.DISABLED,
              shortcut: VoiceShortcut.COMMAND_CONTROL,
              globalShortcutAvailable: false,
            },
          }),
    );
    bridge.signOut.mockResolvedValue({ kind: 'failed', message: 'Unrecognized diagnostic' });
    window.tro = bridge;
    renderDesktop();
    const accountButton = await screen.findByRole('button', { name: 'Chuyển tài khoản' });
    // Presence does not imply readiness: voice startup deliberately blocks account changes.
    expect(accountButton).toHaveProperty('disabled', true);
    fireEvent.click(accountButton);
    expect(screen.queryByRole('dialog', { name: 'Chuyển tài khoản' })).toBeNull();
    await act(async () => {
      if (!finishVoiceStartup) {
        throw new Error('Voice startup fixture is unavailable.');
      }
      finishVoiceStartup({
        kind: 'ok',
        status: {
          state: VoiceState.IDLE,
          shortcut: VoiceShortcut.COMMAND_CONTROL,
          globalShortcutAvailable: true,
        },
      });
      await voiceStartup;
    });
    await waitFor(() => {
      expect(accountButton).toHaveProperty('disabled', false);
    });
    fireEvent.click(accountButton);
    fireEvent.click(await screen.findByRole('button', { name: 'Đăng xuất tài khoản này' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Không thể đăng xuất. Vui lòng thử lại.');
    expect(alert.textContent).not.toContain('Unrecognized diagnostic');
    expect(screen.getByText(testUser.email)).toBeTruthy();
  });

  it('stops guidance and discards a late agent answer', async () => {
    const bridge = createDesktopBridge();
    let finishTask: ((result: AgentResult) => void) | undefined;
    bridge.sendAgentMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishTask = resolve;
        }),
    );
    window.tro = bridge;
    renderDesktop();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your message' }), {
      target: { value: 'Show a circle and then an arrow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await waitFor(() => {
      expect(bridge.sendAgentMessage).toHaveBeenCalledWith(
        sessionId,
        'Show a circle and then an arrow',
        DesktopLocale.ENGLISH,
        AgentTaskMode.TEACH,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
    await waitFor(() => {
      expect(bridge.stopAgentSession).toHaveBeenCalledWith(sessionId);
    });
    finishTask?.({
      kind: 'completed',
      completion: { kind: 'response' },
      answer: 'Late guide answer',
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send to Tro' })).toHaveProperty('disabled', true);
    });
    expect(screen.queryByText('Late guide answer')).toBeNull();
  });
});

it('displays a voice instruction immediately and preserves the separately typed draft', async () => {
  const bridge = createDesktopBridge();
  window.tro = bridge;
  renderDesktop();
  const input = await screen.findByRole('textbox', { name: 'Your message' });
  fireEvent.change(input, { target: { value: 'A separate draft' } });
  const emit = bridge.subscribeVoiceInput.mock.calls.at(-1)?.[0];
  if (!emit) {
    throw new Error('Missing voice subscription.');
  }
  const captureId = '33333333-3333-4333-8333-333333333333';
  act(() => {
    emit({
      kind: 'status',
      status: { state: 'running', shortcut: 'command-control', globalShortcutAvailable: true },
    });
    emit({ kind: 'submitted', captureId, sessionId, text: 'Mở Chrome' });
  });
  expect(screen.getByText('Mở Chrome')).toBeTruthy();
  expect(input.getAttribute('disabled')).not.toBeNull();
  act(() => {
    emit({
      kind: 'result',
      captureId,
      sessionId,
      result: { kind: 'completed', completion: { kind: 'response' }, answer: 'Opened Chrome' },
    });
    emit({
      kind: 'status',
      status: { state: 'idle', shortcut: 'command-control', globalShortcutAvailable: true },
    });
  });
  expect(screen.getByText('Opened Chrome')).toBeTruthy();
  expect(screen.getByDisplayValue('A separate draft')).toBeTruthy();
  expect(bridge.sendAgentMessage).not.toHaveBeenCalled();
});

it.each([TaskOutcomeStatus.PARTIAL, TaskOutcomeStatus.UNVERIFIED, TaskOutcomeStatus.BLOCKED])(
  'shows the %s outcome for typed instructions instead of a success label',
  async (status) => {
    const bridge = createDesktopBridge();
    const supported = status === TaskOutcomeStatus.PARTIAL ? 1 : 0;
    bridge.sendAgentMessage.mockResolvedValue({
      kind: 'completed',
      answer: 'The page loaded.',
      completion: {
        kind: CompletionMode.TASK,
        outcome: {
          status,
          requiredCriteriaCount: 2,
          supportedCriteriaCount: supported,
          remainingCriteriaCount: 2 - supported,
          limitation: 'The requested window visibility is not confirmed.',
        },
      },
    });
    window.tro = bridge;
    renderDesktop();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your message' }), {
      target: { value: 'Open YouTube' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    expect(
      await screen.findByText('The requested window visibility is not confirmed.'),
    ).toBeTruthy();
    expect(document.querySelector(`[data-outcome="${status}"]`)).toBeTruthy();
    expect(screen.queryByText('Task completed')).toBeNull();
  },
);

it('shows a localized voice outcome and discards a late result from another capture', async () => {
  window.localStorage.setItem(localeStorageKey, DesktopLocale.VIETNAMESE);
  const bridge = createDesktopBridge();
  window.tro = bridge;
  renderDesktop();
  await screen.findByRole('textbox', { name: 'Tin nhắn của bạn' });
  const emit = bridge.subscribeVoiceInput.mock.calls.at(-1)?.[0];
  if (!emit) {
    throw new Error('Missing voice subscription.');
  }
  const captureId = '33333333-3333-4333-8333-333333333333';
  act(() => {
    emit({ kind: 'submitted', captureId, sessionId, text: 'Mở YouTube' });
    emit({
      kind: 'result',
      captureId: '44444444-4444-4444-8444-444444444444',
      sessionId,
      result: {
        kind: 'completed',
        answer: 'Stale answer',
        completion: { kind: CompletionMode.RESPONSE },
      },
    });
    emit({
      kind: 'result',
      captureId,
      sessionId,
      result: {
        kind: 'completed',
        answer: 'Trang đã tải.',
        completion: {
          kind: CompletionMode.TASK,
          outcome: {
            status: TaskOutcomeStatus.PARTIAL,
            requiredCriteriaCount: 2,
            supportedCriteriaCount: 1,
            remainingCriteriaCount: 1,
            limitation: 'Chưa xác nhận cửa sổ đang hiển thị.',
          },
        },
      },
    });
  });
  expect(screen.getByText('Đã hoàn tất một phần')).toBeTruthy();
  expect(screen.getByText('Chưa xác nhận cửa sổ đang hiển thị.')).toBeTruthy();
  expect(screen.queryByText('Stale answer')).toBeNull();
});

it('keeps voice active across navigation without a duplicate workspace panel', async () => {
  const bridge = createDesktopBridge();
  window.tro = bridge;
  renderDesktop();
  await screen.findByRole('textbox', { name: 'Your message' });
  expect(screen.queryByText('Hold to talk; release to send')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hold to talk' })).toBeNull();
  expect(screen.queryByText('Command + Control')).toBeNull();
  expect(bridge.controlVoiceInput).toHaveBeenCalledWith({
    kind: 'enable',
    shortcut: 'command-control',
  });
  const subscriptions = bridge.subscribeVoiceInput.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Enable voice input' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Disable voice input' })).toBeNull();
  expect(screen.queryByLabelText('Hold-to-talk shortcut')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  await screen.findByRole('textbox', { name: 'Your message' });
  expect(screen.queryByText('Hold to talk; release to send')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hold to talk' })).toBeNull();
  expect(bridge.subscribeVoiceInput).toHaveBeenCalledTimes(subscriptions);
  expect(
    bridge.controlVoiceInput.mock.calls.filter(([command]) => command.kind === 'enable'),
  ).toHaveLength(1);
});

it('starts the idle companion before any task and keeps it when execution mode is selected', async () => {
  const bridge = createDesktopBridge();
  window.tro = bridge;
  renderDesktop();
  await screen.findByRole('textbox', { name: 'Your message' });
  await waitFor(() => {
    expect(bridge.startCursorCompanion).toHaveBeenCalledTimes(1);
  });
  fireEvent.click(screen.getByRole('radio', { name: 'Do it for me' }));
  expect(bridge.startAgentSession).not.toHaveBeenCalled();
  expect(bridge.sendAgentMessage).not.toHaveBeenCalled();
  expect(bridge.startCursorCompanion).toHaveBeenCalledTimes(1);
});

describe('typed teaching outcomes', () => {
  it('shows takeover as a stopped guide without the generic task error', async () => {
    const bridge = createDesktopBridge();
    bridge.sendAgentMessage.mockResolvedValue({
      kind: 'teaching',
      result: { outcome: 'canceled', reason: 'user_takeover' },
    });
    window.tro = bridge;
    renderDesktop();
    const input = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(input, { target: { value: 'Show the export button' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    expect(await screen.findByText('Guide stopped')).toBeTruthy();
    expect(
      screen.getByText('The guide stopped. Send a new request when you want to continue.'),
    ).toBeTruthy();
    expect(screen.queryByText('Something needs attention')).toBeNull();
  });

  it('labels a demonstrated guide separately from a real desktop action', async () => {
    const bridge = createDesktopBridge();
    bridge.sendAgentMessage.mockResolvedValue({
      kind: 'teaching',
      result: { outcome: 'demonstrated', answer: 'Now click Export.' },
    });
    window.tro = bridge;
    renderDesktop();
    const input = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(input, { target: { value: 'Show the export button' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    expect(await screen.findByText('Guide finished')).toBeTruthy();
    expect(screen.getByText('Now click Export.')).toBeTruthy();
  });
});

it('renders a voice takeover with the same typed teaching outcome', async () => {
  const bridge = createDesktopBridge();
  window.tro = bridge;
  renderDesktop();
  await screen.findByRole('textbox', { name: 'Your message' });
  const emit = bridge.subscribeVoiceInput.mock.calls.at(-1)?.[0];
  if (!emit) {
    throw new Error('Missing voice subscription');
  }
  const captureId = '33333333-3333-4333-8333-333333333333';
  act(() => {
    emit({ kind: 'submitted', captureId, sessionId, text: 'Show me Export' });
    emit({
      kind: 'result',
      captureId,
      sessionId,
      result: { kind: 'teaching', result: { outcome: 'canceled', reason: 'user_takeover' } },
    });
  });
  expect(screen.getByText('Guide stopped')).toBeTruthy();
  expect(
    screen.getByText('The guide stopped. Send a new request when you want to continue.'),
  ).toBeTruthy();
});

it('automatically previews the selected microphone, saves changes and stops when the picker closes', async () => {
  function createDevice(deviceId: string, label: string): MediaDeviceInfo {
    return {
      deviceId,
      label,
      kind: 'audioinput',
      groupId: deviceId,
      toJSON: () => ({ deviceId, label }),
    };
  }

  const events = new EventTarget();
  const getUserMedia = vi.fn<MediaDevices['getUserMedia']>();
  const enumerateDevices = vi
    .fn<MediaDevices['enumerateDevices']>()
    .mockResolvedValue([
      createDevice('default', 'Default - AirPods'),
      createDevice('usb', 'USB microphone'),
      createDevice('wireless', 'AirPods'),
    ]);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices,
      getUserMedia,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  try {
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Microphone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Microphone' });
    await waitFor(() => {
      expect(microphonePreviews.startPreview).toHaveBeenCalledWith('default');
    });
    expect(within(dialog).queryByRole('button', { name: 'Test input' })).toBeNull();
    expect(await within(dialog).findByText('Suggested')).toBeTruthy();
    expect(
      within(dialog).getAllByText(
        'Appears to be Bluetooth. Wireless startup and audio quality can vary.',
      )[0],
    ).toBeTruthy();
    const usbOption = within(dialog).getByRole('radio', { name: 'USB microphone' });
    expect(usbOption.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByText('2 microphone inputs')).toBeTruthy();
    fireEvent.click(usbOption);
    await waitFor(() => {
      expect(microphonePreviews.startPreview).toHaveBeenCalledWith('usb');
    });
    const activePreview = microphonePreviews.instances.at(-1);
    if (!activePreview) {
      throw new Error('Missing microphone preview');
    }
    act(() => {
      activePreview.receive(-30);
    });
    expect(
      within(dialog).getByRole('meter', { name: 'Input level' }).getAttribute('aria-valuenow'),
    ).toBe('50');
    expect(window.localStorage.getItem(microphoneStorageKey)).toBe('usb');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(activePreview.dispose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(settings).getByText('USB microphone')).toBeTruthy();
    fireEvent.click(within(settings).getByRole('button', { name: 'Choose microphone' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Microphone' })).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    fireEvent.click(within(settings).getByRole('button', { name: 'Choose microphone' }));
    expect(await screen.findByRole('radio', { name: /USB microphone/ })).toHaveProperty(
      'checked',
      true,
    );
    enumerateDevices.mockResolvedValue([createDevice('wireless', 'AirPods')]);
    act(() => {
      events.dispatchEvent(new Event('devicechange'));
    });
    expect(await screen.findByText(/Your selected microphone is unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Auto-detect/ }));
    expect(window.localStorage.getItem(microphoneStorageKey)).toBe('default');
    fireEvent.click(screen.getByRole('button', { name: 'Edit ranking' }));
    expect(screen.getByRole('button', { name: 'Move AirPods up' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare microphones' }));
    expect(screen.getByText(/Each comparison measures one microphone/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test AirPods' })).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(within(settings).getByText('Auto-detect')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    });
    expect(screen.getByRole('textbox', { name: 'Your message' })).toBeTruthy();
  } finally {
    cleanup();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

it('releases the automatic preview before retrying voice startup and resumes after voice becomes idle', async () => {
  const bridge = createDesktopBridge();
  const operations: string[] = [];
  let enableAttempts = 0;
  let finishRetry: ((reply: VoiceReply) => void) | undefined;
  bridge.controlVoiceInput.mockImplementation((command) => {
    if (command.kind === 'enable') {
      enableAttempts += 1;
      if (enableAttempts === 1) {
        operations.push('voice-enable-failed');
        return Promise.resolve({ kind: 'failed' });
      }
      operations.push('voice-enable-retry');
      return new Promise((resolve) => {
        finishRetry = resolve;
      });
    }
    return Promise.resolve({
      kind: 'ok',
      status: {
        state: VoiceState.DISABLED,
        shortcut: VoiceShortcut.COMMAND_CONTROL,
        globalShortcutAvailable: false,
      },
    });
  });
  let releasePreview: (() => void) | undefined;
  let shouldDelayRelease = true;
  bridge.controlMicrophoneTest.mockImplementation((command) => {
    if (command.kind === 'stop' && shouldDelayRelease) {
      operations.push('preview-stop');
      return new Promise((resolve) => {
        releasePreview = () => {
          shouldDelayRelease = false;
          operations.push('preview-released');
          resolve({ kind: 'ok' });
        };
      });
    }
    return Promise.resolve({ kind: 'ok' });
  });
  window.tro = bridge;
  const events = new EventTarget();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn<MediaDevices['enumerateDevices']>().mockResolvedValue([]),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  try {
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Microphone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Microphone' });
    const retryButton = await within(dialog).findByRole('button', { name: 'Retry voice startup' });
    await waitFor(() => {
      expect(microphonePreviews.startPreview).toHaveBeenCalledExactlyOnceWith('default');
    });
    const activePreview = microphonePreviews.instances.at(-1);
    if (!activePreview) {
      throw new Error('Missing automatic microphone preview');
    }
    vi.mocked(activePreview.dispose).mockImplementation(() => {
      operations.push('preview-disposed');
    });
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(releasePreview).toBeTypeOf('function');
    });
    expect(activePreview.dispose).toHaveBeenCalledOnce();
    expect(enableAttempts).toBe(1);
    expect(operations).toEqual(['voice-enable-failed', 'preview-disposed', 'preview-stop']);

    await act(async () => {
      releasePreview?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(finishRetry).toBeTypeOf('function');
    });
    expect(operations).toEqual([
      'voice-enable-failed',
      'preview-disposed',
      'preview-stop',
      'preview-released',
      'voice-enable-retry',
    ]);
    expect(microphonePreviews.startPreview).toHaveBeenCalledOnce();
    await act(async () => {
      finishRetry?.({
        kind: 'ok',
        status: {
          state: VoiceState.IDLE,
          shortcut: VoiceShortcut.COMMAND_CONTROL,
          globalShortcutAvailable: true,
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(microphonePreviews.startPreview).toHaveBeenCalledTimes(2);
      expect(within(dialog).getByRole('status').textContent).toBe('Listening');
    });
    expect(microphonePreviews.startPreview).toHaveBeenLastCalledWith('default');
    expect(within(dialog).queryByRole('button', { name: 'Retry voice startup' })).toBeNull();
  } finally {
    cleanup();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

it('does not revive a comparison after the picker closes and reopens while releasing its preview', async () => {
  const bridge = createDesktopBridge();
  let finishRelease: (() => void) | undefined;
  bridge.controlMicrophoneTest.mockImplementation((command) => {
    if (command.kind === 'stop') {
      return new Promise((resolve) => {
        finishRelease = () => {
          resolve({ kind: 'ok' });
        };
      });
    }
    return Promise.resolve({ kind: 'ok' });
  });
  window.tro = bridge;
  const events = new EventTarget();
  const device: MediaDeviceInfo = {
    deviceId: 'usb',
    groupId: 'usb',
    kind: 'audioinput',
    label: 'USB microphone',
    toJSON: () => ({ deviceId: 'usb', label: 'USB microphone' }),
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn<MediaDevices['enumerateDevices']>().mockResolvedValue([device]),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  try {
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Microphone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Microphone' });
    await waitFor(() => {
      expect(microphonePreviews.startPreview).toHaveBeenCalledWith('default');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Compare microphones' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test USB microphone' }));
    await waitFor(() => {
      expect(finishRelease).toBeTypeOf('function');
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Microphone' }));
    await act(async () => {
      finishRelease?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(microphonePreviews.startPreview).toHaveBeenCalledTimes(2);
    });
    const startCommands = bridge.controlMicrophoneTest.mock.calls
      .map(([command]) => command)
      .filter((command) => command.kind === 'start');
    expect(startCommands).toHaveLength(2);
    expect(startCommands.map((command) => command.mode)).toEqual(['preview', 'preview']);
    expect(bridge.appendVoiceAudio).not.toHaveBeenCalled();
    expect(bridge.sendAgentMessage).not.toHaveBeenCalled();
  } finally {
    cleanup();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

it('shows the current teaching instruction while waiting, fences other sessions, and clears it on Stop', async () => {
  const bridge = createDesktopBridge();
  bridge.sendAgentMessage.mockImplementation(() => new Promise(() => {}));
  window.tro = bridge;
  renderDesktop();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Your message' }), {
    target: { value: 'Open YouTube' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
  await waitFor(() => {
    expect(bridge.sendAgentMessage).toHaveBeenCalledOnce();
  });
  const emit = bridge.subscribeAgentProgress.mock.calls.at(-1)?.[0];
  const sessionId = bridge.sendAgentMessage.mock.calls[0]?.[0];
  if (!emit || !sessionId) {
    throw new Error('Missing active progress subscription');
  }
  emit({
    kind: 'progress',
    requestId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    phase: 'showing',
    teachingStep: 'Wrong session',
  });
  expect(screen.queryByText('Wrong session')).toBeNull();
  emit({
    kind: 'progress',
    requestId: '22222222-2222-4222-8222-222222222222',
    sessionId,
    phase: 'showing',
    teachingStep: 'Click the browser icon I highlighted.',
  });
  expect(await screen.findByText('Click the browser icon I highlighted.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Esc' }));
  await waitFor(() => {
    expect(screen.queryByText('Click the browser icon I highlighted.')).toBeNull();
  });
  emit({
    kind: 'progress',
    requestId: '22222222-2222-4222-8222-222222222222',
    sessionId,
    phase: 'showing',
    teachingStep: 'Late instruction',
  });
  expect(screen.queryByText('Late instruction')).toBeNull();
});

it('ordinary keys and clicks keep the lesson active; pressing Esc cancels it and fences late replies', async () => {
  const bridge = createDesktopBridge();
  let finishTask: ((result: AgentResult) => void) | undefined;
  bridge.sendAgentMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishTask = resolve;
      }),
  );
  window.tro = bridge;
  renderDesktop();
  fireEvent.change(await screen.findByRole('textbox', { name: 'Your message' }), {
    target: { value: 'Open YouTube' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
  await waitFor(() => {
    expect(bridge.sendAgentMessage).toHaveBeenCalledOnce();
  });
  fireEvent.keyDown(window, { key: 'a' });
  fireEvent.keyDown(window, { key: 'Enter' });
  fireEvent.click(document.body);
  expect(bridge.stopAgentSession).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Escape' });
  await waitFor(() => {
    expect(bridge.stopAgentSession).toHaveBeenCalledWith(sessionId);
  });
  finishTask?.({
    kind: 'teaching',
    result: { outcome: 'demonstrated', answer: 'Late cue answer' },
  });
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Esc' })).toBeNull();
  });
  expect(screen.queryByText('Late cue answer')).toBeNull();
});

it('answers a retained lesson through the narrow bridge while the original task stays pending', async () => {
  const bridge = createDesktopBridge();
  let receive: Parameters<DesktopBridge['subscribeAgentProgress']>[0] | undefined;
  bridge.subscribeAgentProgress.mockImplementation((callback) => {
    receive = callback;
    return () => {};
  });
  let finish:
    ((result: Awaited<ReturnType<DesktopBridge['sendAgentMessage']>>) => void) | undefined;
  bridge.sendAgentMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const lessonId = '22222222-2222-4222-8222-222222222222';
  bridge.answerTeachingLesson.mockResolvedValue({ kind: 'accepted', lessonId });
  window.tro = bridge;
  renderDesktop();
  const input = await screen.findByRole('textbox', { name: 'Your message' });
  fireEvent.change(input, { target: { value: 'Design an ERD' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
  await waitFor(() => {
    expect(bridge.sendAgentMessage).toHaveBeenCalledOnce();
  });
  act(() => {
    receive?.({
      kind: 'progress',
      requestId: lessonId,
      sessionId,
      lessonId,
      phase: 'needs_input',
      teachingStep: 'Which database?',
    });
  });
  expect(screen.getByText('Which database?')).toBeTruthy();
  expect(input).toHaveProperty('disabled', false);
  fireEvent.change(input, { target: { value: 'Sales' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
  await waitFor(() => {
    expect(bridge.answerTeachingLesson).toHaveBeenCalledWith(
      sessionId,
      lessonId,
      'Sales',
      DesktopLocale.ENGLISH,
    );
  });
  expect(bridge.sendAgentMessage).toHaveBeenCalledOnce();
  act(() => {
    finish?.({
      kind: 'teaching',
      result: { outcome: 'goal_reached', answer: 'The whole ERD is ready.' },
    });
  });
  expect(await screen.findByText('The whole ERD is ready.')).toBeTruthy();
});

describe('Settings update checks', () => {
  it('checks on demand, prevents repeated clicks and confirms when Tro is current', async () => {
    const bridge = createDesktopBridge();
    bridge.readAppUpdate.mockResolvedValue({
      revision: 1,
      status: { state: AppUpdateState.CURRENT },
    });
    let finishCheck: ((reply: AppUpdateReply) => void) | undefined;
    bridge.checkAppUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(bridge.checkAppUpdate).not.toHaveBeenCalled();
    expect(within(dialog).queryByText('Tro is up to date.')).toBeNull();
    const checkButton = within(dialog).getByRole('button', { name: 'Check for updates' });
    fireEvent.click(checkButton);
    const checkingButton = within(dialog).getByRole('button', {
      name: 'Checking for updates…',
    });
    expect(checkingButton).toHaveProperty('disabled', true);
    fireEvent.click(checkingButton);
    expect(bridge.checkAppUpdate).toHaveBeenCalledOnce();
    await act(async () => {
      finishCheck?.({
        kind: 'ok',
        snapshot: { revision: 3, status: { state: AppUpdateState.CURRENT } },
      });
      await Promise.resolve();
    });
    expect(await within(dialog).findByText('Tro is up to date.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Check for updates' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(bridge.downloadAppUpdate).not.toHaveBeenCalled();
    expect(bridge.restartForAppUpdate).not.toHaveBeenCalled();
  });

  it('makes a manually discovered update available through the existing updater', async () => {
    const bridge = createDesktopBridge();
    bridge.readAppUpdate.mockResolvedValue({
      revision: 1,
      status: { state: AppUpdateState.CURRENT },
    });
    bridge.checkAppUpdate.mockResolvedValue({
      kind: 'ok',
      snapshot: { revision: 3, status: { state: AppUpdateState.AVAILABLE, version: '0.2.0' } },
    });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(
      await within(screen.getByRole('dialog', { name: 'Settings' })).findByText(
        /Version 0.2.0 available/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(bridge.downloadAppUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    fireEvent.click(await screen.findByRole('button', { name: /Update Tro/ }));
    await waitFor(() => {
      expect(bridge.downloadAppUpdate).toHaveBeenCalledOnce();
    });
    expect(bridge.readAppUpdate).toHaveBeenCalledOnce();
    expect(bridge.subscribeAppUpdate).toHaveBeenCalledOnce();
  });

  it('shows failed checks and lets a signed-out user retry in Vietnamese', async () => {
    window.localStorage.setItem(localeStorageKey, DesktopLocale.VIETNAMESE);
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue({ kind: 'signed-out' });
    bridge.readAppUpdate.mockResolvedValue({
      revision: 1,
      status: { state: AppUpdateState.CURRENT },
    });
    bridge.checkAppUpdate
      .mockRejectedValueOnce(new Error('private update diagnostics'))
      .mockResolvedValueOnce({
        kind: 'ok',
        snapshot: { revision: 3, status: { state: AppUpdateState.CURRENT } },
      });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Cài đặt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra bản cập nhật' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Không thể kiểm tra bản cập nhật.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kiểm tra bản cập nhật' }));
    expect(await screen.findByText('Tro đang ở phiên bản mới nhất.')).toBeTruthy();
    expect(bridge.checkAppUpdate).toHaveBeenCalledTimes(2);
  });

  it('keeps background update events visible without a manual check', async () => {
    const bridge = createDesktopBridge();
    let receive: ((snapshot: AppUpdateSnapshot) => void) | undefined;
    bridge.readAppUpdate.mockResolvedValue({
      revision: 1,
      status: { state: AppUpdateState.CURRENT },
    });
    bridge.subscribeAppUpdate.mockImplementation((listener) => {
      receive = listener;
      return () => {};
    });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    act(() => {
      receive?.({ revision: 2, status: { state: AppUpdateState.CHECKING } });
    });
    expect(screen.getByRole('button', { name: 'Checking for updates…' })).toHaveProperty(
      'disabled',
      true,
    );
    act(() => {
      receive?.({ revision: 3, status: { state: AppUpdateState.AVAILABLE, version: '0.2.0' } });
    });
    expect(
      within(screen.getByRole('dialog', { name: 'Settings' })).getByText(/Version 0.2.0 available/),
    ).toBeTruthy();
    expect(bridge.checkAppUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(await screen.findByRole('button', { name: /Update Tro/ })).toBeTruthy();
  });

  it.each([
    { state: AppUpdateState.DISABLED },
    { state: AppUpdateState.DOWNLOADING, version: '0.2.0', percent: 40 },
    { state: AppUpdateState.READY, version: '0.2.0' },
    { state: AppUpdateState.RESTARTING, version: '0.2.0' },
  ] satisfies AppUpdateSnapshot['status'][])('prevents checking while $state', async (status) => {
    const bridge = createDesktopBridge();
    bridge.readAppUpdate.mockResolvedValue({ revision: 1, status });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const checkButton = screen.getByRole('button', { name: 'Check for updates' });
    expect(checkButton).toHaveProperty('disabled', true);
    fireEvent.click(checkButton);
    expect(bridge.checkAppUpdate).not.toHaveBeenCalled();
  });
});

describe('sidebar app updates', () => {
  it('keeps updates and settings on the welcome screen without a signed-out sidebar', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValue({ kind: 'signed-out' });
    let receive: ((snapshot: AppUpdateSnapshot) => void) | undefined;
    bridge.subscribeAppUpdate.mockImplementation((listener) => {
      receive = listener;
      return () => {};
    });
    window.tro = bridge;
    renderDesktop();
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(screen.queryByRole('button', { name: /Update Tro/ })).toBeNull();
    act(() => {
      receive?.({ revision: 1, status: { state: AppUpdateState.AVAILABLE, version: '0.2.0' } });
    });
    const button = await screen.findByRole('button', { name: /Update Tro/ });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(document.querySelector('.desktop-sidebar')).toBeNull();
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(button.parentElement?.parentElement).toBe(settings.parentElement);
    expect(
      button.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(bridge.downloadAppUpdate).not.toHaveBeenCalled();
    act(() => {
      receive?.({ revision: 2, status: { state: AppUpdateState.CURRENT } });
    });
    expect(screen.queryByRole('button', { name: /Update Tro/ })).toBeNull();
  });

  it('starts only the clicked action, shows live progress and unsubscribes', async () => {
    const bridge = createDesktopBridge();
    let receive: ((snapshot: AppUpdateSnapshot) => void) | undefined;
    const unsubscribe = vi.fn<() => void>();
    bridge.subscribeAppUpdate.mockImplementation((listener) => {
      receive = listener;
      return unsubscribe;
    });
    bridge.readAppUpdate.mockResolvedValue({
      revision: 1,
      status: { state: AppUpdateState.AVAILABLE, version: '0.2.0' },
    });
    bridge.downloadAppUpdate.mockResolvedValue({
      kind: 'ok',
      snapshot: {
        revision: 2,
        status: { state: AppUpdateState.DOWNLOADING, version: '0.2.0', percent: 0 },
      },
    });
    bridge.restartForAppUpdate.mockResolvedValue({
      kind: 'ok',
      snapshot: { revision: 5, status: { state: AppUpdateState.RESTARTING, version: '0.2.0' } },
    });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: /Update Tro/ }));
    await waitFor(() => {
      expect(bridge.downloadAppUpdate).toHaveBeenCalledOnce();
    });
    const download = await screen.findByRole('button', { name: /Downloading/ });
    expect(download).toHaveProperty('disabled', true);
    act(() => {
      receive?.({
        revision: 3,
        status: { state: AppUpdateState.DOWNLOADING, version: '0.2.0', percent: 48 },
      });
    });
    expect(screen.getByRole('progressbar', { name: 'Update download' })).toHaveProperty(
      'value',
      48,
    );
    act(() => {
      receive?.({ revision: 4, status: { state: AppUpdateState.READY, version: '0.2.0' } });
    });
    expect(bridge.restartForAppUpdate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /Restart to update/ }));
    await waitFor(() => {
      expect(bridge.restartForAppUpdate).toHaveBeenCalledOnce();
    });
    expect(await screen.findByRole('button', { name: /Restarting Tro/ })).toHaveProperty(
      'disabled',
      true,
    );
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('ignores stale initial reads and translates the existing update when language changes', async () => {
    const bridge = createDesktopBridge();
    let finishRead: ((snapshot: AppUpdateSnapshot) => void) | undefined;
    let receive: ((snapshot: AppUpdateSnapshot) => void) | undefined;
    bridge.readAppUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    bridge.subscribeAppUpdate.mockImplementation((listener) => {
      receive = listener;
      return () => {};
    });
    window.tro = bridge;
    renderDesktop();
    await screen.findByRole('textbox', { name: 'Your message' });
    act(() => {
      receive?.({ revision: 3, status: { state: AppUpdateState.READY, version: '0.2.0' } });
    });
    await act(() => {
      finishRead?.({ revision: 1, status: { state: AppUpdateState.AVAILABLE, version: '0.2.0' } });
      return Promise.resolve();
    });
    expect(screen.getByRole('button', { name: /Restart to update/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), {
      target: { value: 'vi' },
    });
    expect(
      screen.getByRole('button', { name: /Khởi động lại để cập nhật/, hidden: true }),
    ).toBeTruthy();
    expect(bridge.readAppUpdate).toHaveBeenCalledOnce();
  });

  it('retries the correct failure phase and shows a rejected restart without losing readiness', async () => {
    const bridge = createDesktopBridge();
    let receive: ((snapshot: AppUpdateSnapshot) => void) | undefined;
    bridge.subscribeAppUpdate.mockImplementation((listener) => {
      receive = listener;
      return () => {};
    });
    bridge.readAppUpdate.mockResolvedValue({
      revision: 1,
      status: { state: AppUpdateState.ERROR, phase: 'check', version: null },
    });
    bridge.checkAppUpdate.mockResolvedValue({
      kind: 'ok',
      snapshot: { revision: 2, status: { state: AppUpdateState.AVAILABLE, version: '0.2.0' } },
    });
    bridge.restartForAppUpdate.mockResolvedValue({ kind: 'failed', reason: 'busy' });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: /Retry update/ }));
    await waitFor(() => {
      expect(bridge.checkAppUpdate).toHaveBeenCalledOnce();
    });
    expect(await screen.findByRole('button', { name: /Update Tro/ })).toBeTruthy();
    act(() => {
      receive?.({
        revision: 3,
        status: { state: AppUpdateState.ERROR, phase: 'download', version: '0.2.0' },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry update/ }));
    await waitFor(() => {
      expect(bridge.downloadAppUpdate).toHaveBeenCalledOnce();
    });
    act(() => {
      receive?.({ revision: 4, status: { state: AppUpdateState.READY, version: '0.2.0' } });
    });
    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));
    expect(
      await screen.findByText('Wait for the current task or recording to finish.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Restart to update/ })).toBeTruthy();
  });

  it('disables restarting during an active task without interrupting it', async () => {
    const bridge = createDesktopBridge();
    bridge.readAppUpdate.mockResolvedValue({
      revision: 1,
      status: { state: AppUpdateState.READY, version: '0.2.0' },
    });
    let finish: ((result: AgentResult) => void) | undefined;
    bridge.sendAgentMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    window.tro = bridge;
    renderDesktop();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your message' }), {
      target: { value: 'Do this task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await waitFor(() => {
      expect(bridge.sendAgentMessage).toHaveBeenCalledOnce();
    });
    expect(screen.getByRole('button', { name: /Restart to update/ })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));
    expect(bridge.restartForAppUpdate).not.toHaveBeenCalled();
    await act(() => {
      finish?.({ kind: 'completed', completion: { kind: 'response' }, answer: 'Finished' });
      return Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Restart to update/ })).toHaveProperty(
        'disabled',
        false,
      );
    });
  });
});

it('shows the student role and code enrollment page while preserving the workspace draft', async () => {
  const bridge = createDesktopBridge();
  window.tro = bridge;
  renderDesktop();
  const input = await screen.findByRole('textbox', { name: 'Your message' });
  fireEvent.change(input, { target: { value: 'Keep my work' } });
  await waitFor(() => {
    expect(screen.getByLabelText('Account role').textContent).toBe('Student');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Classroom' }));
  expect(await screen.findByRole('heading', { name: /^Welcome/ })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Class materials' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Class code' }), {
    target: { value: 'aabb-ccdd-eeff' },
  });
  bridge.controlClassroom.mockResolvedValueOnce({ kind: 'ok' });
  fireEvent.click(screen.getByRole('button', { name: 'Join class' }));
  await waitFor(() => {
    expect(bridge.controlClassroom).toHaveBeenCalledWith({
      kind: 'accept-invitation',
      code: 'AABBCCDDEEFF',
    });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  expect(screen.getByRole('textbox', { name: 'Your message' })).toHaveProperty(
    'value',
    'Keep my work',
  );
  expect(bridge.stopAgentSession).not.toHaveBeenCalled();
});

it('shows teacher preparation and invitation controls only with a server-provided teacher role', async () => {
  const bridge = createDesktopBridge();
  const context = createTeachingContext();
  bridge.controlClassroom.mockResolvedValue({
    kind: 'home',
    home: {
      role: AccountRole.TEACHER,
      isAdmin: false,
      courses: [
        {
          id: context.courseRevisionId,
          title: 'Scratch lesson',
          activities: [{ id: context.activity.id, title: context.activity.title }],
        },
      ],
      classes: [
        {
          schoolClass: {
            id: context.meeting.classId,
            teacherId: testUser.id,
            name: 'Class A',
            courseRevisionId: context.courseRevisionId,
          },
          meetings: [],
        },
      ],
    },
  });
  window.tro = bridge;
  renderDesktop();
  await waitFor(() => {
    expect(screen.getByLabelText('Account role').textContent).toBe('Teacher');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Classroom' }));
  expect(await screen.findByRole('tab', { name: 'Class materials' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create a class' }));
  expect(screen.getByRole('button', { name: 'Create class' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Manage Class A' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
  expect(screen.getByRole('button', { name: 'Add student' })).toBeTruthy();
  fireEvent.click(screen.getByText('Share an invitation code instead', { selector: 'summary' }));
  expect(screen.getByRole('button', { name: 'Create invitation code' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create a class' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All classes' }));
  expect(window.location.hash).toBe('#/classroom');
  expect(screen.getByRole('button', { name: 'Manage Class A' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create a class' })).toBeTruthy();
});

it.each([true, false])(
  'reports the real result of adding a student by email (success=%s)',
  async (succeeds) => {
    const context = createTeachingContext();
    const bridge = createDesktopBridge();
    bridge.controlClassroom.mockImplementation((command) => {
      if (command.kind === 'home') {
        return Promise.resolve({
          kind: 'home',
          home: {
            role: 'teacher',
            isAdmin: false,
            courses: [],
            classes: [
              {
                schoolClass: {
                  id: context.meeting.classId,
                  teacherId: testUser.id,
                  name: 'Class A',
                  courseRevisionId: context.courseRevisionId,
                },
                meetings: [],
              },
            ],
          },
        });
      }
      return Promise.resolve(succeeds ? { kind: 'ok' } : { kind: 'failed', code: 'not_found' });
    });
    window.tro = bridge;
    renderDesktop();
    await waitFor(() => {
      expect(screen.getByLabelText('Account role').textContent).toBe('Teacher');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Classroom' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage Class A' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Class settings' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Student email' }), {
      target: { value: 'student@example.test' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Add student' }));
    await waitFor(() => {
      expect(bridge.controlClassroom).toHaveBeenCalledWith({
        kind: 'enroll',
        classId: context.meeting.classId,
        email: 'student@example.test',
      });
    });
    if (succeeds) {
      expect(
        await screen.findByText('Student added. This class will appear in their classroom.'),
      ).toBeTruthy();
    } else {
      expect(
        await screen.findByText(
          'No signed-in student was found for this email. Ask them to sign in first, or share an invitation code.',
        ),
      ).toBeTruthy();
      expect(
        screen.queryByText('Student added. This class will appear in their classroom.'),
      ).toBeNull();
    }
  },
);

it('edits per-source notes, preserves original extraction, and saves the review before approval', async () => {
  const context = createTeachingContext();
  const sourceId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const collection: MaterialCollection = {
    classId: context.meeting.classId,
    version: 4,
    state: 'review',
    teacherInstructions: '',
    sources: [{ id: sourceId, name: 'Lesson.py', bytes: 20, digest: '', url: null }],
    draft: {
      summary: 'Explain the lesson.',
      questions: ['How should it start?'],
      sections: [
        {
          id: context.activity.id,
          title: 'Build',
          instruction: 'Build and test.',
          sourcePageIds: [pageId],
        },
      ],
      pages: [
        {
          id: pageId,
          materialId: sourceId,
          location: 'Lines 1–2',
          extractedText: 'print("Hello")',
          preparedNote: 'Explain the print statement.',
          teacherNote: null,
          warnings: [],
        },
      ],
    },
    issue: null,
    leaseUntil: null,
    preparedAt: new Date().toISOString(),
    approvedCourseId: null,
  };
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockImplementation((command) => {
      if (command.kind === 'save-review') {
        return Promise.resolve({
          kind: 'collection',
          collection: {
            ...collection,
            version: 5,
            teacherInstructions: command.teacherInstructions,
          },
        });
      }
      return Promise.resolve({
        kind: 'collection',
        collection: {
          ...collection,
          ...(command.kind === 'approve' ? { version: 6, state: 'approved' as const } : {}),
        },
      });
    });
  window.tro = { ...createDesktopBridge(), controlClassMaterials: control };
  const onApproved = vi.fn<() => Promise<void>>().mockResolvedValue();
  render(
    createElement(MantineProvider, {
      children: createElement(LocaleProvider, {
        children: createElement(MaterialEditor, {
          classId: context.meeting.classId,
          live: false,
          t: (english) => english,
          onApproved,
        }),
      }),
    }),
  );
  await screen.findByRole('tab', { name: 'Sections' });
  fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));
  expect(screen.getByText('Build and test.', { selector: 'p' })).toBeTruthy();
  expect(screen.getByText('Edit section').closest('details')?.open).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'Material notes' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Teaching notes' }), {
    target: { value: 'Teacher correction: explain variables first.' },
  });
  expect(screen.getByText('print("Hello")')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Use reviewed materials' }));
  await waitFor(() => {
    expect(onApproved).toHaveBeenCalledTimes(1);
  });
  expect(control).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'save-review',
      notes: [{ pageId, text: 'Teacher correction: explain variables first.' }],
      resolvedQuestions: true,
    }),
  );
  expect(control).toHaveBeenLastCalledWith({
    kind: 'approve',
    materialSchemaVersion: 2,
    classId: context.meeting.classId,
    version: 5,
  });
});

it('keeps teacher instructions entered before adding materials and prepares with the selected locale', async () => {
  const context = createTeachingContext();
  const collection: MaterialCollection = {
    classId: context.meeting.classId,
    version: 0,
    state: 'collecting',
    sources: [],
    teacherInstructions: '',
    draft: null,
    issue: null,
    leaseUntil: null,
    preparedAt: null,
    approvedCourseId: null,
  };
  const control = vi
    .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
    .mockImplementation((command) =>
      Promise.resolve({
        kind: 'collection',
        collection:
          command.kind === 'add-link'
            ? {
                ...collection,
                version: 1,
                sources: [
                  {
                    id: crypto.randomUUID(),
                    name: command.name,
                    url: command.url,
                    bytes: 0,
                    digest: '',
                  },
                ],
              }
            : collection,
      }),
    );
  window.tro = { ...createDesktopBridge(), controlClassMaterials: control };
  render(
    createElement(MantineProvider, {
      children: createElement(LocaleProvider, {
        children: createElement(MaterialEditor, {
          classId: context.meeting.classId,
          live: false,
          t: (english) => english,
          onApproved: () => Promise.resolve(),
        }),
      }),
    }),
  );
  await waitFor(() => {
    expect(screen.queryByText('Loading materials…')).toBeNull();
  });
  expect(screen.getByRole('region', { name: 'Review your materials' })).toBeTruthy();
  expect(screen.getByText('Your materials, ready to teach with.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose files' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Anything Tro should know? (optional)' }), {
    target: { value: 'Explain setup before practice.' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Material link (HTTPS)' }), {
    target: { value: 'https://scratch.mit.edu/' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await screen.findByText('scratch.mit.edu');
  fireEvent.click(screen.getByRole('button', { name: 'Process materials' }));
  await waitFor(() => {
    expect(control).toHaveBeenCalledWith({
      kind: 'prepare',
      materialSchemaVersion: 2,
      classId: context.meeting.classId,
      version: 1,
      teacherInstructions: 'Explain setup before practice.',
      locale: 'en',
    });
  });
});

it.each([MaterialState.COLLECTING, MaterialState.QUEUED, MaterialState.PREPARING])(
  'shows preparation loading from the initial request through background work (%s)',
  async (state) => {
    const context = createTeachingContext();
    const collection: MaterialCollection = {
      classId: context.meeting.classId,
      version: 1,
      state,
      sources: [
        {
          id: crypto.randomUUID(),
          name: 'Lesson',
          url: 'https://example.test/lesson',
          bytes: 0,
          digest: '',
        },
      ],
      teacherInstructions: '',
      draft: null,
      issue: null,
      leaseUntil: null,
      preparedAt: null,
      approvedCourseId: null,
    };
    let finishPreparation: (reply: MaterialReply) => void = () => {
      throw new Error('Preparation has not started');
    };
    const pendingPreparation = new Promise<MaterialReply>((resolve) => {
      finishPreparation = resolve;
    });
    const control = vi
      .fn<NonNullable<DesktopBridge['controlClassMaterials']>>()
      .mockImplementation((command) => {
        if (command.kind === 'prepare') {
          return pendingPreparation;
        }
        return Promise.resolve({ kind: 'collection', collection });
      });
    window.tro = { ...createDesktopBridge(), controlClassMaterials: control };
    render(
      createElement(MantineProvider, {
        children: createElement(LocaleProvider, {
          children: createElement(MaterialEditor, {
            classId: context.meeting.classId,
            live: false,
            t: (english) => english,
            onApproved: () => Promise.resolve(),
          }),
        }),
      }),
    );
    if (state === MaterialState.COLLECTING) {
      const prepare = await screen.findByRole('button', { name: 'Process materials' });
      await waitFor(() => {
        expect(prepare.hasAttribute('disabled')).toBe(false);
      });
      fireEvent.click(prepare);
    }
    const status = await screen.findByRole('status', { name: 'Preparing materials' });
    expect(within(status).getByText('Preparing your materials…')).toBeTruthy();
    const review = screen.getByRole('region', { name: 'Review your materials' });
    expect(review.getAttribute('aria-busy')).toBe('true');
    expect(status.querySelector('.mantine-Loader-root')).toBeTruthy();
    expect(screen.queryByText('Your materials, ready to teach with.')).toBeNull();
    if (state === MaterialState.COLLECTING) {
      await act(async () => {
        finishPreparation({
          kind: 'collection',
          collection: { ...collection, state: MaterialState.FAILED },
        });
        await pendingPreparation;
      });
      expect(screen.queryByRole('status')).toBeNull();
      expect(review.getAttribute('aria-busy')).toBe('false');
      expect(screen.getByText(/Preparation failed/)).toBeTruthy();
    }
  },
);

function createSavedAccountBridge() {
  const bridge = createDesktopBridge();
  const student = {
    id: 'student-user',
    name: 'Minh Nguyen',
    email: 'minh@example.test',
    isAdmin: false,
  } satisfies AuthUser;
  const teacherId = '11111111-1111-4111-8111-111111111111';
  const studentId = '22222222-2222-4222-8222-222222222222';
  const readSavedAccounts = vi
    .fn<NonNullable<DesktopBridge['readSavedAccounts']>>()
    .mockResolvedValue({
      kind: 'accounts',
      activeAccountId: teacherId,
      accounts: [
        { id: teacherId, user: testUser, role: AccountRole.TEACHER, requiresSignIn: false },
        { id: studentId, user: student, role: AccountRole.STUDENT, requiresSignIn: false },
      ],
    });
  const switchAccount = vi
    .fn<NonNullable<DesktopBridge['switchAccount']>>()
    .mockResolvedValue({ kind: 'signed-in', user: student });
  const addGoogleAccount = vi
    .fn<NonNullable<DesktopBridge['addGoogleAccount']>>()
    .mockResolvedValue({ kind: 'pending' });
  const cancelAccountSignIn = vi
    .fn<NonNullable<DesktopBridge['cancelAccountSignIn']>>()
    .mockResolvedValue({ kind: 'signed-in', user: testUser });
  window.tro = {
    ...bridge,
    readSavedAccounts,
    switchAccount,
    addGoogleAccount,
    cancelAccountSignIn,
  };
  return {
    bridge,
    student,
    studentId,
    readSavedAccounts,
    switchAccount,
    addGoogleAccount,
    cancelAccountSignIn,
  };
}

it('switches from the avatar menu, clears the previous task and draft, and keeps other logins', async () => {
  const fixture = createSavedAccountBridge();
  renderDesktop();
  const input = await screen.findByRole('textbox', { name: 'Your message' });
  fireEvent.change(input, { target: { value: 'Private teacher task' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
  await screen.findByText('Here is your answer.');
  fireEvent.change(input, { target: { value: 'Private teacher draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Minh Nguyen, Student' }));
  await screen.findByText(fixture.student.email);
  expect(screen.getByRole('textbox', { name: 'Your message' })).toHaveProperty('value', '');
  expect(screen.queryByText('Here is your answer.')).toBeNull();
  expect(fixture.switchAccount).toHaveBeenCalledExactlyOnceWith(fixture.studentId);
  expect(fixture.bridge.signOut).not.toHaveBeenCalled();
  expect(fixture.bridge.controlVoiceInput).toHaveBeenCalledWith({ kind: 'disable' });
});

it('adds an account through Google and allows cancellation back to the original account', async () => {
  const fixture = createSavedAccountBridge();
  renderDesktop();
  fireEvent.click(await screen.findByRole('button', { name: 'Switch account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add an account' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with Google' }));
  await within(dialog).findByText('Finish signing in in your browser.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel sign-in' }));
  await waitFor(() => {
    expect(fixture.cancelAccountSignIn).toHaveBeenCalledOnce();
  });
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Add an account' })).toBeNull();
  });
  expect(screen.getByText(testUser.email)).toBeTruthy();
  expect(fixture.addGoogleAccount).toHaveBeenCalledOnce();
  expect(fixture.bridge.signOut).not.toHaveBeenCalled();
});

it('offers QR alongside Google in Add account and preserves the Google login when selecting a QR student', async () => {
  const fixture = createSavedAccountBridge();
  const organizationId = '33333333-3333-4333-8333-333333333333';
  const student: AuthUser = {
    id: 'qr-student',
    name: 'QR student',
    email: null,
    isAdmin: false,
    learner: {
      schoolId: organizationId,
      organizationId,
      schoolName: 'School',
      classId: null,
      externalId: '001Ab',
      mode: StudentDeviceMode.PERSONAL,
      provisional: true,
    },
  };
  const control = vi
    .fn<NonNullable<DesktopBridge['controlStudentAccess']>>()
    .mockImplementation((command) => {
      if (command.kind === 'status') {
        return Promise.resolve({
          kind: 'ready',
          context: {
            schoolId: organizationId,
            organizationId,
            schoolName: 'School',
            classId: null,
            className: null,
            mode: StudentDeviceMode.PERSONAL,
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
        });
      }
      if (command.kind === 'enroll') {
        fixture.readSavedAccounts.mockResolvedValue({
          kind: 'accounts',
          activeAccountId: fixture.studentId,
          accounts: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              user: testUser,
              role: AccountRole.TEACHER,
              requiresSignIn: false,
            },
            {
              id: fixture.studentId,
              user: student,
              role: AccountRole.STUDENT,
              requiresSignIn: false,
            },
          ],
        });
        return Promise.resolve({ kind: 'signed-in', user: student });
      }
      return Promise.resolve({ kind: 'done' });
    });
  window.tro = { ...window.tro, controlStudentAccess: control };
  renderDesktop();
  fireEvent.click(await screen.findByRole('button', { name: 'Switch account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add an account' });
  expect(within(dialog).getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with QR' }));
  fireEvent.change(await within(dialog).findByLabelText(/Student ID/), {
    target: { value: '001Ab' },
  });
  expect(within(dialog).getByRole('button', { name: 'Scan your student card' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start learning' }));
  await waitFor(() => {
    expect(control).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'enroll', externalId: '001Ab', name: '' }),
    );
  });
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Add an account' })).toBeNull();
  });
  expect(fixture.addGoogleAccount).not.toHaveBeenCalled();
  expect(fixture.bridge.signOut).not.toHaveBeenCalled();
  const accounts = await fixture.readSavedAccounts();
  if (accounts.kind !== 'accounts') {
    throw new Error('Missing saved accounts.');
  }
  expect(accounts.accounts.some((account) => account.user.id === testUser.id)).toBe(true);
});

it('keeps the current account on an expired target and translates the error', async () => {
  const fixture = createSavedAccountBridge();
  window.localStorage.setItem(localeStorageKey, DesktopLocale.VIETNAMESE);
  fixture.switchAccount.mockResolvedValue({
    kind: 'failed',
    message: 'Sign in to this account again.',
  });
  renderDesktop();
  const accountButton = await screen.findByRole('button', { name: 'Chuyển tài khoản' });
  await waitFor(() => {
    expect(accountButton.hasAttribute('disabled')).toBe(false);
  });
  fireEvent.click(accountButton);
  fireEvent.click(await screen.findByRole('button', { name: 'Minh Nguyen, Học sinh' }));
  await screen.findByText('Phiên đăng nhập đã hết hạn. Thêm lại tài khoản bằng Google.');
  expect(screen.getByText(testUser.email)).toBeTruthy();
  expect(screen.queryByText(fixture.student.email)).toBeNull();
});

it('offers saved accounts after signing out of only the current account', async () => {
  const fixture = createSavedAccountBridge();
  renderDesktop();
  await screen.findByRole('textbox', { name: 'Your message' });
  fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out of this account' }));
  await screen.findByRole('button', { name: 'Continue with Google' });
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(document.querySelector('.desktop-sidebar')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Minh Nguyen, Student' }));
  await screen.findByText(fixture.student.email);
  expect(fixture.switchAccount).toHaveBeenCalledExactlyOnceWith(fixture.studentId);
  expect(fixture.bridge.signInWithGoogle).not.toHaveBeenCalled();
});

it('restores an existing classroom participation when the desktop opens', async () => {
  const bridge = createDesktopBridge();
  const context = createTeachingContext();
  bridge.controlClassroom.mockImplementation((command) => {
    if (command.kind === 'home') {
      return Promise.resolve({
        kind: 'home',
        home: {
          role: AccountRole.STUDENT,
          isAdmin: false,
          courses: [],
          classes: [
            {
              schoolClass: {
                id: context.meeting.classId,
                name: context.className,
                teacherId: 'teacher',
                courseRevisionId: context.courseRevisionId,
              },
              meetings: [context.meeting],
            },
          ],
        },
      });
    }
    if (command.kind === 'resume' || command.kind === 'context') {
      return Promise.resolve({ kind: 'context', context });
    }
    return Promise.resolve({ kind: 'ok' });
  });
  window.tro = bridge;
  renderDesktop();
  await waitFor(() => {
    expect(bridge.controlClassroom).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'resume' }),
    );
  });
  fireEvent.click(screen.getByRole('button', { name: 'Classroom' }));
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(context.className) }));
  expect(await screen.findByRole('button', { name: 'Leave session' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Join session' })).toBeNull();
  expect(bridge.controlClassroom.mock.calls.some(([command]) => command.kind === 'join')).toBe(
    false,
  );
});

it('runs the navbar introduction without navigating and restarts it from Settings', async () => {
  let saved: OnboardingProgress = createOnboardingProgress();
  const store: OnboardingStore = {
    readProgress: () => Promise.resolve(saved),
    saveProgress: (_accountId, progress) => {
      saved = progress;
      return Promise.resolve();
    },
  };
  const service = new OnboardingService(store);
  const restartOnboarding = vi
    .fn<NonNullable<DesktopBridge['restartOnboarding']>>()
    .mockImplementation((request) =>
      service.changeProgress(
        request.expectedAccountId,
        request.expectedRevision,
        OnboardingAction.RESTART,
      ),
    );
  window.tro = {
    ...createDesktopBridge(),
    readOnboardingProgress: (request) => service.readProgress(request.expectedAccountId),
    updateOnboardingProgress: (request) =>
      service.changeProgress(request.expectedAccountId, request.expectedRevision, request.action),
    restartOnboarding,
  };
  renderDesktop();
  await screen.findByRole('dialog', { name: 'A little help getting started.' });
  fireEvent.click(screen.getByRole('button', { name: 'Show me around' }));
  await screen.findByRole('heading', { name: 'Start with what you want to learn.' });
  expect(screen.queryByText('Read transcript')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Your class, materials and activities.' });
  expect(window.location.hash).toBe('#/workspace');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'See how far you’ve come.' });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Watch, try, then make it yours.' });
  expect(
    screen.getByText('Coming soon. This is a preview; lessons are not available in this version.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Guided Lessons (Beta)' })).toBeNull();
  expect(screen.getByLabelText('Video introduction').getAttribute('src')).toMatch(
    /StudentGuidedLessons\.mp4$/,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'Talk to Tro with your microphone.' });
  expect(screen.getByLabelText('Video introduction').getAttribute('src')).toMatch(
    /Microphone\.mp4$/,
  );
  expect(screen.getByText('Step 5 of 6')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('heading', { name: 'A little companion on your screen.' });
  expect(screen.getByLabelText('Video introduction').getAttribute('src')).toMatch(/Pets\.mp4$/);
  expect(window.location.hash).toBe('#/workspace');
  fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
  await screen.findByRole('dialog', { name: 'Ready to explore Tro.' });
  fireEvent.click(screen.getByRole('button', { name: 'Explore Tro' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  await screen.findByRole('button', { name: 'Restart onboarding' });
  fireEvent.change(screen.getByLabelText('Language'), {
    target: { value: DesktopLocale.VIETNAMESE },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu lại hướng dẫn' }));
  await screen.findByRole('heading', { name: 'Bắt đầu từ điều bạn muốn học.' });
  expect(restartOnboarding).toHaveBeenCalledExactlyOnceWith({
    expectedAccountId: testUser.id,
    expectedRevision: 7,
  });
  expect(saved.revision).toBe(8);
});

function createReleaseBridge(shouldAutoShow = false) {
  const status = {
    installedVersion: '0.1.0',
    releaseId: '0.1.0',
    hasUnseenRelease: true,
    shouldAutoShow,
  };
  return {
    ...createDesktopBridge(),
    readWhatsNew: vi
      .fn<NonNullable<DesktopBridge['readWhatsNew']>>()
      .mockResolvedValue({ kind: 'ok', status }),
    markWhatsNewSeen: vi.fn<NonNullable<DesktopBridge['markWhatsNewSeen']>>().mockResolvedValue({
      kind: 'ok',
      status: { ...status, hasUnseenRelease: false, shouldAutoShow: false },
    }),
  } satisfies DesktopBridge;
}

describe('what’s new', () => {
  it('keeps a permanent entry before Settings, clears the unread dot and replays from the first slide', async () => {
    const bridge = createReleaseBridge();
    window.tro = bridge;
    renderDesktop();
    const open = await screen.findByRole('button', { name: 'What’s new' });
    await screen.findByRole('img', { name: 'New release highlights' });
    expect(
      open.compareDocumentPosition(screen.getByRole('button', { name: 'Settings' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull();
    fireEvent.click(open);
    let dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    expect(within(dialog).getByRole('heading', { name: 'A hint when it matters.' })).toBeTruthy();
    await waitFor(() => {
      expect(bridge.markWhatsNewSeen).toHaveBeenCalledOnce();
    });
    expect(screen.queryByRole('img', { name: 'New release highlights' })).toBeNull();
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Next' }), {
      key: 'ArrowRight',
    });
    expect(
      within(dialog).getByRole('heading', { name: 'Know your class a little better.' }),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start exploring' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'What’s new' }));
    dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    expect(within(dialog).getByRole('heading', { name: 'A hint when it matters.' })).toBeTruthy();
    expect(bridge.markWhatsNewSeen).toHaveBeenCalledOnce();
  });

  it('automatically presents pending highlights once after sign-in and permission readiness', async () => {
    const bridge = createReleaseBridge(true);
    let completePermissions:
      ((value: Awaited<ReturnType<DesktopBridge['readDesktopPermissions']>>) => void) | undefined;
    bridge.readDesktopPermissions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completePermissions = resolve;
        }),
    );
    window.tro = bridge;
    renderDesktop();
    await screen.findByRole('button', { name: 'What’s new' });
    expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull();
    act(() => {
      completePermissions?.({
        kind: 'ready',
        accessibility: 'granted',
        screenRecording: 'granted',
      });
    });
    const dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    await waitFor(() => {
      expect(bridge.markWhatsNewSeen).toHaveBeenCalledOnce();
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close introduction' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close settings' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    });
    expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull();
    expect(bridge.markWhatsNewSeen).toHaveBeenCalledOnce();
  });

  it('supports Vietnamese manual replay while signed out without auto-opening pending highlights', async () => {
    window.localStorage.setItem(localeStorageKey, DesktopLocale.VIETNAMESE);
    const bridge = createReleaseBridge(true);
    bridge.readAuthSession.mockResolvedValue({ kind: 'signed-out' });
    window.tro = bridge;
    renderDesktop();
    const open = await screen.findByRole('button', { name: 'Có gì mới' });
    expect(screen.queryByRole('dialog', { name: 'Có gì mới' })).toBeNull();
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Có gì mới' });
    expect(within(dialog).getByRole('heading', { name: 'Một gợi ý, đúng lúc cần.' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Đóng phần giới thiệu' }));
    await waitFor(() => {
      expect(bridge.markWhatsNewSeen).toHaveBeenCalledOnce();
    });
  });

  it('keeps the tour usable and explains a seen-state save failure', async () => {
    const bridge = createReleaseBridge();
    bridge.markWhatsNewSeen.mockResolvedValue({ kind: 'failed', reason: 'unavailable' });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'What’s new' }));
    const dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    expect(
      await within(dialog).findByText(
        'Could not save that you viewed this release. It may appear again after restarting.',
      ),
    ).toBeTruthy();
  });
});

it('defers first-time onboarding until pending release highlights close', async () => {
  const progress = createOnboardingProgress();
  window.tro = {
    ...createReleaseBridge(true),
    readOnboardingProgress: vi
      .fn<NonNullable<DesktopBridge['readOnboardingProgress']>>()
      .mockResolvedValue({ kind: 'ok', progress }),
    updateOnboardingProgress: vi
      .fn<NonNullable<DesktopBridge['updateOnboardingProgress']>>()
      .mockResolvedValue({ kind: 'ok', progress }),
    restartOnboarding: vi
      .fn<NonNullable<DesktopBridge['restartOnboarding']>>()
      .mockResolvedValue({ kind: 'ok', progress }),
  };
  renderDesktop();
  const releaseDialog = await screen.findByRole('dialog', { name: 'What’s new' });
  expect(screen.queryByRole('dialog', { name: 'A little help getting started.' })).toBeNull();
  fireEvent.click(within(releaseDialog).getByRole('button', { name: 'Close introduction' }));
  await screen.findByRole('dialog', { name: 'A little help getting started.' });
  expect(screen.queryByRole('dialog', { name: 'What’s new' })).toBeNull();
});

it('lets an appointed owner review and save a permanent organization name before continuing', async () => {
  const bridge = createDesktopBridge();
  const organizationId = '11111111-1111-4111-8111-111111111111';
  let savedName: string | null = null;
  const controlOrganizations = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockImplementation(({ command }): Promise<OrganizationReply> => {
      if (command.kind === OrganizationAction.SET_NAME) {
        savedName = command.name;
        return Promise.resolve({ kind: 'ok' });
      }
      return Promise.resolve({
        kind: 'home',
        isAdmin: false,
        organizations: [
          {
            id: organizationId,
            name: savedName ?? 'Organization',
            isNameSet: savedName !== null,
            ownerUserId: testUser.id,
            isOwner: true,
            role: AccountRole.STUDENT,
          },
        ],
      });
    });
  window.tro = { ...bridge, controlOrganizations };
  renderDesktop();
  const dialog = await screen.findByRole('dialog', { name: 'Name your organization' });
  await within(dialog).findByRole('textbox', { name: 'Organization name' });
  expect(document.querySelector('.main-panel')?.hasAttribute('inert')).toBe(true);
  expect(bridge.controlVoiceInput.mock.calls.some(([command]) => command.kind === 'enable')).toBe(
    false,
  );
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: 'Name your organization' })).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Organization name' }), {
    target: { value: '  Our school  ' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review name' }));
  expect(
    controlOrganizations.mock.calls.some(
      ([request]) => request.command.kind === OrganizationAction.SET_NAME,
    ),
  ).toBe(false);
  expect(within(dialog).getByRole('textbox', { name: 'Organization name' })).toHaveProperty(
    'readOnly',
    true,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Edit name' }));
  expect(within(dialog).getByRole('textbox', { name: 'Organization name' })).toHaveProperty(
    'readOnly',
    false,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review name' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm permanent name' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Name your organization' })).toBeNull();
  });
  expect(controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: testUser.id,
    command: { kind: OrganizationAction.SET_NAME, organizationId, name: 'Our school' },
  });
  expect(document.querySelector('.main-panel')?.hasAttribute('inert')).toBe(false);
  cleanup();
  renderDesktop();
  await screen.findByText(testUser.email);
  await waitFor(() => {
    expect(document.querySelector('.main-panel')?.hasAttribute('inert')).toBe(false);
  });
  expect(screen.queryByRole('dialog', { name: 'Name your organization' })).toBeNull();
});

it('opens the selected owner organization logo controls from the sidebar shortcut', async () => {
  const firstId = '11111111-1111-4111-8111-111111111111';
  const ownerId = '22222222-2222-4222-8222-222222222222';
  const owned = { id: ownerId, name: 'Owner school', ownerUserId: testUser.id, isNameSet: true };
  const controlOrganizations = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockImplementation(({ command }): Promise<OrganizationReply> =>
      Promise.resolve(
        command.kind === OrganizationAction.TEAM
          ? {
              kind: 'team',
              organization: owned,
              members: [],
              invitations: [],
            }
          : {
              kind: 'home',
              isAdmin: false,
              organizations: [
                {
                  id: firstId,
                  name: 'Member school',
                  ownerUserId: 'other-owner',
                  isNameSet: true,
                  isOwner: false,
                  role: AccountRole.STUDENT,
                },
                { ...owned, isOwner: true, role: AccountRole.STUDENT },
              ],
            },
      ),
    );
  window.tro = { ...createDesktopBridge(), controlOrganizations };
  renderDesktop();
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Choose organization branding: Member school · Tro',
    }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Owner school' }));
  fireEvent.click(
    screen.getByRole('button', { name: 'Choose organization branding: Owner school · Tro' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Change organization logo' }));
  expect(await screen.findByRole('region', { name: 'Organization logo' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Team' }).getAttribute('aria-selected')).toBe('true');
  expect(controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: testUser.id,
    command: { kind: OrganizationAction.TEAM, organizationId: ownerId },
  });
});

it('offers approved owners organization creation after sign-in and creates only after name confirmation', async () => {
  const bridge = createDesktopBridge();
  let name: string | null = null;
  const controlOrganizations = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockImplementation(({ command }): Promise<OrganizationReply> => {
      if (command.kind === OrganizationAction.CREATE_OWN_ORGANIZATION) {
        name = command.name;
        return Promise.resolve({ kind: 'ok' });
      }
      return Promise.resolve({
        kind: 'home',
        isAdmin: false,
        canCreateOrganization: name === null,
        hasChosenOrganization: name !== null,
        organizations: name
          ? [
              {
                id: '11111111-1111-4111-8111-111111111111',
                name,
                ownerUserId: testUser.id,
                isOwner: true,
                isNameSet: true,
                role: AccountRole.STUDENT,
              },
            ]
          : [],
      });
    });
  window.tro = { ...bridge, controlOrganizations };
  renderDesktop();
  const choice = await screen.findByRole('dialog', { name: 'How will you use Tro?' });
  const create = await within(choice).findByRole('button', { name: 'Create organization' });
  expect(bridge.controlClassroom).not.toHaveBeenCalled();
  expect(within(choice).getByRole('button', { name: 'Continue on my own' })).toBeTruthy();
  fireEvent.click(create);
  const naming = screen.getByRole('dialog', { name: 'Name your organization' });
  fireEvent.change(within(naming).getByRole('textbox', { name: 'Organization name' }), {
    target: { value: 'Our school' },
  });
  fireEvent.click(within(naming).getByRole('button', { name: 'Review name' }));
  expect(
    controlOrganizations.mock.calls.some(
      ([request]) => request.command.kind === OrganizationAction.CREATE_OWN_ORGANIZATION,
    ),
  ).toBe(false);
  fireEvent.click(within(naming).getByRole('button', { name: 'Confirm permanent name' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Name your organization' })).toBeNull();
  });
  expect(controlOrganizations).toHaveBeenCalledWith({
    expectedAccountId: testUser.id,
    command: { kind: OrganizationAction.CREATE_OWN_ORGANIZATION, name: 'Our school' },
  });
});

it('lets unapproved users continue personally without offering organization ownership', async () => {
  let chosen = false;
  const controlOrganizations = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockImplementation(({ command }): Promise<OrganizationReply> => {
      if (command.kind === OrganizationAction.CONTINUE_PERSONAL) {
        chosen = true;
        return Promise.resolve({ kind: 'ok' });
      }
      return Promise.resolve({
        kind: 'home',
        isAdmin: false,
        canCreateOrganization: false,
        hasChosenOrganization: chosen,
        organizations: [],
      });
    });
  window.tro = { ...createDesktopBridge(), controlOrganizations };
  renderDesktop();
  const choice = await screen.findByRole('dialog', { name: 'How will you use Tro?' });
  const personal = await within(choice).findByRole('button', { name: 'Continue on my own' });
  expect(within(choice).queryByRole('button', { name: 'Create organization' })).toBeNull();
  fireEvent.click(personal);
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'How will you use Tro?' })).toBeNull();
  });
  expect(chosen).toBe(true);
  cleanup();
  renderDesktop();
  await screen.findByText(testUser.email);
  await waitFor(() => {
    expect(document.querySelector('.main-panel')?.hasAttribute('inert')).toBe(false);
  });
  expect(screen.queryByRole('dialog', { name: 'How will you use Tro?' })).toBeNull();
});

it('lets a QR learner reach their class without requesting organization setup or team controls', async () => {
  const bridge = createDesktopBridge();
  bridge.readAuthSession.mockResolvedValue({
    kind: 'signed-in',
    user: {
      id: 'qr-learner',
      name: 'QR learner',
      email: null,
      isAdmin: false,
      learner: {
        schoolId: '11111111-1111-4111-8111-111111111111',
        schoolName: 'Personal school',
        classId: '22222222-2222-4222-8222-222222222222',
        externalId: 'ST-001',
        mode: StudentDeviceMode.PERSONAL,
        provisional: true,
      },
    },
  });
  const controlOrganizations = vi
    .fn<NonNullable<DesktopBridge['controlOrganizations']>>()
    .mockResolvedValue({ kind: 'failed', code: 'forbidden' });
  window.tro = { ...bridge, controlOrganizations };
  renderDesktop();
  await waitFor(() => {
    expect(bridge.controlClassroom).toHaveBeenCalled();
  });
  expect(controlOrganizations).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: 'How will you use Tro?' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.queryByRole('tab', { name: 'Team' })).toBeNull();
});
