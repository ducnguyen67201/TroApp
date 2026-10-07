/** OAuth callback scheme shared by the desktop SDK and the macOS development host. */
export const DesktopAuthProtocol = {
  SCHEME: 'app.tro.desktop',
  CALLBACK_URL: 'app.tro.desktop://auth/callback',
} as const;
