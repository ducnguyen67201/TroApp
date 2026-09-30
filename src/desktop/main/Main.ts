import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SystemStatusResult } from '#contracts/SystemStatus.js';
import { fetchServiceStatus } from './BackendClient.js';
import { readDesktopEnv } from './Env.js';
import { isTrustedFrameUrl } from './TrustedFrame.js';

const mainDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;

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

  ipcMain.handle('tro:read-service-status', async (event): Promise<SystemStatusResult> => {
    /* A window can navigate after creation. Check its sender, main frame, and
       current URL on every call before allowing a backend request. */
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame ||
      !isTrustedFrameUrl(event.senderFrame.url, documentUrl)
    ) {
      return { success: false, message: 'This window cannot request service status.' };
    }

    try {
      return { success: true, status: await fetchServiceStatus(environment.API_BASE_URL) };
    } catch {
      return { success: false, message: 'Could not connect. Check that the backend is running.' };
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

void startDesktop().catch(() => {
  console.error('Tro could not start. Check desktop configuration.');
  app.quit();
});
