// @vitest-environment happy-dom
import { createElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import type { AuthUser } from '#contracts/AuthSession.js';
import type { AgentResult } from '#contracts/AgentSession.js';
import { App } from './App.js';
import { desktopTheme, resolveDesktopCssVariables } from './Theme.js';

const testUser: AuthUser = { id: 'test-user', name: 'Alex Example', email: 'alex@example.test' };
const sessionId = 'a8f6d44a-5c18-4ce3-9237-44624549f63f';

function createDesktopBridge() {
  return {
    readAuthSession: vi
      .fn<DesktopBridge['readAuthSession']>()
      .mockResolvedValue({ kind: 'signed-in', user: testUser }),
    signInWithGoogle: vi
      .fn<DesktopBridge['signInWithGoogle']>()
      .mockResolvedValue({ kind: 'signed-in', user: testUser }),
    signOut: vi.fn<DesktopBridge['signOut']>().mockResolvedValue({ kind: 'signed-out' }),
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
      children: createElement(App),
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
  window.tro = createDesktopBridge();
});

afterEach(() => {
  cleanup();
});

describe('desktop scaffold', () => {
  it('updates the sidebar after Google returns, even when Settings is open', async () => {
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
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
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
    expect(screen.getByRole('heading', { name: 'Welcome back, Alex' })).toBeTruthy();
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
    expect(bridge.sendAgentMessage).toHaveBeenLastCalledWith(sessionId, 'A draft to keep');
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
});
