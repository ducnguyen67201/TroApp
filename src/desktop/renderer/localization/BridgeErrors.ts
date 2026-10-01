import type { TranslationKey } from './English.js';

/* The existing bridge sends English messages. Keep this compatibility map at
   the presentation boundary until the protocol supplies stable error codes. */
const bridgeErrorKeys: Readonly<Record<string, TranslationKey>> = {
  'Could not check your sign-in.': 'errorCheckSignIn',
  'Could not read your sign-in.': 'errorCheckSignIn',
  'Could not reach the sign-in service.': 'errorSignInService',
  'Google sign-in is not configured on the backend yet.': 'errorGoogleConfiguration',
  'Could not open Google sign-in.': 'errorOpenGoogle',
  'Could not sign out.': 'errorSignOut',
  'Sign in to use Tro.': 'errorSignInRequired',
  'Wait for the current task to finish.': 'errorTaskBusy',
  'An agent session is already active.': 'errorAgentActive',
  'The local agent worker stopped.': 'errorAgentStopped',
  'The agent session ended.': 'errorAgentStopped',
  'Start an agent session first.': 'errorStartTask',
  'Could not start the local agent worker.': 'errorStartTask',
  'Could not start the agent session.': 'errorStartTask',
  'The agent request timed out.': 'errorAgentTimeout',
  'The local agent worker is unavailable.': 'errorContactAgent',
  'Could not send the message to the agent.': 'errorContactAgent',
  'Could not stop the agent session.': 'errorClearTask',
  'Could not complete this task. Try again.': 'errorCompleteTask',
  'Could not complete the task. Check the connection and desktop access.': 'errorCompleteTask',
  'The local agent worker could not complete the request.': 'errorCompleteTask',
  'Desktop control could not start. Allow Tro Screen Recording and Accessibility in System Settings, then try again.':
    'errorDesktopPermissions',
  'Desktop control could not start. Restart Tro or reinstall the desktop app, then try again.':
    'errorDesktopStart',
  'This window cannot access sign-in.': 'errorWindowAccess',
  'This window cannot control an agent session.': 'errorWindowAccess',
  'The sign-in request is invalid.': 'errorInvalidRequest',
  'The agent request is invalid.': 'errorInvalidRequest',
};

/** Unknown diagnostics use a translated operation fallback rather than raw text. */
export function resolveBridgeError(message: string, fallback: TranslationKey): TranslationKey {
  return Object.hasOwn(bridgeErrorKeys, message)
    ? (bridgeErrorKeys[message] ?? fallback)
    : fallback;
}
