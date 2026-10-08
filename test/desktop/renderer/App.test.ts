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
import { AccountRole } from '#contracts/AccountRole.js';
import { createTeachingContext } from '../../server/features/classroom/ClassroomFixtures.js';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import type { AuthUser } from '#contracts/AuthSession.js';
import type { AgentResult } from '#contracts/AgentSession.js';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import type { VoiceReply } from '#contracts/VoiceInput.js';
import { AppUpdateState, type AppUpdateSnapshot } from '#contracts/AppUpdate.js';
import { CompletionMode, TaskOutcomeStatus } from '#contracts/TaskOutcome.js';
import { microphoneStorageKey } from '../../../src/desktop/renderer/voice/Microphones.js';
import { App } from '../../../src/desktop/renderer/App.js';
import {
  DesktopLocale,
  localeStorageKey,
} from '../../../src/desktop/renderer/localization/Locale.js';
import { LocaleProvider } from '../../../src/desktop/renderer/localization/LocaleProvider.js';
import { desktopTheme, resolveDesktopCssVariables } from '../../../src/desktop/renderer/Theme.js';

const testUser: AuthUser = { id: 'test-user', name: 'Alex Example', email: 'alex@example.test' };
const sessionId = 'a8f6d44a-5c18-4ce3-9237-44624549f63f';

function createDesktopBridge() {
  return {
    controlClassroom: vi.fn<NonNullable<DesktopBridge['controlClassroom']>>().mockResolvedValue({
      kind: 'home',
      home: { role: AccountRole.STUDENT, courses: [], classes: [] },
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
  window.location.hash = '#/workspace';
  window.localStorage.clear();
  window.localStorage.setItem(localeStorageKey, DesktopLocale.ENGLISH);
  window.tro = createDesktopBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('desktop scaffold', () => {
  it('updates the sidebar after Google returns and enters the workspace', async () => {
    const bridge = createDesktopBridge();
    bridge.readAuthSession.mockResolvedValueOnce({ kind: 'signed-out' });
    bridge.signInWithGoogle.mockResolvedValue({ kind: 'pending' });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const account = screen.getByRole('region', { name: 'Your account', hidden: true });
    await waitFor(
      () => {
        expect(within(account).getByText(testUser.email)).toBeTruthy();
      },
      { timeout: 2500 },
    );
    await screen.findByRole('heading', { name: 'Welcome back, Alex' });
    expect(bridge.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('shows the signed-in account in the sidebar and classroom navigation and account role', async () => {
    renderDesktop();
    const account = await screen.findByRole('region', { name: 'Your account' });
    await within(account).findByText(testUser.email);
    expect(within(account).getByText(testUser.name)).toBeTruthy();
    expect(within(account).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Workspace' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Welcome back, Alex' })).toBeTruthy();
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
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Account' }));
    expect(within(dialog).getByText(testUser.email)).toBeTruthy();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'General' }));
    expect(within(dialog).getByRole('combobox', { name: 'Language' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close settings' }));
    expect(screen.getByRole('textbox', { name: 'Your message' })).toBe(input);
    expect(input).toHaveProperty('value', 'Keep this draft');
    expect(bridge.startAgentSession).not.toHaveBeenCalled();
  });

  it('clears account, draft and conversation after successful sidebar sign-out', async () => {
    const bridge = createDesktopBridge();
    window.tro = bridge;
    renderDesktop();
    const input = await screen.findByRole('textbox', { name: 'Your message' });
    fireEvent.change(input, { target: { value: 'A private task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Tro' }));
    await screen.findByText('Here is your answer.');
    fireEvent.change(input, { target: { value: 'A private draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Continue with Google' });
    expect(screen.queryByText(testUser.email)).toBeNull();
    expect(screen.queryByText('Here is your answer.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await screen.findByRole('textbox', { name: 'Your message' });
    expect(screen.getByRole('textbox', { name: 'Your message' })).toHaveProperty('value', '');
    expect(screen.queryByText('Here is your answer.')).toBeNull();
    expect(bridge.signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps sign-out disabled during an active task, including on Settings', async () => {
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
    expect(screen.getByRole('button', { name: 'Sign out', hidden: true })).toHaveProperty(
      'disabled',
      true,
    );
    completeTask?.({
      kind: 'completed',
      completion: { kind: 'response' },
      answer: 'Task finished.',
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign out', hidden: true })).toHaveProperty(
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
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
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
    expect(screen.getByText('Đăng nhập ở thanh bên để xem tài khoản của bạn.')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'Đăng xuất', hidden: true })).toHaveProperty(
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
      expect(screen.getByRole('button', { name: 'Đăng xuất', hidden: true })).toHaveProperty(
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
      within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('status').textContent,
    ).toContain('could not be saved');
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

  it('uses a localized fallback for an unknown bridge error', async () => {
    window.localStorage.clear();
    const bridge = createDesktopBridge();
    bridge.signOut.mockResolvedValue({ kind: 'failed', message: 'Unrecognized diagnostic' });
    window.tro = bridge;
    renderDesktop();
    fireEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
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

it('selects and saves a suggested microphone from the accessible picker without opening audio', async () => {
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
    expect(window.localStorage.getItem(microphoneStorageKey)).toBe('usb');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
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
    expect(screen.getByText(/Sound is measured on this device/)).toBeTruthy();
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

describe('sidebar app updates', () => {
  it('stays hidden without an update and shows above Settings even before sign-in', async () => {
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
  const student: AuthUser = { id: 'student-user', name: 'Minh Nguyen', email: 'minh@example.test' };
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
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('button', { name: 'Continue with Google' });
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
