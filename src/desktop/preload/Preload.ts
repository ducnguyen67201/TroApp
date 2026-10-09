import {
  PracticeCaptureCommandSchema,
  PracticeCaptureReplySchema,
} from '#contracts/PracticeCapture.js';
import { petOverlayBridge } from './PetPreload.js';
import {
  ClassroomInsightCommandSchema,
  ClassroomInsightReplySchema,
  InsightFailure,
  ParentReportExportCommandSchema,
  ParentReportExportReplySchema,
} from '#contracts/ClassroomInsights.js';
import { PetCommandSchema, PetReplySchema, PetSnapshotSchema, PetFailure } from '#contracts/Pet.js';
import { PracticeShortcutEventSchema } from '#contracts/PracticeShortcut.js';
import {
  PracticeCommandSchema,
  PracticeReplySchema,
  PracticeFailure,
} from '#contracts/PracticeCheck.js';
import {
  AccountCommandKind,
  AccountCommandSchema,
  AccountReplySchema,
  type AccountCommand,
  type AccountReply,
} from '#contracts/DesktopAccounts.js';
import {
  MaterialCommandSchema,
  MaterialReplySchema,
  MaterialPreviewReplySchema,
} from '#contracts/ClassroomMaterials.js';
import {
  VoiceoverPlaybackSchema,
  VoiceoverStatusSchema,
  VoiceoverAckSchema,
  VoiceoverPreferenceSchema,
} from '#contracts/Voiceover.js';
import {
  MicrophoneTestCommandSchema,
  MicrophoneTestEventSchema,
  MicrophoneTestReplySchema,
} from '#contracts/MicrophoneTest.js';
import {
  ClassroomCommandSchema,
  ClassroomReplySchema,
  ClassroomFailure,
} from '#contracts/Classroom.js';
import { AgentProgressSchema, VoiceMeterSchema, type VoiceMeter } from '#contracts/CompanionHud.js';
import {
  VoiceCommandSchema,
  VoiceAudioFrameSchema,
  VoiceEventSchema,
  VoiceReplySchema,
  type VoiceCommand,
  type VoiceAudioFrame,
  type VoiceEvent,
  type VoiceReply,
} from '#contracts/VoiceInput.js';
import { AgentTaskMode } from '#contracts/CursorCompanion.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '#contracts/DesktopBridge.js';
import {
  AppUpdateCommand,
  AppUpdateFailure,
  AppUpdateReplySchema,
  AppUpdateSnapshotSchema,
  AppUpdateState,
  type AppUpdateReply,
} from '#contracts/AppUpdate.js';
import {
  AgentCommandSchema,
  AgentResultSchema,
  type AgentResult,
} from '#contracts/AgentSession.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import { AuthResultSchema, type AuthResult } from '#contracts/AuthSession.js';
import {
  DesktopPermissionStatusSchema,
  PermissionActionResultSchema,
  type DesktopPermissionStatus,
  type PermissionActionResult,
  type PermissionArea,
} from '#contracts/DesktopPermissions.js';

/* Expose named session operations, not generic IPC or direct computer tools.
   Validate IPC data before it enters the renderer. */
