import { GlobalStudentInput } from './input/GlobalStudentInput.js';
import {
  MicrophoneTestCommandSchema,
  type MicrophoneTestReply,
} from '#contracts/MicrophoneTest.js';
import { MicrophoneTestLease } from './voice/MicrophoneTestLease.js';
import { isMicrophonePermissionAllowed } from './voice/MicrophonePermission.js';
import { VoiceMeterSchema } from '#contracts/CompanionHud.js';
import { DesktopCompanion } from './companion/DesktopCompanion.js';
import { CompanionHudClient } from './companion/CompanionHudClient.js';
import {
  app,
  globalShortcut,
  BrowserWindow,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  systemPreferences,
} from 'electron';
import troIconPath from '../assets/TroIcon.png?asset';
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
import type { AgentResult } from '#contracts/AgentSession.js';
import { executeAgentCommand } from './ExecuteAgentCommand.js';
import { AuthCommandSchema, type AuthResult } from '#contracts/AuthSession.js';
import {
  PermissionCommandSchema,
  type DesktopPermissionStatus,
  type PermissionActionResult,
} from '#contracts/DesktopPermissions.js';
import { readDesktopEnv } from './Env.js';
import { AgentWorkerClient } from './AgentWorkerClient.js';
import { AgentChatController } from './AgentChatController.js';
import { GlobalTaskCancelShortcut } from './GlobalTaskCancelShortcut.js';
import { AuthClient } from './AuthClient.js';
import { DesktopPermissions } from './DesktopPermissions.js';
import { EmbeddedDesktopDriver } from './EmbeddedDesktopDriver.js';
import { isTrustedFrameUrl } from './TrustedFrame.js';
import { DesktopWindowAppearance } from '../DesktopAppearance.js';
import { AppUpdateState, AppUpdatePhase, type AppUpdateReply } from '#contracts/AppUpdate.js';
import { AppUpdateController } from './updates/AppUpdateController.js';
import { runAppUpdateCommand } from './updates/AppUpdateCommand.js';

const mainDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let chat: AgentChatController | undefined;
let voice: VoiceInputController | undefined;
let microphoneTests: MicrophoneTestLease | undefined;
let desktopCompanion: DesktopCompanion | undefined;
const voiceShortcut = new GlobalVoiceShortcut();
let voiceEnableGeneration = 0;
let voiceKeysReleased = true;
const permissions = new DesktopPermissions();
const desktopDriver = new EmbeddedDesktopDriver();
let isQuitting = false;
let updates: AppUpdateController | undefined;
let updateCheckTimer: ReturnType<typeof setInterval> | undefined;

