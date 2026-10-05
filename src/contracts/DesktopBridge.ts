import type { PetCommand, PetReply, PetSnapshot } from './Pet.js';
import type {
  MicrophoneTestCommand,
  MicrophoneTestEvent,
  MicrophoneTestReply,
} from './MicrophoneTest.js';
import type { VoiceMeter, AgentProgress } from './CompanionHud.js';
import type { VoiceAudioFrame, VoiceCommand, VoiceEvent, VoiceReply } from './VoiceInput.js';
import type { AgentTaskMode } from './CursorCompanion.js';
import type { AgentResult } from './AgentSession.js';
import type { DesktopLocale } from './DesktopLocale.js';
import type { AuthResult } from './AuthSession.js';
import type {
  DesktopPermissionStatus,
  PermissionActionResult,
  PermissionArea,
} from './DesktopPermissions.js';
import type { AppUpdateReply, AppUpdateSnapshot } from './AppUpdate.js';
import type { VoiceoverAck, VoiceoverPlayback, VoiceoverStatus } from './Voiceover.js';

/** Named capabilities available to React through Electron preload.
 * The agent chooses computer actions inside its worker; React only sends chat
 * turns and controls the worker lifecycle.
 */
export interface DesktopBridge {
  readPets?: () => Promise<PetReply>;
  controlPet?: (command: PetCommand) => Promise<PetReply>;
  subscribePet?: (listener: (snapshot: PetSnapshot) => void) => () => void;
  subscribeVoiceover?: (
    listener: (event: VoiceoverPlayback | VoiceoverStatus) => void,
  ) => () => void;
  acknowledgeVoiceover?: (ack: VoiceoverAck) => Promise<void>;
  setVoiceoverEnabled?: (enabled: boolean, locale: DesktopLocale) => Promise<void>;
  stopSpeaking?: () => Promise<boolean>;
  cancelGuidance?: () => Promise<void>;
  updateTeachingLocale?: (sessionId: string, locale: DesktopLocale) => Promise<AgentResult>;
  readAppUpdate(): Promise<AppUpdateSnapshot>;
  checkAppUpdate(): Promise<AppUpdateReply>;
  downloadAppUpdate(): Promise<AppUpdateReply>;
  restartForAppUpdate(): Promise<AppUpdateReply>;
  subscribeAppUpdate(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
  controlMicrophoneTest(command: MicrophoneTestCommand): Promise<MicrophoneTestReply>;
  subscribeMicrophoneTest(listener: (event: MicrophoneTestEvent) => void): () => void;
  updateVoiceMeter(meter: VoiceMeter): void;
  controlVoiceInput(command: VoiceCommand): Promise<VoiceReply>;
  appendVoiceAudio(frame: VoiceAudioFrame): Promise<VoiceReply>;
  subscribeVoiceInput(listener: (event: VoiceEvent) => void): () => void;
  subscribeAgentProgress(listener: (event: AgentProgress) => void): () => void;
  readAuthSession(): Promise<AuthResult>;
  signInWithGoogle(): Promise<AuthResult>;
  signOut(): Promise<AuthResult>;
  readDesktopPermissions(): Promise<DesktopPermissionStatus>;
  requestDesktopPermissions(): Promise<PermissionActionResult>;
  openDesktopPermissionSettings(area: PermissionArea): Promise<PermissionActionResult>;
  startCursorCompanion(): Promise<AgentResult>;
  startAgentSession(): Promise<AgentResult>;
  sendAgentMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode?: AgentTaskMode,
  ): Promise<AgentResult>;
  answerTeachingLesson(
    sessionId: string,
    lessonId: string,
    message: string,
    locale: DesktopLocale,
  ): Promise<AgentResult>;
  stopAgentSession(sessionId: string): Promise<AgentResult>;
}
