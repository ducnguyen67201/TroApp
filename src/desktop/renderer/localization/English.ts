/** Canonical desktop copy. Other catalogs must implement every key and parameter. */
export const english = {
  navigation: 'Main navigation',
  workspace: 'Workspace',
  settings: 'Settings',
  yourAccount: 'Your account',
  checkingSignIn: 'Checking sign-in…',
  signOut: 'Sign out',
  ownWorkspace: 'Your own little workspace',
  signInInvitation: 'Sign in to make it yours.',
  signIn: 'Sign in',
  yourDesktop: 'YOUR DESKTOP',
  attention: 'Something needs attention',
  settingsDescription: 'The essentials, all in one place.',
  account: 'Account',
  name: 'Name',
  email: 'Email',
  signOutHint: 'You can sign out from the sidebar.',
  accountSignInHint: 'Sign in from the sidebar to see your account.',
  appearance: 'Appearance',
  appearanceDescription: 'A simple, warm light theme.',
  light: 'Light',
  language: 'Language',
  languageDescription:
    'Choose the language Tro uses. Changes apply immediately and are saved on this device.',
  languageStorageWarning: 'The language changed for now, but could not be saved on this device.',
  assistant: 'Computer-use assistant',
  welcome: (name: string): string => `Welcome back, ${name}`,
  workspaceHeading: 'A little space to do more.',
  workspaceDescription: 'Your desktop, with a helping hand.',
  newTask: 'New task',
  makeYourselfAtHome: 'Make yourself at home.',
  googleInvitation: 'Sign in to start a task with Tro. Google opens in your browser.',
  waitingForGoogle: 'Waiting for Google…',
  continueWithGoogle: 'Continue with Google',
  helpHeading: 'What can I help you with?',
  helpDescription: 'Ask a question or tell Tro what you’d like to do in an app on your desktop.',
  conversation: 'Conversation',
  you: 'You',
  yourMessage: 'Your message',
  messagePlaceholder: 'Ask Tro to help with something…',
  working: 'Tro is working on your desktop…',
  freshStart: 'A fresh start with every message',
  sendToTro: 'Send to Tro',
  send: 'Send',
  taskDisclosure:
    'Tro may view your screen and use your mouse or keyboard. Screen observations sent to OpenAI leave your computer. Each message is a fresh task; this display clears when you close the app.',
  errorCheckSignIn: 'Could not check sign-in. Please try signing in again.',
  errorSignInTimeout: 'Google sign-in did not finish. Please try again.',
  errorOpenGoogle: 'Could not open Google sign-in.',
  errorClearTask: 'Could not clear the task. Please try again.',
  errorStartTask: 'Could not start a task. Please try again.',
  errorCompleteTask: 'Could not complete the task. Check the connection and desktop access.',
  errorContactAgent: 'Could not contact the local agent. Try sending again.',
  errorSignOut: 'Could not sign out. Please try again.',
  errorSignInService: 'Could not reach the sign-in service.',
  errorGoogleConfiguration: 'Google sign-in is not configured on the backend yet.',
  errorSignInRequired: 'Sign in to use Tro.',
  errorTaskBusy: 'Wait for the current task to finish.',
  errorAgentActive: 'An agent session is already active.',
  errorAgentStopped: 'The agent session ended. Start a new task.',
  errorAgentTimeout: 'The agent request timed out. Please try again.',
  errorDesktopPermissions:
    'Desktop control could not start. Allow CuaDriver Screen Recording and Accessibility in System Settings, then try again.',
  errorDesktopStart:
    'Desktop control could not start. Restart Tro or reinstall the desktop app, then try again.',
  errorInvalidRequest: 'This request is invalid. Please try again.',
  errorWindowAccess: 'This window cannot access this action. Restart Tro and try again.',
};

export type TranslationCatalog = {
  [Key in keyof typeof english]: (typeof english)[Key];
};

export type TranslationKey = {
  [Key in keyof TranslationCatalog]: TranslationCatalog[Key] extends string ? Key : never;
}[keyof TranslationCatalog];
