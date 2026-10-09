import { PetController } from './pets/PetController.js';
import { PetWindow } from './pets/PetWindow.js';
import { PetPreferences } from './pets/PetPreferences.js';
import {
  PetCommandSchema,
  PetOverlayCommandSchema,
  PetOverlayAction,
  PetFailure,
  PetReaction,
  type PetReply,
} from '#contracts/Pet.js';
import { randomUUID } from 'node:crypto';
import { GlobalPracticeShortcut } from './GlobalPracticeShortcut.js';
import { PracticeShortcutEventSchema } from '#contracts/PracticeShortcut.js';
import {
  PracticeCommandSchema,
  PracticeFailure,
  type PracticeReply,
} from '#contracts/PracticeCheck.js';
import { PracticeCheckApiClient } from './classroom/PracticeCheckApiClient.js';
import { ClassroomInsightApiClient } from './classroom/ClassroomInsightApiClient.js';
import { ClassroomInsightController } from './classroom/ClassroomInsightController.js';
import { ParentReportExportController } from './classroom/ParentReportExportController.js';
import { AtomicReportFile } from './classroom/AtomicReportFile.js';
import {
  AccountCommandKind,
  AccountCommandSchema,
  type AccountReply,
} from '#contracts/DesktopAccounts.js';
import { AccountTransitionGate } from './accounts/AccountTransitionGate.js';
import { MaterialCommandSchema } from '#contracts/ClassroomMaterials.js';
import { MaterialApiClient } from './classroom/MaterialApiClient.js';
import { MaterialPreviewController } from './classroom/MaterialPreviewController.js';
import { writeFile } from 'node:fs/promises';
import { dialog } from 'electron';
import { VoiceoverController } from './voiceover/VoiceoverController.js';
import {
  VoiceoverAckSchema,
  VoiceoverPreferenceSchema,
  VoiceoverLimits,
  VoiceoverState,
  type VoiceoverPlayback,
} from '#contracts/Voiceover.js';
import { GlobalStudentInput } from './input/GlobalStudentInput.js';
import {
  ClassroomCommandSchema,
  ClassroomFailure,
  type ClassroomReply,
} from '#contracts/Classroom.js';
import { ClassroomApiClient } from './classroom/ClassroomApiClient.js';
import { ClassroomSessionController } from './classroom/ClassroomSessionController.js';
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

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const mainDirectory = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let pets: PetController | undefined;
let petWindow: PetWindow | undefined;
let chat: AgentChatController | undefined;
let classroom: ClassroomSessionController | undefined;
let classroomInsights: ClassroomInsightController | undefined;
let parentReportExports: ParentReportExportController | undefined;
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
    (message) => {
      chat?.receivePresentedMessage(message);
    },
  );
  const agentWorker = new AgentWorkerClient(
    join(mainDirectory, 'StartAgentWorker.js'),
    environment.APP_ENV === AppEnvironment.DEV,
    desktopDriver,
    process.platform === 'darwin' ? hudClient.group : undefined,
    (progress) => {
      chat?.receiveProgress(progress);
      if (progress.presentationPending || progress.presentationRevoked) {
        return;
      }
      voice?.setLessonAnswerAllowed(!chat?.isBusy());
      desktopCompanion?.hud.receiveProgress(progress);
      mainWindow?.webContents.send('tro:agent-progress', progress);
      setImmediate(() => {
        refreshPetSuppression();
      });
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
  let petAccessGeneration = 0;
  const petRendererFile = join(mainDirectory, '../renderer/Pet.html');
  const petDevelopmentUrl = developmentUrl ? new URL('Pet.html', developmentUrl).href : undefined;
  const overlay = new PetWindow({
    preloadFile: join(mainDirectory, '../preload/Preload.cjs'),
    rendererFile: petRendererFile,
    developmentUrl: petDevelopmentUrl,
    documentUrl: petDevelopmentUrl ?? pathToFileURL(petRendererFile).href,
    savePlacement: (placement) => {
      void pets?.savePlacement(placement).then((reply) => {
        if (reply.kind === 'failed') {
          console.warn('pet.preferences.failed', { stage: 'placement' });
        }
      });
    },
    reportFailure: () => {
      pets?.markPresentationFailed();
    },
  });
  petWindow = overlay;
  const petController = new PetController(
    new PetPreferences(join(app.getPath('userData'), 'pets')),
    overlay,
    {
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => {
          clearTimeout(timer);
        };
      },
    },
    (snapshot) => {
      if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        isTrustedFrameUrl(mainWindow.webContents.getURL(), documentUrl)
      ) {
        mainWindow.webContents.send('tro:pet-snapshot', snapshot);
      }
    },
  );
  pets = petController;

  async function canUsePets(event: Electron.IpcMainInvokeEvent): Promise<boolean> {
    if (!isTrustedSender(event)) {
      return false;
    }
    const generation = petAccessGeneration;
    const session = await auth.readSession();
    if (
      !isTrustedSender(event) ||
      generation !== petAccessGeneration ||
      session.kind !== 'signed-in'
    ) {
      return false;
    }
    await petController.setAccount(session.user.id);
    return isTrustedSender(event) && generation === petAccessGeneration;
  }

  ipcMain.handle('tro:pet-read', async (event): Promise<PetReply> => {
    return (await canUsePets(event))
      ? { kind: 'ok', snapshot: petController.readSnapshot() }
      : { kind: 'failed', reason: PetFailure.UNAVAILABLE };
  });
  ipcMain.handle('tro:pet-command', async (event, raw: unknown): Promise<PetReply> => {
    const parsed = PetCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'failed', reason: PetFailure.INVALID };
    }
    if (!(await canUsePets(event))) {
      return { kind: 'failed', reason: PetFailure.UNAVAILABLE };
    }
    return petController.executeCommand(parsed.data);
  });
  ipcMain.handle('tro:pet-overlay-read', (event) => {
    if (!overlay.isTrustedSender(event)) {
      throw new Error('Pet presentation is unavailable.');
    }
    return petController.readSnapshot();
  });
  ipcMain.on('tro:pet-overlay-command', (event, raw: unknown) => {
    const parsed = PetOverlayCommandSchema.safeParse(raw);
    if (isQuitting || !overlay.isTrustedSender(event) || !parsed.success) {
      return;
    }
    if (parsed.data.kind === PetOverlayAction.PET || parsed.data.kind === PetOverlayAction.SLAP) {
      if (overlay.canReact()) {
        petController.reactToPet(
          parsed.data.kind === PetOverlayAction.PET ? PetReaction.HAPPY : PetReaction.STARTLED,
        );
      }
    } else {
      overlay.receiveInteraction(parsed.data);
    }
  });

  function refreshPetSuppression(): void {
    const state = voice?.readStatus().state;
    petController.setSuspended(
      Boolean(chat?.isBusy()) ||
        state === VoiceState.PREPARING ||
        state === VoiceState.RECORDING ||
        state === VoiceState.FINALIZING,
    );
  }

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
  let isStartingMicrophone = false;
  const cancelShortcut = new GlobalTaskCancelShortcut(globalShortcut);
  const cancelVoiceover = (): void => {
    voiceEnableGeneration += 1;
    voiceKeysReleased = true;
    voiceShortcut.reset();
    narration.clearTask();
    desktopCompanion?.reset();
    voice?.cancelVoiceCapture();
    microphoneTests?.cancelTest();
  };
  const playbackReplies = new Map<string, (accepted: boolean) => void>();

  function sendPlayback(command: VoiceoverPlayback): Promise<boolean> {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !isTrustedFrameUrl(window.webContents.getURL(), documentUrl)
    ) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const key = `${command.utteranceId}:${String(command.sequence)}`;
      playbackReplies.get(key)?.(false);
      const timeoutMs =
        command.kind === 'stop'
          ? VoiceoverLimits.STOP_TIMEOUT_MS
          : command.kind === 'start'
            ? VoiceoverLimits.START_TIMEOUT_MS
            : VoiceoverLimits.MAX_DURATION_MS;
      const timer = setTimeout(() => {
        finish(false);
      }, timeoutMs);
      const finish = (accepted: boolean): void => {
        clearTimeout(timer);
        playbackReplies.delete(key);
        resolve(accepted);
      };
      playbackReplies.set(key, finish);
      window.webContents.send('tro:voiceover', command);
    });
  }

  const narration = new VoiceoverController({
    canSpeak: () => {
      const state = voice?.readStatus().state;
      return (
        !isStartingMicrophone &&
        !microphoneTests?.isActive() &&
        state !== VoiceState.PREPARING &&
        state !== VoiceState.RECORDING &&
        state !== VoiceState.FINALIZING
      );
    },
    async fetchSpeech(request, signal) {
      const cookie = auth.readCookie();
      if (!cookie) {
        throw new Error('Sign in required.');
      }
      const response = await fetch(`${environment.API_BASE_URL}/api/v1/voiceover/stream`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      if (
        !response.ok ||
        !response.body ||
        response.headers.get('x-tro-audio-format') !== 'pcm_s16le_24000_mono'
      ) {
        await response.body?.cancel();
        throw new Error('Speech is unavailable.');
      }
      return response.body;
    },
    sendPlayback,
    showStatus: (status) => {
      cancelShortcut.setVoiceoverCancel(
        status.state === VoiceoverState.PREPARING || status.state === VoiceoverState.SPEAKING
          ? cancelVoiceover
          : null,
      );
      mainWindow?.webContents.send('tro:voiceover', status);
    },
    holdMessage: (message) => {
      desktopCompanion?.hud.setSpeakingMessage(message);
    },
    reportFailure: (stage) => {
      console.warn('voiceover.failed', { stage });
    },
    reportEvent: (event) => {
      console.debug(`voiceover.${event.kind}`, event);
    },
  });
  ipcMain.handle('tro:voiceover-ack', (event, raw: unknown) => {
    const parsed = VoiceoverAckSchema.safeParse(raw);
    if (!isTrustedSender(event) || !parsed.success) {
      return;
    }
    playbackReplies.get(`${parsed.data.utteranceId}:${String(parsed.data.sequence)}`)?.(
      parsed.data.accepted,
    );
  });
  ipcMain.handle('tro:voiceover-preference', (event, raw: unknown) => {
    const parsed = VoiceoverPreferenceSchema.safeParse(raw);
    if (isTrustedSender(event) && parsed.success) {
      narration.setLocale(parsed.data.locale);
      narration.setEnabled(parsed.data.enabled);
    }
  });
  ipcMain.handle('tro:stop-speaking', (event) =>
    isTrustedSender(event) ? narration.stopSpeaking() : false,
  );
  ipcMain.handle('tro:cancel-guidance', (event) => {
    if (isTrustedSender(event)) {
      cancelShortcut.cancelGuidance();
    }
  });

  async function startCapture(requireHeldKeys = false): Promise<VoiceReply> {
    if (isStartingMicrophone) {
      return { kind: 'failed' };
    }
    isStartingMicrophone = true;
    const generation = voiceEnableGeneration;
    try {
      const stopped = await narration.stopSpeaking();
      if (
        !stopped ||
        generation !== voiceEnableGeneration ||
        (requireHeldKeys && voiceKeysReleased)
      ) {
        return { kind: 'failed' };
      }
      return voice?.startVoiceCapture() ?? { kind: 'failed' };
    } finally {
      isStartingMicrophone = false;
    }
  }

  const accountGate = new AccountTransitionGate(
    () => auth.isAddingAccount(),
    () =>
      Boolean(
        chat?.isBusy() ||
        isStartingMicrophone ||
        microphoneTests?.isActive() ||
        (voice &&
          voice.readStatus().state !== VoiceState.IDLE &&
          voice.readStatus().state !== VoiceState.DISABLED),
      ),
  );

  const practiceShortcut = new GlobalPracticeShortcut(globalShortcut);
  const classroomController: ClassroomSessionController = new ClassroomSessionController(
    new ClassroomApiClient(environment.API_BASE_URL, () => auth.readCookie()),
    () => {
      chat?.cancelClassroomTask();
      desktopCompanion?.reset();
    },
    (context) => {
      if (!context) {
        practiceShortcut.disable();
        return;
      }
      if (practiceShortcut.isAvailable()) {
        return;
      }
      practiceShortcut.enable(() => {
        const current = classroomController.readPracticeContext();
        const window = mainWindow;
        if (
          !current ||
          accountGate.isChanging() ||
          auth.isAddingAccount() ||
          !window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed() ||
          !isTrustedFrameUrl(window.webContents.getURL(), documentUrl)
        ) {
          return;
        }
        const intent = PracticeShortcutEventSchema.parse({
          requestId: randomUUID(),
          classId: current.meeting.classId,
          participationId: current.participation.id,
          activityId: current.activity.id,
          attemptId: current.attempt.id,
          contextVersion: current.meeting.contextVersion,
        });
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
        window.webContents.send('tro:practice-shortcut', intent);
      });
    },
  );
  ipcMain.handle(
    'tro:practice-shortcut-available',
    (event) => isTrustedSender(event) && practiceShortcut.isAvailable(),
  );
  classroom = classroomController;
  const insightApi = new ClassroomInsightApiClient(environment.API_BASE_URL, () =>
    auth.readCookie(),
  );
  const insightController = new ClassroomInsightController(
    insightApi,
    accountGate,
    classroomController,
  );
  classroomInsights = insightController;
  const reportExports = new ParentReportExportController(
    insightApi,
    accountGate,
    {
      choose: async () => {
        const destination = await dialog.showSaveDialog({
          defaultPath: 'LearningReport.html',
          filters: [{ name: 'Learning report', extensions: ['html'] }],
        });
        return destination.canceled ? null : destination.filePath;
      },
    },
    new AtomicReportFile(),
    () => auth.readCookie(),
  );
  parentReportExports = reportExports;
  ipcMain.handle('tro:classroom-insights', (event, raw: unknown) =>
    insightController.execute(raw, () => isTrustedSender(event)),
  );
  ipcMain.handle('tro:parent-report-export', (event, raw: unknown) =>
    reportExports.export(raw, () => isTrustedSender(event)),
  );
  agentWorker.setClassroomToolHandler((command, context) =>
    classroomController.executeTool(command, context),
  );
  const materialApi = new MaterialApiClient(
    environment.API_BASE_URL,
    () => auth.readCookie(),
    fetch,
    (event) => {
      console.warn('classroom.materials.request.failed', event);
    },
  );
  ipcMain.handle('tro:class-materials', async (event, raw: unknown) => {
    if (!isTrustedSender(event)) {
      return { kind: 'failed', code: 'forbidden' };
    }
    const command = MaterialCommandSchema.safeParse(raw);
    if (!command.success || command.data.kind === 'download') {
      return { kind: 'failed', code: 'invalid' };
    }
    return accountGate.runRequest(() => materialApi.execute(command.data), {
      kind: 'failed',
      code: 'unavailable',
    });
  });
  const materialPreview = new MaterialPreviewController(materialApi, accountGate);
  ipcMain.handle('tro:class-material-preview', (event, raw: unknown) =>
    materialPreview.readOriginal(raw, () => isTrustedSender(event)),
  );
  ipcMain.handle('tro:class-material-download', async (event, raw: unknown) => {
    if (!isTrustedSender(event)) {
      return false;
    }
    const command = MaterialCommandSchema.safeParse(raw);
    if (!command.success || command.data.kind !== 'download') {
      return false;
    }
    return accountGate.runRequest(async () => {
      const downloadCookie = auth.readCookie();
      const result = await materialApi.execute(command.data);
      if (result.kind !== 'download') {
        return false;
      }
      const destination = await dialog.showSaveDialog({
        defaultPath: result.name,
      });
      if (
        destination.canceled ||
        !destination.filePath ||
        !isTrustedSender(event) ||
        auth.readCookie() !== downloadCookie
      ) {
        return false;
      }
      try {
        await writeFile(destination.filePath, Buffer.from(result.data, 'base64'));
        return true;
      } catch {
        return false;
      }
    }, false);
  });
  const practiceApi = new PracticeCheckApiClient(environment.API_BASE_URL, () => auth.readCookie());
  ipcMain.handle('tro:practice-check', async (event, raw: unknown): Promise<PracticeReply> => {
    if (!isTrustedSender(event)) {
      return { kind: 'failed', code: PracticeFailure.FORBIDDEN };
    }
    const parsed = PracticeCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'failed', code: PracticeFailure.INVALID };
    }
    return accountGate.runRequest(
      async () => {
        const command = parsed.data;
        const operation = command.kind === 'check' || command.kind === 'submit-snapshot';
        if (
          operation &&
          desktopCompanion?.hud.startPractice(command.requestId, command.kind, command.locale)
        ) {
          void desktopCompanion.startPresentation();
        }
        try {
          const reply = await classroomController.executePractice(command, (request) =>
            practiceApi.execute(request),
          );
          if (operation) {
            desktopCompanion?.hud.receivePracticeReply(command.requestId, reply);
          } else if (command.kind === 'history' && reply.kind === 'history') {
            desktopCompanion?.hud.receivePracticeHistory(reply);
          }
          return reply;
        } catch {
          const reply: PracticeReply = { kind: 'failed', code: PracticeFailure.UNAVAILABLE };
          if (operation) {
            desktopCompanion?.hud.receivePracticeReply(command.requestId, reply);
          }
          return reply;
        }
      },
      { kind: 'failed', code: PracticeFailure.UNAVAILABLE },
    );
  });
  ipcMain.handle('tro:classroom-command', async (event, raw: unknown): Promise<ClassroomReply> => {
    if (!isTrustedSender(event)) {
      return { kind: 'failed', code: ClassroomFailure.FORBIDDEN };
    }
    const parsed = ClassroomCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'failed', code: ClassroomFailure.INVALID };
    }
    return accountGate.runRequest(() => classroomController.execute(parsed.data), {
      kind: 'failed',
      code: ClassroomFailure.UNAVAILABLE,
    });
  });
  ipcMain.handle('tro:classroom-preparation', (event): ClassroomReply => {
    return isTrustedSender(event)
      ? (classroomController.readPreparedSubmission() ?? { kind: 'ok' })
      : { kind: 'failed', code: ClassroomFailure.FORBIDDEN };
  });
  chat = new AgentChatController(
    auth,
    agentWorker,
    `${environment.API_BASE_URL}/api/v1/model`,
    permissions,
    cancelShortcut,
    narration,
    classroomController,
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
        setImmediate(() => {
          refreshPetSuppression();
        });
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
      if (parsed.data.kind === 'stop') {
        return microphoneTests.stopTest(parsed.data.testId);
      }
      if (isStartingMicrophone || accountGate.isChanging() || auth.isAddingAccount()) {
        return { kind: 'failed' };
      }
      isStartingMicrophone = true;
      const generation = voiceEnableGeneration;
      try {
        if (!(await narration.stopSpeaking()) || generation !== voiceEnableGeneration) {
          return { kind: 'failed' };
        }
        return await microphoneTests.startTest(parsed.data.testId);
      } finally {
        isStartingMicrophone = false;
      }
    },
  );

  function disableVoice(): void {
    narration.clearTask();
    for (const finish of [...playbackReplies.values()]) {
      finish(false);
    }
    microphoneTests?.cancelTest();
    voiceKeysReleased = true;
    voiceEnableGeneration += 1;
    voiceShortcut.disableShortcut();
    voice?.invalidateVoiceInput();
    companion.dispose();
  }

  powerMonitor.on('suspend', () => {
    narration.clearTask();
    microphoneTests?.cancelTest();
    voiceShortcut.reset();
    voice?.cancelVoiceCapture();
    companion.reset();
  });
  powerMonitor.on('lock-screen', () => {
    narration.clearTask();
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
    if (
      (accountGate.isChanging() || auth.isAddingAccount()) &&
      parsed.data.kind !== 'disable' &&
      parsed.data.kind !== 'cancel' &&
      parsed.data.kind !== 'status'
    ) {
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
        return startCapture();
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
              void startCapture(true);
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

  async function changeActiveAccount(
    action: () => Promise<AuthResult>,
    canCancelSignIn = false,
  ): Promise<AuthResult> {
    return accountGate.changeAccount(async () => {
      petAccessGeneration += 1;
      petController.dispose();
      overlay.closePet();
      classroomController.dispose();
      insightController.dispose();
      reportExports.dispose();
      disableVoice();
      if (!chat) {
        return { kind: 'failed', message: 'The sign-in request is invalid.' };
      }
      return chat.changeAccount(action);
    }, canCancelSignIn);
  }

  ipcMain.handle('tro:account-command', async (event, raw: unknown): Promise<AccountReply> => {
    if (!isTrustedSender(event)) {
      return { kind: 'failed', message: 'This window cannot access sign-in.' };
    }
    const parsed = AccountCommandSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'failed', message: 'The sign-in request is invalid.' };
    }
    switch (parsed.data.kind) {
      case AccountCommandKind.LIST:
        return auth.listAccounts();
      case AccountCommandKind.ADD_GOOGLE:
        return changeActiveAccount(() => auth.addGoogleAccount());
      case AccountCommandKind.SWITCH: {
        const accountId = parsed.data.accountId;
        return changeActiveAccount(() => auth.switchAccount(accountId));
      }
      case AccountCommandKind.CANCEL_ADD:
        return changeActiveAccount(() => auth.cancelAccountSignIn(), true);
    }
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
      case 'status': {
        if (accountGate.isChanging()) {
          return { kind: 'pending' };
        }
        const generation = petAccessGeneration;
        const result = await chat.readAuthSession();
        if (isTrustedSender(event) && generation === petAccessGeneration) {
          if (result.kind === 'signed-in' || result.kind === 'signed-out') {
            await petController.setAccount(result.kind === 'signed-in' ? result.user.id : null);
          }
        }
        return result;
      }
      case 'sign-in-google':
        return changeActiveAccount(() => auth.signInWithGoogle());
      case 'sign-out':
        return changeActiveAccount(() => auth.signOut());
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

    if (accountGate.isChanging() || auth.isAddingAccount()) {
      return { kind: 'failed', message: 'An account change is already in progress.' };
    }
    petController.setSuspended(true);
    try {
      return await executeAgentCommand(rawCommand, {
        chat,
        startFollowing: () =>
          process.platform === 'darwin'
            ? companion.startFollowing()
            : Promise.resolve({ kind: 'stopped' }),
        canSendMessage: () =>
          !voice ||
          [VoiceState.IDLE, VoiceState.DISABLED].some(
            (state) => state === voice?.readStatus().state,
          ),
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
    } finally {
      refreshPetSuppression();
    }
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
      petAccessGeneration += 1;
      petController.dispose();
      overlay.closePet();
      disableVoice();
    });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        narration.clearTask();
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
      petAccessGeneration += 1;
      petController.dispose();
      overlay.closePet();
      practiceShortcut.disable();
      classroom?.dispose();
      classroomInsights?.dispose();
      parentReportExports?.dispose();
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
  pets?.dispose();
  petWindow?.dispose();
  classroom?.dispose();
  classroomInsights?.dispose();
  parentReportExports?.dispose();
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
