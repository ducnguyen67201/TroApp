import { VoiceMeterSchema } from '#contracts/CompanionHud.js';
import { DesktopCompanion } from './companion/DesktopCompanion.js';
import { CompanionHudClient } from './companion/CompanionHudClient.js';
import { app, BrowserWindow, ipcMain, powerMonitor, systemPreferences } from 'electron';
import {
  VoiceCommandSchema,
  VoiceAudioFrameSchema,
  VoiceShortcut,
  VoiceState,
  type VoiceReply,
} from '#contracts/VoiceInput.js';
import { VoiceInputController } from './voice/VoiceInputController.js';
import { GlobalVoiceShortcut } from './voice/GlobalVoiceShortcut.js';
import { openTranscriptionConnection } from './voice/TranscriptionClient.js';
import { sendVoiceEventToWindow } from './voice/VoiceEventDelivery.js';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppEnvironment } from '#contracts/AppEnvironment.js';
import { AgentCommandSchema, type AgentResult } from '#contracts/AgentSession.js';
import { AuthCommandSchema, type AuthResult } from '#contracts/AuthSession.js';
import {
  PermissionCommandSchema,
  type DesktopPermissionStatus,
  type PermissionActionResult,
} from '#contracts/DesktopPermissions.js';
import { readDesktopEnv } from './Env.js';
import { AgentWorkerClient } from './AgentWorkerClient.js';
import { AgentChatController } from './AgentChatController.js';
import { AuthClient } from './AuthClient.js';
import { DesktopPermissions } from './DesktopPermissions.js';
import { EmbeddedDesktopDriver } from './EmbeddedDesktopDriver.js';
import { isTrustedFrameUrl } from './TrustedFrame.js';

const mainDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let chat: AgentChatController | undefined;
let voice: VoiceInputController | undefined;
let desktopCompanion: DesktopCompanion | undefined;
const voiceShortcut = new GlobalVoiceShortcut();
let voiceEnableGeneration = 0;
let voiceKeysReleased = true;
const permissions = new DesktopPermissions();
const desktopDriver = new EmbeddedDesktopDriver();
let isQuitting = false;

