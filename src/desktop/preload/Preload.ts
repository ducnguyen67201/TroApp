import { petOverlayBridge } from './PetPreload.js';
import { PetCommandSchema, PetReplySchema, PetSnapshotSchema, PetFailure } from '#contracts/Pet.js';
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