const bridge: DesktopBridge = {
  async controlClassroomInsights(command) {
    try {
      const raw: unknown = await ipcRenderer.invoke(
        'tro:classroom-insights',
        ClassroomInsightCommandSchema.parse(command),
      );
      return ClassroomInsightReplySchema.parse(raw);
    } catch {
      return { kind: 'failed', code: InsightFailure.UNAVAILABLE };
    }
  },
  async exportParentReport(command) {
    try {
      const raw: unknown = await ipcRenderer.invoke(
        'tro:parent-report-export',
        ParentReportExportCommandSchema.parse(command),
      );
      return ParentReportExportReplySchema.parse(raw);
    } catch {
      return { saved: false, code: InsightFailure.UNAVAILABLE };
    }
  },
  async readPets() {
    try {
      const value: unknown = await ipcRenderer.invoke('tro:pet-read');
      return PetReplySchema.parse(value);
    } catch {
      return { kind: 'failed', reason: PetFailure.UNAVAILABLE };
    }
  },
  async controlPet(command) {
    try {
      const value: unknown = await ipcRenderer.invoke(
        'tro:pet-command',
        PetCommandSchema.parse(command),
      );
      return PetReplySchema.parse(value);
    } catch {
      return { kind: 'failed', reason: PetFailure.UNAVAILABLE };
    }
  },
  subscribePet(listener) {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const parsed = PetSnapshotSchema.safeParse(value);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on('tro:pet-snapshot', receive);
    return () => {
      ipcRenderer.removeListener('tro:pet-snapshot', receive);
    };
  },
  async controlClassMaterials(command) {
    try {
      return MaterialReplySchema.parse(
        await ipcRenderer.invoke('tro:class-materials', MaterialCommandSchema.parse(command)),
      );
    } catch {
      return { kind: 'failed', code: 'unavailable' };
    }
  },
  async downloadClassMaterial(classId, materialId) {
    const result: unknown = await ipcRenderer.invoke(
      'tro:class-material-download',
      MaterialCommandSchema.parse({ kind: 'download', classId, materialId }),
    );
    return result === true;
  },
  async previewClassMaterial(classId, materialId) {
    try {
      return MaterialPreviewReplySchema.parse(
        await ipcRenderer.invoke(
          'tro:class-material-preview',
          MaterialCommandSchema.parse({ kind: 'download', classId, materialId }),
        ),
      );
    } catch {
      return { kind: 'failed', code: 'unavailable' };
    }
  },
  subscribeVoiceover(listener) {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const status = VoiceoverStatusSchema.safeParse(raw);
      if (status.success) {
        listener(status.data);
        return;
      }
      const command = VoiceoverPlaybackSchema.safeParse(raw);
      if (command.success) {
        listener(command.data);
      }
    };
    ipcRenderer.on('tro:voiceover', receive);
    return () => {
      ipcRenderer.removeListener('tro:voiceover', receive);
    };
  },
  async acknowledgeVoiceover(ack) {
    await ipcRenderer.invoke('tro:voiceover-ack', VoiceoverAckSchema.parse(ack));
  },
  async setVoiceoverEnabled(enabled, locale) {
    await ipcRenderer.invoke(
      'tro:voiceover-preference',
      VoiceoverPreferenceSchema.parse({ enabled, locale }),
    );
  },
  async stopSpeaking() {
    const result: unknown = await ipcRenderer.invoke('tro:stop-speaking');
    return result === true;
  },
  async cancelGuidance() {
    await ipcRenderer.invoke('tro:cancel-guidance');
  },
  async controlPracticeCapture(command) {
    const parsed = PracticeCaptureCommandSchema.safeParse(command);
    if (!parsed.success) {
      return { kind: 'failed', code: PracticeFailure.INVALID };
    }
    const raw: unknown = await ipcRenderer.invoke('tro:practice-capture', parsed.data);
    const reply = PracticeCaptureReplySchema.safeParse(raw);
    return reply.success ? reply.data : { kind: 'failed', code: PracticeFailure.UNAVAILABLE };
  },
  async readPracticeShortcutAvailable() {
    const available: unknown = await ipcRenderer.invoke('tro:practice-shortcut-available');
    return available === true;
  },
  subscribePracticeShortcut(listener) {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const event = PracticeShortcutEventSchema.safeParse(raw);
      if (event.success) {
        listener(event.data);
      }
    };
    ipcRenderer.on('tro:practice-shortcut', receive);
    return () => {
      ipcRenderer.removeListener('tro:practice-shortcut', receive);
    };
  },
  async controlPractice(command) {
    try {
      return PracticeReplySchema.parse(
        await ipcRenderer.invoke('tro:practice-check', PracticeCommandSchema.parse(command)),
      );
    } catch {
      return { kind: 'failed', code: PracticeFailure.UNAVAILABLE };
    }
  },
  async controlClassroom(command) {
    try {
      return ClassroomReplySchema.parse(
        await ipcRenderer.invoke('tro:classroom-command', ClassroomCommandSchema.parse(command)),
      );
    } catch {
      return { kind: 'failed', code: ClassroomFailure.UNAVAILABLE };
    }
  },
  async readPreparedClassroomSubmission() {
    try {
      return ClassroomReplySchema.parse(await ipcRenderer.invoke('tro:classroom-preparation'));
    } catch {
      return { kind: 'failed', code: ClassroomFailure.UNAVAILABLE };
    }
  },
  subscribeAgentProgress(listener) {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const parsed = AgentProgressSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on('tro:agent-progress', receive);
    return () => {
      ipcRenderer.removeListener('tro:agent-progress', receive);
    };
  },
  async readAppUpdate() {
    const reply = await requestAppUpdate(AppUpdateCommand.STATUS);
    return reply.kind === 'ok'
      ? reply.snapshot
      : { revision: 0, status: { state: AppUpdateState.DISABLED } };
  },
  checkAppUpdate: () => requestAppUpdate(AppUpdateCommand.CHECK),
  downloadAppUpdate: () => requestAppUpdate(AppUpdateCommand.DOWNLOAD),
  restartForAppUpdate: () => requestAppUpdate(AppUpdateCommand.RESTART),
  subscribeAppUpdate(listener) {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const parsed = AppUpdateSnapshotSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on('tro:update-event', receive);
    return () => {
      ipcRenderer.removeListener('tro:update-event', receive);
    };
  },
  async controlMicrophoneTest(command) {
    try {
      return MicrophoneTestReplySchema.parse(
        await ipcRenderer.invoke('tro:microphone-test', MicrophoneTestCommandSchema.parse(command)),
      );
    } catch {
      return { kind: 'failed' };
    }
  },
  subscribeMicrophoneTest(listener) {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const parsed = MicrophoneTestEventSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on('tro:microphone-test-event', receive);
    return () => {
      ipcRenderer.removeListener('tro:microphone-test-event', receive);
    };
  },
  updateVoiceMeter(meter: VoiceMeter): void {
    const parsed = VoiceMeterSchema.safeParse(meter);
    if (parsed.success) {
      ipcRenderer.send('tro:voice-meter', parsed.data);
    }
  },
  async controlVoiceInput(command: VoiceCommand): Promise<VoiceReply> {
    try {
      return VoiceReplySchema.parse(
        await ipcRenderer.invoke('tro:voice-command', VoiceCommandSchema.parse(command)),
      );
    } catch {
      return { kind: 'failed' };
    }
  },
  async appendVoiceAudio(frame: VoiceAudioFrame): Promise<VoiceReply> {
    try {
      return VoiceReplySchema.parse(
        await ipcRenderer.invoke('tro:voice-audio', VoiceAudioFrameSchema.parse(frame)),
      );
    } catch {
      return { kind: 'failed' };
    }
  },
  subscribeVoiceInput(listener: (event: VoiceEvent) => void): () => void {
    const receiveEvent = (_event: Electron.IpcRendererEvent, rawEvent: unknown): void => {
      const parsed = VoiceEventSchema.safeParse(rawEvent);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on('tro:voice-event', receiveEvent);
    return () => {
      ipcRenderer.removeListener('tro:voice-event', receiveEvent);
    };
  },
  readSavedAccounts: () => requestAccountCommand({ kind: AccountCommandKind.LIST }),
  addGoogleAccount: () => requestAccountAuth({ kind: AccountCommandKind.ADD_GOOGLE }),
  switchAccount: (accountId) => requestAccountAuth({ kind: AccountCommandKind.SWITCH, accountId }),
  cancelAccountSignIn: () => requestAccountAuth({ kind: AccountCommandKind.CANCEL_ADD }),
  async readAuthSession(): Promise<AuthResult> {
    try {
      return AuthResultSchema.parse(
        await ipcRenderer.invoke('tro:auth-command', { kind: 'status' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not check your sign-in.' };
    }
  },
  async signInWithGoogle(): Promise<AuthResult> {
    try {
      return AuthResultSchema.parse(
        await ipcRenderer.invoke('tro:auth-command', { kind: 'sign-in-google' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not open Google sign-in.' };
    }
  },
  async signOut(): Promise<AuthResult> {
    try {
      return AuthResultSchema.parse(
        await ipcRenderer.invoke('tro:auth-command', { kind: 'sign-out' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not sign out.' };
    }
  },
  async readDesktopPermissions(): Promise<DesktopPermissionStatus> {
    try {
      return DesktopPermissionStatusSchema.parse(
        await ipcRenderer.invoke('tro:permission-command', { kind: 'status' }),
      );
    } catch {
      return { kind: 'unknown', accessibility: 'unknown', screenRecording: 'unknown' };
    }
  },
  async requestDesktopPermissions(): Promise<PermissionActionResult> {
    try {
      return PermissionActionResultSchema.parse(
        await ipcRenderer.invoke('tro:permission-command', { kind: 'request' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not open macOS permission setup.' };
    }
  },
  async openDesktopPermissionSettings(area: PermissionArea): Promise<PermissionActionResult> {
    try {
      return PermissionActionResultSchema.parse(
        await ipcRenderer.invoke('tro:permission-command', { kind: 'open-settings', area }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not open System Settings.' };
    }
  },
  async startCursorCompanion(): Promise<AgentResult> {
    try {
      return AgentResultSchema.parse(
        await ipcRenderer.invoke('tro:agent-command', { kind: 'follow' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not start the cursor companion.' };
    }
  },
  async startAgentSession(): Promise<AgentResult> {
    try {
      return AgentResultSchema.parse(
        await ipcRenderer.invoke('tro:agent-command', { kind: 'start' }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not start the agent session.' };
    }
  },
  async sendAgentMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode: AgentTaskMode = AgentTaskMode.EXECUTE,
  ): Promise<AgentResult> {
    try {
      return AgentResultSchema.parse(
        await ipcRenderer.invoke(
          'tro:agent-command',
          AgentCommandSchema.parse({ kind: 'turn', sessionId, message, locale, mode }),
        ),
      );
    } catch {
      return { kind: 'failed', message: 'Could not send the message to the agent.' };
    }
  },
  async answerTeachingLesson(sessionId, lessonId, message, locale): Promise<AgentResult> {
    const command = AgentCommandSchema.parse({
      kind: 'answer',
      sessionId,
      lessonId,
      message,
      locale,
    });
    const result: unknown = await ipcRenderer.invoke('tro:agent-command', command);
    return AgentResultSchema.parse(result);
  },
  async updateTeachingLocale(sessionId, locale): Promise<AgentResult> {
    const result: unknown = await ipcRenderer.invoke(
      'tro:agent-command',
      AgentCommandSchema.parse({ kind: 'locale', sessionId, locale }),
    );
    return AgentResultSchema.parse(result);
  },
  async stopAgentSession(sessionId: string): Promise<AgentResult> {
    try {
      return AgentResultSchema.parse(
        await ipcRenderer.invoke('tro:agent-command', { kind: 'stop', sessionId }),
      );
    } catch {
      return { kind: 'failed', message: 'Could not stop the agent session.' };
    }
  },
};

async function requestAccountCommand(command: AccountCommand): Promise<AccountReply> {
  try {
    return AccountReplySchema.parse(
      await ipcRenderer.invoke('tro:account-command', AccountCommandSchema.parse(command)),
    );
  } catch {
    return { kind: 'failed', message: 'Could not update saved accounts.' };
  }
}

async function requestAccountAuth(command: AccountCommand): Promise<AuthResult> {
  const result = await requestAccountCommand(command);
  return result.kind === 'accounts'
    ? { kind: 'failed', message: 'Could not update saved accounts.' }
    : result;
}

async function requestAppUpdate(
  kind: (typeof AppUpdateCommand)[keyof typeof AppUpdateCommand],
): Promise<AppUpdateReply> {
  try {
    return AppUpdateReplySchema.parse(await ipcRenderer.invoke('tro:update-command', { kind }));
  } catch {
    return { kind: 'failed', reason: AppUpdateFailure.UNAVAILABLE };
  }
}

/* One self-contained bundle avoids sandbox-incompatible shared CJS chunks.
 * Only main can supply this argument; each window receives a distinct surface. */
if (process.argv.includes('--tro-pet-overlay')) {
  contextBridge.exposeInMainWorld('troPet', petOverlayBridge);
} else {
  contextBridge.exposeInMainWorld('tro', bridge);
}
