import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppEnvironment } from '#contracts/AppEnvironment.js';
import { AgentCommandSchema, type AgentResult } from '#contracts/AgentSession.js';
import { AuthCommandSchema, type AuthResult } from '#contracts/AuthSession.js';
import { readDesktopEnv } from './Env.js';
import { AgentWorkerClient } from './AgentWorkerClient.js';
import { AgentChatController } from './AgentChatController.js';
import { AuthClient } from './AuthClient.js';
import { isTrustedFrameUrl } from './TrustedFrame.js';

const mainDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let chat: AgentChatController | undefined;

async function startDesktop(): Promise<void> {
  /* Vite embeds this public URL when packaging the desktop app. The validator
     supplies the local development default and rejects unsafe values. */
  const environment = readDesktopEnv({
    environment: process.env,
    bundledApiUrl: import.meta.env['MAIN_VITE_API_BASE_URL'],
    bundledAppEnvironment: import.meta.env['MAIN_VITE_APP_ENV'],
    isPackaged: app.isPackaged,
  });
  const agentWorker = new AgentWorkerClient(
    join(mainDirectory, 'StartAgentWorker.js'),
    environment.APP_ENV === AppEnvironment.DEV,
  );
  const rendererFile = join(mainDirectory, '../renderer/index.html');
  const developmentUrl = app.isPackaged ? undefined : environment.RENDERER_URL;
  const documentUrl = developmentUrl ?? pathToFileURL(rendererFile).href;

  const auth = new AuthClient(environment.API_BASE_URL, app.getPath('userData'));
  /* The OAuth protocol must be registered before Electron becomes ready. */
  auth.registerDeepLink(() => mainWindow);
  await app.whenReady();
  chat = new AgentChatController(auth, agentWorker, `${environment.API_BASE_URL}/api/v1/model`);

  ipcMain.handle('tro:auth-command', async (event, rawCommand: unknown): Promise<AuthResult> => {
    if (!isTrustedSender(event)) {
      return { kind: 'failed', message: 'This window cannot access sign-in.' };
    }
    const parsed = AuthCommandSchema.safeParse(rawCommand);
    if (!parsed.success || !chat) {
      return { kind: 'failed', message: 'The sign-in request is invalid.' };
    }
    switch (parsed.data.kind) {
      case 'status':
        return chat.readAuthSession();
      case 'sign-in-google':
        return chat.signInWithGoogle();
      case 'sign-out':
        return chat.signOut();
    }
  });

  function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
    return Boolean(
      mainWindow &&
      event.sender === mainWindow.webContents &&
      event.senderFrame === mainWindow.webContents.mainFrame &&
      isTrustedFrameUrl(event.senderFrame.url, documentUrl),
    );
  }

  ipcMain.handle('tro:agent-command', async (event, rawCommand: unknown): Promise<AgentResult> => {
    if (!isTrustedSender(event) || !chat) {
      return { kind: 'failed', message: 'This window cannot control an agent session.' };
    }

    const parsed = AgentCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      return { kind: 'failed', message: 'The agent request is invalid.' };
    }

    switch (parsed.data.kind) {
      case 'start': {
        return chat.startTaskSession();
      }
      case 'turn':
        return chat.sendMessage(parsed.data.sessionId, parsed.data.message);
      case 'stop':
        return chat.stopSession(parsed.data.sessionId);
    }
  });

  async function openWindow(): Promise<void> {
    const window = new BrowserWindow({
      width: 1360,
      height: 860,
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
      chat?.dispose();
      mainWindow = undefined;
    });

    if (developmentUrl) {
      await window.loadURL(developmentUrl);
    } else {
      await window.loadFile(rendererFile);
    }
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

app.on('before-quit', () => {
  chat?.dispose();
});

void startDesktop().catch((error: unknown) => {
  /* Development diagnostics stay local; packaged builds avoid leaking paths. */
  console.error(app.isPackaged ? 'Tro could not start. Check desktop configuration.' : error);
  app.quit();
});
