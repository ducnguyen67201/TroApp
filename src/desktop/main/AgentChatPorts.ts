import type { AgentResult } from '#contracts/AgentSession.js';
import type { AuthResult, ModelCredential } from '#contracts/AuthSession.js';
import type { AgentTaskMode } from '#contracts/CursorCompanion.js';
import type { DesktopPermissionStatus } from '#contracts/DesktopPermissions.js';
import type { DesktopLocale } from '#contracts/DesktopLocale.js';
import type { TeachingContext } from '#contracts/Classroom.js';

/** Authentication operations required by the chat controller. */
export interface AgentChatAuth {
  readSession(): Promise<AuthResult>;
  signInWithGoogle(): Promise<AuthResult>;
  signOut(): Promise<AuthResult>;
  fetchModelCredential(): Promise<ModelCredential>;
}

/** Owns the local worker's lifetime and exchanges typed task results. */
export interface AgentChatWorker {
  updateTeachingLocale?: (sessionId: string, locale: DesktopLocale) => Promise<AgentResult>;
  isRunning(): boolean;
  startCompanion(sessionId: string): Promise<AgentResult>;
  start(sessionId: string, gatewayToken: string, gatewayBaseUrl: string): Promise<AgentResult>;
  sendMessage(
    sessionId: string,
    message: string,
    locale: DesktopLocale,
    mode?: AgentTaskMode,
    classroomContext?: TeachingContext,
  ): Promise<AgentResult>;
  answerLesson?(
    sessionId: string,
    lessonId: string,
    message: string,
    locale: DesktopLocale,
  ): Promise<AgentResult>;
  refreshCredential?(
    sessionId: string,
    gatewayToken: string,
    gatewayBaseUrl: string,
  ): Promise<AgentResult>;
  stop(sessionId: string): Promise<AgentResult>;
  dispose(): void;
}

/** Reads the desktop grants required before a task can start. */
export interface AgentChatPermissions {
  readStatus(): Promise<DesktopPermissionStatus>;
}

/** The lesson owns one Esc callback; narration can retain its own callback after settlement. */
export interface AgentCancelShortcut {
  enable(cancel: () => void): boolean;
  disable(): void;
}