async function startDesktop(): Promise<void> {
  /* Vite embeds this public URL when packaging the desktop app. The validator
     supplies the local development default and rejects unsafe values. */
  const environment = readDesktopEnv({
    environment: process.env,
    bundledApiUrl: import.meta.env['MAIN_VITE_API_BASE_URL'],
    bundledAppEnvironment: import.meta.env['MAIN_VITE_APP_ENV'],
    isPackaged: app.isPackaged,
  });
  const hudClient = new CompanionHudClient(
    join(mainDirectory, 'StartCompanionHudWorker.js'),
    desktopDriver,
  );
  const agentWorker = new AgentWorkerClient(
    join(mainDirectory, 'StartAgentWorker.js'),
    environment.APP_ENV === AppEnvironment.DEV,
    desktopDriver,
    process.platform === 'darwin' ? hudClient.group : undefined,
    (progress) => {
      desktopCompanion?.hud.receiveProgress(progress);
    },
  );
  const rendererFile = join(mainDirectory, '../renderer/index.html');
  const developmentUrl = app.isPackaged ? undefined : environment.RENDERER_URL;
  const documentUrl = developmentUrl ?? pathToFileURL(rendererFile).href;

  const auth = new AuthClient(environment.API_BASE_URL, app.getPath('userData'));
  /* The OAuth protocol must be registered before Electron becomes ready. */
  auth.registerDeepLink(() => mainWindow);
  await app.whenReady();
  chat = new AgentChatController(
    auth,
    agentWorker,
    `${environment.API_BASE_URL}/api/v1/model`,
    permissions,
  );

  const companionChat = chat;
  const companion = new DesktopCompanion(
    { startFollowing: () => companionChat.startCursorCompanion() },
    {
      canShow: async () =>
        process.platform === 'darwin' &&
        (await auth.readSession()).kind === 'signed-in' &&
        (await permissions.readStatus()).kind === 'ready',
    },
    hudClient,
    {
      now: () => performance.now(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    },
  );
  desktopCompanion = companion;

  const voiceChat = chat;
  voice = new VoiceInputController(
    {
      readSession: () => auth.readSession(),
      releaseUnusedCredential: (captureId) => auth.releaseUnusedTranscription(captureId),
      fetchCredential: (captureId, locale) => auth.fetchTranscriptionCredential(captureId, locale),
      connect: (token, emit) => {
        const cookie = auth.readCookie();
        if (!cookie) {
          throw new Error('Sign in to use voice.');
        }
        return openTranscriptionConnection(environment.API_BASE_URL, token, cookie, emit);
      },
      isAgentBusy: () => voiceChat.isBusy(),
      areTriggerKeysReleased: () => voiceKeysReleased,
      startAgentSession: () => voiceChat.startTaskSession(),
      sendAgentMessage: (sessionId, message, locale, mode) =>
        voiceChat.sendMessage(sessionId, message, locale, mode),
      emit: (event) => {
        companion.hud.receiveVoiceEvent(event);
        sendVoiceEventToWindow(mainWindow, event);
      },
    },
    process.platform === 'darwin' ? VoiceShortcut.COMMAND_CONTROL : VoiceShortcut.CONTROL_ALT,
  );

  function disableVoice(): void {
    voiceKeysReleased = true;
    voiceEnableGeneration += 1;
    voiceShortcut.disableShortcut();
    voice?.invalidateVoiceInput();
    companion.dispose();
  }

  powerMonitor.on('suspend', () => {
    voiceShortcut.reset();
    voice?.cancelVoiceCapture();
    companion.reset();
  });
  powerMonitor.on('lock-screen', () => {
    voiceShortcut.reset();
    voice?.cancelVoiceCapture();
    companion.reset();
  });

  ipcMain.handle('tro:voice-command', async (event, rawCommand: unknown): Promise<VoiceReply> => {
    if (!isTrustedSender(event) || !voice) {
      return { kind: 'failed' };
    }
    const parsed = VoiceCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      return { kind: 'failed' };
    }
    const controller = voice;
    switch (parsed.data.kind) {
      case 'status':
        return { kind: 'ok', status: controller.readStatus() };
      case 'disable':
        disableVoice();
        return { kind: 'ok', status: controller.readStatus() };
      case 'press':
        return controller.startVoiceCapture();
      case 'release':
        return controller.releaseVoiceCapture();
      case 'cancel':
        return controller.cancelVoiceCapture();
      case 'prepare':
        companion.hud.setCaptureLocale(parsed.data.captureId, parsed.data.locale);
        return controller.prepareVoiceCapture(
          parsed.data.captureId,
          parsed.data.locale,
          parsed.data.mode,
        );
      case 'finish':
        return controller.finishVoiceAudio(parsed.data.captureId, parsed.data.lastSequence);
      case 'enable': {
        disableVoice();
        const generation = voiceEnableGeneration;
        const session = await auth.readSession();
        if (generation !== voiceEnableGeneration || session.kind !== 'signed-in') {
          return { kind: 'failed' };
        }
        if (
          process.platform === 'darwin' &&
          !(await systemPreferences.askForMediaAccess('microphone'))
        ) {
          return { kind: 'failed' };
        }
        if (generation !== voiceEnableGeneration) {
          return { kind: 'failed' };
        }
        void companion.startPresentation();
        let globalAvailable = false;
        try {
          if (
            process.platform === 'darwin' &&
            !systemPreferences.isTrustedAccessibilityClient(true)
          ) {
            throw new Error('Shortcut permission is unavailable.');
          }
          await voiceShortcut.enableShortcut(
            parsed.data.shortcut,
            () => {
              voiceKeysReleased = false;
              controller.startVoiceCapture();
            },
            () => {
              controller.releaseVoiceCapture();
            },
            () => {
              controller.cancelVoiceCapture();
            },
            () => {
              voiceKeysReleased = true;
              controller.notifyKeysReleased();
            },
          );
          globalAvailable = true;
        } catch {
          // Hold button remains available when Tro lacks native hook permission.
        }
        if (generation !== voiceEnableGeneration) {
          voiceShortcut.disableShortcut();
          return { kind: 'failed' };
        }
        return controller.enableVoiceInput(parsed.data.shortcut, globalAvailable);
      }
    }
  });

  ipcMain.on('tro:voice-meter', (event, rawMeter: unknown) => {
    if (!isTrustedSender(event) || !voice?.isCapturing()) {
      return;
    }
    const parsed = VoiceMeterSchema.safeParse(rawMeter);
    if (parsed.success) {
      companion.hud.updateMeter(parsed.data);
    }
  });

  ipcMain.handle('tro:voice-audio', (event, rawFrame: unknown): VoiceReply => {
    if (!isTrustedSender(event) || !voice) {
      return { kind: 'failed' };
    }
    const parsed = VoiceAudioFrameSchema.safeParse(rawFrame);
    return parsed.success ? voice.appendVoiceAudio(parsed.data) : { kind: 'failed' };
  });

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
        disableVoice();
        return chat.signInWithGoogle();
      case 'sign-out':
        disableVoice();
        return chat.signOut();
    }
  });

  function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    return Boolean(
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.webContents.isDestroyed() &&
      event.sender === mainWindow.webContents &&
      event.senderFrame === mainWindow.webContents.mainFrame &&
      isTrustedFrameUrl(event.senderFrame.url, documentUrl),
    );
  }

  ipcMain.handle(
    'tro:permission-command',
    async (
      event,
      rawCommand: unknown,
    ): Promise<DesktopPermissionStatus | PermissionActionResult> => {
      if (!isTrustedSender(event)) {
        return { kind: 'failed', message: 'This window cannot manage desktop permissions.' };
      }
      const parsed = PermissionCommandSchema.safeParse(rawCommand);
      if (!parsed.success) {
        return { kind: 'failed', message: 'The permission request is invalid.' };
      }
      switch (parsed.data.kind) {
        case 'status':
          return permissions.readStatus();
        case 'request':
          return permissions.requestPermissions();
        case 'open-settings':
          return permissions.openSettings(parsed.data.area);
      }
    },
  );

  ipcMain.handle('tro:agent-command', async (event, rawCommand: unknown): Promise<AgentResult> => {
    if (!isTrustedSender(event) || !chat) {
      return { kind: 'failed', message: 'This window cannot control an agent session.' };
    }

    const parsed = AgentCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      return { kind: 'failed', message: 'The agent request is invalid.' };
    }

    switch (parsed.data.kind) {
      case 'follow': {
        if (process.platform !== 'darwin') {
          return { kind: 'stopped' };
        }
        return companion.startFollowing();
      }
      case 'start': {
        return chat.startTaskSession();
      }
      case 'turn': {
        if (
          voice &&
          ![VoiceState.IDLE, VoiceState.DISABLED].some(
            (state) => state === voice?.readStatus().state,
          )
        ) {
          return { kind: 'failed', message: 'Wait for the current task to finish.' };
        }
        companion.hud.startTask(parsed.data.sessionId, parsed.data.locale);
        const result = await chat.sendMessage(
          parsed.data.sessionId,
          parsed.data.message,
          parsed.data.locale,
          parsed.data.mode,
        );
        companion.hud.finishTask(result, parsed.data.sessionId);
        return result;
      }
      case 'stop':
        voice?.cancelVoiceCapture();
        companion.reset();
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
        backgroundThrottling: false,
      },
    });
    mainWindow = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isTrustedFrameUrl(targetUrl, documentUrl)) {
        event.preventDefault();
      }
    });
    const canUseMicrophone = (
      contents: Electron.WebContents | null,
      permission: string,
      url: string,
    ): boolean =>
      Boolean(
        contents === window.webContents &&
        permission === 'media' &&
        isTrustedFrameUrl(url, documentUrl) &&
        voice?.isCapturing(),
      );
    window.webContents.session.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        canUseMicrophone(contents, permission, details.requestingUrl ?? '') &&
        details.isMainFrame &&
        details.mediaType === 'audio',
    );
    window.webContents.session.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(
          canUseMicrophone(contents, permission, details.requestingUrl) &&
            details.isMainFrame &&
            'mediaTypes' in details &&
            details.mediaTypes.length === 1 &&
            details.mediaTypes[0] === 'audio',
        );
      },
    );
    window.on('closed', () => {
      mainWindow = undefined;
      disableVoice();
      chat?.dispose();
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

app.on('before-quit', (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault();
  isQuitting = true;
  voiceEnableGeneration += 1;
  voiceShortcut.disableShortcut();
  voice?.invalidateVoiceInput();
  desktopCompanion?.dispose();
  chat?.dispose();
  void desktopDriver
    .stop()
    .catch(() => {})
    .finally(() => {
      app.quit();
    });
});

void startDesktop().catch((error: unknown) => {
  /* Development diagnostics stay local; packaged builds avoid leaking paths. */
  console.error(app.isPackaged ? 'Tro could not start. Check desktop configuration.' : error);
  app.quit();
});
