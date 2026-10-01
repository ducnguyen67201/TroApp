import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AuthStatus, type AuthState } from '#contracts/Auth.js';
import type { SystemStatusResult } from '#contracts/SystemStatus.js';
import {
  createWorkspace,
  exchangeAuthHandoff,
  fetchAuthState,
  fetchServiceStatus,
  revokeSession,
  startGoogleSignIn,
} from './BackendClient.js';
import { readDesktopEnv } from './Env.js';
import { clearSessionToken, readSessionToken, saveSessionToken } from './SessionVault.js';
import { isTrustedFrameUrl } from './TrustedFrame.js';

const mainDirectory = dirname(fileURLToPath(import.meta.url));
const pendingAuthUrls: string[] = [];
let mainWindow: BrowserWindow | undefined;
let processReceivedAuthUrl: ((url: string) => Promise<void>) | undefined;

function readAuthUrl(argumentsList: string[]): string | undefined {
  return argumentsList.find((value) => value.startsWith('tro://auth/'));
}

const initialAuthUrl = readAuthUrl(process.argv);

if (initialAuthUrl) {
  pendingAuthUrls.push(initialAuthUrl);
}

function receiveAuthUrl(url: string): void {
  if (processReceivedAuthUrl) {
    void processReceivedAuthUrl(url);
  } else {
    pendingAuthUrls.push(url);
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  receiveAuthUrl(url);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argumentsList) => {
    const authUrl = readAuthUrl(argumentsList);

    if (authUrl) {
      receiveAuthUrl(authUrl);
    }

    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }

      mainWindow.focus();
    }
  });
}

async function startDesktop(): Promise<void> {
  /* Vite embeds this public URL when packaging the desktop app. The validator
     supplies the local development default and rejects unsafe values. */
  const environment = readDesktopEnv({
    environment: process.env,
    bundledApiUrl: import.meta.env['MAIN_VITE_API_BASE_URL'],
    bundledAppEnvironment: import.meta.env['MAIN_VITE_APP_ENV'],
    isPackaged: app.isPackaged,
  });
  const rendererFile = join(mainDirectory, '../renderer/index.html');
  const developmentUrl = app.isPackaged ? undefined : environment.RENDERER_URL;
  const documentUrl = developmentUrl ?? pathToFileURL(rendererFile).href;

  await app.whenReady();
  app.setAsDefaultProtocolClient('tro');

  function isTrustedEvent(event: IpcMainInvokeEvent): boolean {
    return Boolean(
      mainWindow &&
      event.sender === mainWindow.webContents &&
      event.senderFrame === mainWindow.webContents.mainFrame &&
      isTrustedFrameUrl(event.senderFrame.url, documentUrl),
    );
  }

  function notifyAuthState(state: AuthState): void {
    mainWindow?.webContents.send('tro:auth-state-changed', state);
  }

  async function processAuthUrl(value: string): Promise<void> {
    try {
      const url = new URL(value);

      if (url.protocol !== 'tro:' || url.hostname !== 'auth' || url.pathname !== '/callback') {
        throw new Error('The authentication callback is invalid.');
      }

      const handoff = url.searchParams.get('handoff');

      if (!handoff || url.searchParams.has('error')) {
        notifyAuthState({ status: AuthStatus.SIGNED_OUT });
        return;
      }

      const result = await exchangeAuthHandoff(environment.API_BASE_URL, handoff);
      await saveSessionToken(result.sessionToken);
      notifyAuthState(result.state);
    } catch {
      notifyAuthState({ status: AuthStatus.SIGNED_OUT });
    }
  }

  processReceivedAuthUrl = processAuthUrl;

  async function processPendingAuthUrls(): Promise<void> {
    for (const url of pendingAuthUrls.splice(0)) {
      await processAuthUrl(url);
    }
  }

  ipcMain.handle('tro:read-service-status', async (event): Promise<SystemStatusResult> => {
    /* A window can navigate after creation. Check its sender, main frame, and
       current URL on every call before allowing a backend request. */
    if (!isTrustedEvent(event)) {
      return { success: false, message: 'This window cannot request service status.' };
    }

    try {
      return { success: true, status: await fetchServiceStatus(environment.API_BASE_URL) };
    } catch {
      return { success: false, message: 'Could not connect. Check that the backend is running.' };
    }
  });

  ipcMain.handle('tro:read-auth-state', async (event) => {
    if (!isTrustedEvent(event)) {
      return { success: false, message: 'This window cannot read sign-in state.' };
    }

    try {
      const sessionToken = await readSessionToken();

      if (!sessionToken) {
        return { success: true, state: { status: AuthStatus.SIGNED_OUT } };
      }

      return {
        success: true,
        state: await fetchAuthState(environment.API_BASE_URL, sessionToken),
      };
    } catch {
      return { success: false, message: 'Could not verify your session. Please retry.' };
    }
  });

  ipcMain.handle('tro:start-google-sign-in', async (event) => {
    if (!isTrustedEvent(event)) {
      return { success: false, message: 'This window cannot start sign-in.' };
    }

    try {
      const authorizeUrl = await startGoogleSignIn(environment.API_BASE_URL);
      await shell.openExternal(authorizeUrl);

      return { success: true };
    } catch {
      return { success: false, message: 'Could not start Google sign-in. Please retry.' };
    }
  });

  ipcMain.handle('tro:create-workspace', async (event, displayName: unknown) => {
    if (!isTrustedEvent(event) || typeof displayName !== 'string') {
      return { success: false, message: 'This window cannot create a workspace.' };
    }

    try {
      const sessionToken = await readSessionToken();

      if (!sessionToken) {
        return { success: false, message: 'Sign in before creating a workspace.' };
      }

      return {
        success: true,
        state: await createWorkspace(environment.API_BASE_URL, sessionToken, displayName),
      };
    } catch {
      return { success: false, message: 'Could not create the workspace. Please retry.' };
    }
  });

  ipcMain.handle('tro:logout', async (event) => {
    if (!isTrustedEvent(event)) {
      return { success: false, message: 'This window cannot sign out.' };
    }

    try {
      const sessionToken = await readSessionToken();

      if (sessionToken) {
        await revokeSession(environment.API_BASE_URL, sessionToken);
      }

      await clearSessionToken();

      return { success: true, state: { status: AuthStatus.SIGNED_OUT } };
    } catch {
      return { success: false, message: 'Could not sign out. Please retry.' };
    }
  });

  async function openWindow(): Promise<void> {
    const window = new BrowserWindow({
      width: 1000,
      height: 720,
      minWidth: 680,
      minHeight: 520,
      title: 'Tro',
      webPreferences: {
        preload: join(mainDirectory, '../preload/Preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    mainWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isTrustedFrameUrl(targetUrl, documentUrl)) {
        event.preventDefault();
      }
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    window.on('closed', () => {
      mainWindow = undefined;
    });

    if (developmentUrl) {
      await window.loadURL(developmentUrl);
    } else {
      await window.loadFile(rendererFile);
    }

    await processPendingAuthUrls();
  }

  await openWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openWindow().catch(() => {
        app.quit();
      });
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

if (hasSingleInstanceLock) {
  void startDesktop().catch(() => {
    console.error('Tro could not start. Check desktop configuration.');
    app.quit();
  });
}