async function startDesktop(): Promise<void> {
  /* Vite embeds this public URL when packaging the desktop app. The validator
     supplies the local development default and rejects unsafe values. */
  const environment = readDesktopEnv({
    environment: process.env,
    bundledApiUrl: import.meta.env['MAIN_VITE_API_BASE_URL'],
    bundledAppEnvironment: import.meta.env['MAIN_VITE_APP_ENV'],
    bundledUpdateUrl: import.meta.env['MAIN_VITE_UPDATE_FEED_URL'] || undefined,
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
      chat?.receiveProgress(progress);
      voice?.setLessonAnswerAllowed(!chat?.isBusy());
      desktopCompanion?.hud.receiveProgress(progress);
      mainWindow?.webContents.send('tro:agent-progress', progress);
    },
    new GlobalStudentInput(() => screen.getPrimaryDisplay().bounds),
  );
  const rendererFile = join(mainDirectory, '../renderer/index.html');
  const developmentUrl = app.isPackaged ? undefined : environment.RENDERER_URL;
  const documentUrl = developmentUrl ?? pathToFileURL(rendererFile).href;

  const auth = new AuthClient(environment.API_BASE_URL, app.getPath('userData'));
  /* The OAuth protocol must be registered before Electron becomes ready. */
  auth.registerDeepLink(() => mainWindow);
  await app.whenReady();
  const applicationIcon = nativeImage.createFromPath(troIconPath);
  if (applicationIcon.isEmpty()) {
    throw new Error('Tro application icon is missing.');
  }
  app.dock?.setIcon(applicationIcon);
  const canUseUpdates =
    app.isPackaged &&
    Boolean(environment.UPDATE_FEED_URL) &&
    (process.platform === 'darwin' || process.platform === 'win32');
  const updater = canUseUpdates
    ? (await import('./updates/ElectronAppUpdater.js')).createElectronAppUpdater()
    : null;
  updates = new AppUpdateController({
    updater,
    emit: (snapshot) => {
      if (
        snapshot.status.state === AppUpdateState.ERROR &&
        snapshot.status.phase === AppUpdatePhase.INSTALL
      ) {
        isQuitting = false;
      }
      if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isDestroyed() &&
        isTrustedFrameUrl(mainWindow.webContents.getURL(), documentUrl)
      ) {
        mainWindow.webContents.send('tro:update-event', snapshot);
      }
    },
    canRestart: () =>
      !isQuitting &&
      !chat?.isBusy() &&
      !microphoneTests?.isActive() &&
      (!voice ||
        voice.readStatus().state === VoiceState.IDLE ||
        voice.readStatus().state === VoiceState.DISABLED),
    requestRestart: () => {
      setImmediate(() => {
        app.quit();
      });
    },
  });
  const updateController = updates;
  ipcMain.handle('tro:update-command', (event, rawCommand: unknown): Promise<AppUpdateReply> =>
    runAppUpdateCommand(updateController, rawCommand, isTrustedSender(event)),
  );
  chat = new AgentChatController(
    auth,
    agentWorker,
    `${environment.API_BASE_URL}/api/v1/model`,
    permissions,
    new GlobalTaskCancelShortcut(globalShortcut),
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
      isAgentBusy: () => voiceChat.isBusy() || Boolean(microphoneTests?.isActive()),
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

  microphoneTests = new MicrophoneTestLease({
    canStart: () =>
      !voiceChat.isBusy() &&
      Boolean(
        voice &&
        (voice.readStatus().state === VoiceState.IDLE ||
          voice.readStatus().state === VoiceState.DISABLED),
      ),
    requestAccess: async () =>
      (await auth.readSession()).kind === 'signed-in' &&
      (process.platform !== 'darwin' || (await systemPreferences.askForMediaAccess('microphone'))),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => {
        clearTimeout(timer);
      };
    },
    emit: (event) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('tro:microphone-test-event', event);
      }
    },
  });

  ipcMain.handle(
    'tro:microphone-test',
    async (event, rawCommand: unknown): Promise<MicrophoneTestReply> => {
      const parsed = MicrophoneTestCommandSchema.safeParse(rawCommand);
      if (!isTrustedSender(event) || !parsed.success || !microphoneTests) {
        return { kind: 'failed' };
      }
      return parsed.data.kind === 'start'
        ? microphoneTests.startTest(parsed.data.testId)
        : microphoneTests.stopTest(parsed.data.testId);
    },
  );

  function disableVoice(): void {
    microphoneTests?.cancelTest();
    voiceKeysReleased = true;
    voiceEnableGeneration += 1;
    voiceShortcut.disableShortcut();
    voice?.invalidateVoiceInput();
    companion.dispose();
  }

  powerMonitor.on('suspend', () => {
    microphoneTests?.cancelTest();
    voiceShortcut.reset();
    voice?.cancelVoiceCapture();
    companion.reset();
  });
  powerMonitor.on('lock-screen', () => {
    microphoneTests?.cancelTest();
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
        if (microphoneTests?.isActive()) {
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
      !isQuitting &&
      updates?.readStatus().status.state !== AppUpdateState.RESTARTING &&
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

    return executeAgentCommand(rawCommand, {
      chat,
      startFollowing: () =>
        process.platform === 'darwin'
          ? companion.startFollowing()
          : Promise.resolve({ kind: 'stopped' }),
      canSendMessage: () =>
        !voice ||
        [VoiceState.IDLE, VoiceState.DISABLED].some((state) => state === voice?.readStatus().state),
      startTask: (sessionId, locale) => {
        companion.hud.startTask(sessionId, locale);
      },
      finishTask: (result, sessionId) => {
        companion.hud.finishTask(result, sessionId);
      },
      cancelPresentation: () => {
        voice?.cancelVoiceCapture();
        companion.reset();
      },
    });
  });

  async function openWindow(): Promise<void> {
    const window = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 680,
      minHeight: 520,
      title: 'Tro',
      icon: applicationIcon,
      backgroundColor: DesktopWindowAppearance.BACKGROUND,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 20, y: 20 },
      titleBarOverlay: {
        color: DesktopWindowAppearance.BACKGROUND,
        symbolColor: DesktopWindowAppearance.FOREGROUND,
        height: DesktopWindowAppearance.TITLE_BAR_HEIGHT,
      },
      webPreferences: {
        preload: join(mainDirectory, '../preload/Preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    mainWindow = window;
    window.webContents.on('render-process-gone', () => {
      disableVoice();
    });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        microphoneTests?.cancelTest();
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (!isTrustedFrameUrl(targetUrl, documentUrl)) {
        event.preventDefault();
      }
    });
    const isTrustedMicrophoneFrame = (
      contents: Electron.WebContents | null,
      url: string,
    ): boolean => contents === window.webContents && isTrustedFrameUrl(url, documentUrl);

    /* Enumeration requires audio permission while voice is enabled. Chromium can
       reuse that permission for streams; the trusted renderer owns held-key capture.
       New requests require an active voice capture or authorized local test lease. */
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
      isMicrophonePermissionAllowed({
        permission,
        isTrustedFrame: isTrustedMicrophoneFrame(contents, details.requestingUrl ?? ''),
        isMainFrame: details.isMainFrame,
        mediaTypes: [details.mediaType ?? 'unknown'],
        isAudioAuthorized: Boolean(
          (voice && voice.readStatus().state !== VoiceState.DISABLED) ||
          microphoneTests?.isAuthorized(),
        ),
      }),
    );
    window.webContents.session.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(
          isMicrophonePermissionAllowed({
            permission,
            isTrustedFrame: isTrustedMicrophoneFrame(contents, details.requestingUrl),
            isMainFrame: details.isMainFrame,
            mediaTypes: 'mediaTypes' in details ? details.mediaTypes : [],
            isAudioAuthorized: Boolean(voice?.isCapturing() || microphoneTests?.isAuthorized()),
          }),
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
  if (canUseUpdates) {
    void updateController.checkForUpdates();
    updateCheckTimer = setInterval(
      () => {
        void updateController.checkForUpdates();
      },
      4 * 60 * 60 * 1000,
    );
    updateCheckTimer.unref();
  }
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
  microphoneTests?.cancelTest();
  voiceEnableGeneration += 1;
  voiceShortcut.disableShortcut();
  voice?.invalidateVoiceInput();
  desktopCompanion?.dispose();
  chat?.dispose();
  void desktopDriver
    .stop()
    .catch(() => {})
    .finally(() => {
      if (updates?.readStatus().status.state === AppUpdateState.RESTARTING) {
        updates.installAfterShutdown();
      } else {
        app.quit();
      }
    });
});

app.on('will-quit', () => {
  clearInterval(updateCheckTimer);
  updates?.dispose();
});

void startDesktop().catch((error: unknown) => {
  /* Development diagnostics stay local; packaged builds avoid leaking paths. */
  console.error(app.isPackaged ? 'Tro could not start. Check desktop configuration.' : error);
  app.quit();
});
