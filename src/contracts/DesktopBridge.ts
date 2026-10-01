import type { AgentResult } from './AgentSession.js';
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
  readAuthSession(): Promise<AuthResult>;
  signInWithGoogle(): Promise<AuthResult>;
  signOut(): Promise<AuthResult>;
  readDesktopPermissions(): Promise<DesktopPermissionStatus>;
  requestDesktopPermissions(): Promise<PermissionActionResult>;
  openDesktopPermissionSettings(area: PermissionArea): Promise<PermissionActionResult>;
  startAgentSession(): Promise<AgentResult>;
  sendAgentMessage(sessionId: string, message: string): Promise<AgentResult>;
  stopAgentSession(sessionId: string): Promise<AgentResult>;
}
