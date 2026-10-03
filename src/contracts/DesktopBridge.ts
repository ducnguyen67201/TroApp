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

/** Named capabilities available to React through Electron preload.
 * The agent chooses computer actions inside its worker; React only sends chat
 * turns and controls the worker lifecycle.
 */
export interface DesktopBridge {
  updateTeachingLocale?: (sessionId: string, locale: DesktopLocale) => Promise<AgentResult>;
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
