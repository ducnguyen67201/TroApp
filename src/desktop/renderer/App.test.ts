// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import type { AuthUser } from '#contracts/AuthSession.js';
import type { AgentResult } from '#contracts/AgentSession.js';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import type { VoiceReply } from '#contracts/VoiceInput.js';
import { App } from './App.js';
import { DesktopLocale, localeStorageKey } from './localization/Locale.js';
import { LocaleProvider } from './localization/LocaleProvider.js';
import { desktopTheme, resolveDesktopCssVariables } from './Theme.js';

const testUser: AuthUser = { id: 'test-user', name: 'Alex Example', email: 'alex@example.test' };
const sessionId = 'a8f6d44a-5c18-4ce3-9237-44624549f63f';

function createDesktopBridge() {
  return {
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
    updateVoiceMeter: vi.fn<DesktopBridge['updateVoiceMeter']>(),
    appendVoiceAudio: vi
      .fn<DesktopBridge['appendVoiceAudio']>()
      .mockResolvedValue({ kind: 'failed' }),
    subscribeVoiceInput: vi.fn<DesktopBridge['subscribeVoiceInput']>().mockReturnValue(() => {}),
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
    sendAgentMessage: vi
      .fn<DesktopBridge['sendAgentMessage']>()
      .mockResolvedValue({ kind: 'completed', answer: 'Here is your answer.' }),
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
    const account = screen.getByRole('region', { name: 'Your account' });
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

  it('shows the signed-in account in the sidebar and only the two navigation choices', async () => {
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
    expect(screen.getAllByText(testUser.email)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
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
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveProperty('disabled', true);
    completeTask?.({ kind: 'completed', answer: 'Task finished.' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign out' })).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
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
    expect(screen.getByRole('button', { name: 'Đăng xuất' })).toHaveProperty('disabled', true);
    expect(bridge.stopAgentSession).not.toHaveBeenCalled();
    completeTask?.({ kind: 'completed', answer: 'Completed in the original language.' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Đăng xuất' })).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Không gian làm việc' }));
    expect(screen.getByText('Completed in the original language.')).toBeTruthy();
    expect(screen.getByText('Keep working')).toBeTruthy();
    expect(bridge.sendAgentMessage).toHaveBeenLastCalledWith(
      sessionId,
      'Keep working',
      DesktopLocale.ENGLISH,
      AgentTaskMode.TEACH,
    );
    bridge.sendAgentMessage.mockResolvedValue({ kind: 'completed', answer: 'Đã hoàn tất.' });
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
    expect(screen.getByRole('status').textContent).toContain('could not be saved');
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
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the sign-in service.');
    expect(bridge.readAuthSession).toHaveBeenCalledTimes(1);
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(bridge.stopAgentSession).toHaveBeenCalledWith(sessionId);
    });
    finishTask?.({ kind: 'completed', answer: 'Late guide answer' });
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
      result: { kind: 'completed', answer: 'Opened Chrome' },
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

it('makes voice available automatically and keeps it active across Settings navigation', async () => {
  const bridge = createDesktopBridge();
  window.tro = bridge;
  renderDesktop();
  expect(await screen.findByText('Hold to talk; release to send')).toBeTruthy();
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
  fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
  expect(await screen.findByText('Hold to talk; release to send')).toBeTruthy();
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
