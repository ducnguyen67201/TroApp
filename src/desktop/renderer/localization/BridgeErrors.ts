import { DesktopLocale } from '#contracts/DesktopLocale.js';
import { readClassroomMessages } from '../../localization/ClassroomMessages.js';
import type { TranslationKey } from './English.js';

/* Map main-process copy in either locale back to catalog keys so visible alerts
   follow UI language changes until the protocol supplies stable error codes. */
const englishClassroomMessages = readClassroomMessages(DesktopLocale.ENGLISH);
const vietnameseClassroomMessages = readClassroomMessages(DesktopLocale.VIETNAMESE);

const bridgeErrorKeys: Readonly<Record<string, TranslationKey>> = {
  'Could not update saved accounts.': 'errorSavedAccounts',
  'Secure account storage is unavailable.': 'errorAccountStorage',
  'Saved account storage is unavailable.': 'errorAccountStorage',
  'This saved account is unavailable.': 'errorSwitchAccount',
  'The account changed. Try again.': 'errorSwitchAccount',
  'Sign in to this account again.': 'errorAccountExpired',
  'Saved account limit reached. Sign out an account first.': 'errorAccountLimit',
  'An account change cannot start during active work.': 'errorAccountBusy',
  'An account change is already in progress.': 'errorAccountBusy',
  'Google sign-in did not finish. Please try again.': 'errorSignInTimeout',
  [englishClassroomMessages.errorClassroomTeachMode]: 'errorClassroomTeachMode',
  [vietnameseClassroomMessages.errorClassroomTeachMode]: 'errorClassroomTeachMode',
  [englishClassroomMessages.errorClassroomContextChanged]: 'errorClassroomContextChanged',
  [vietnameseClassroomMessages.errorClassroomContextChanged]: 'errorClassroomContextChanged',
  'Daily model allowance reached.': 'errorDailyModelLimit',
  'Could not start the cursor companion.': 'errorCompanionUnavailable',
  'Cursor companion is unavailable. Install the companion-enabled Cua Driver and restart Tro.':
    'errorCompanionUnavailable',
  'Could not check your sign-in.': 'errorCheckSignIn',
  'Could not read your sign-in.': 'errorCheckSignIn',
  'Could not reach the sign-in service.': 'errorSignInService',
  'Google sign-in is not configured on the backend yet.': 'errorGoogleConfiguration',
  'Could not open Google sign-in.': 'errorOpenGoogle',
  'Tro could not register the sign-in callback. Restart the desktop launcher.':
    'errorSignInCallback',
  'Another Tro app is receiving sign-in. Restart this desktop launcher.': 'errorSignInCallback',
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
