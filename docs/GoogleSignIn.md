# Google sign-in setup

Tro uses a Google OAuth web client for the backend callback and a registered `tro://auth/callback` desktop protocol for a short-lived one-time handoff. Google client secrets remain backend-only. The desktop bundle contains only the public API URL and never contains the Google client secret or database credentials.

## Google Cloud

1. Create or select a Google Cloud project and configure the OAuth consent screen.
2. Create an OAuth 2.0 **Web application** client.
3. Add the exact local authorized redirect URI:
   `http://127.0.0.1:3000/api/v1/auth/google/callback`
4. For each deployed environment, add its exact HTTPS callback, for example:
   `https://api.example.com/api/v1/auth/google/callback`
5. Do not add wildcards, alternate paths, renderer URLs, or the `tro://` URI to Google's redirect list. The backend alone receives Google's callback.

Changes to the OAuth consent screen or production publication may require Google verification. Keep test users limited while the consent screen is in testing mode.

## Doppler

Create separate Doppler configurations for development, staging, and production. Store these backend variables in each configuration:

- `DATABASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `APP_ENV` (`dev`, `stage`, or `prod`)

For local development:

```sh
doppler setup
doppler run -- pnpm db:migrate
doppler run -- pnpm dev
```

The callback value must exactly match one of the Google Cloud authorized redirect URIs. Tro validates that it uses HTTPS, except for loopback HTTP during local development, and that its path is `/api/v1/auth/google/callback`.

## Desktop callback and secure storage

Packaged macOS and Windows builds register the `tro` protocol from `package.json`. Development builds also request protocol registration, but operating-system behavior can vary when multiple development copies exist. Close older Tro processes before testing a callback.

Electron main exchanges the callback handoff and stores the resulting session with `safeStorage`. Linux environments using Electron's insecure `basic_text` fallback are rejected; configure a supported desktop keyring. The renderer receives only profile/workspace state. Logout revokes the server session before deleting the local encrypted credential.

## Troubleshooting

- A Google `redirect_uri_mismatch` means `GOOGLE_REDIRECT_URI` and Google Cloud do not match exactly.
- A cancelled, expired, replayed, or invalid-state callback returns to Tro with a generic retryable message and no provider details.
- If the browser finishes but Tro does not reopen, verify OS protocol registration and ensure the packaged app ID is `app.tro.desktop`.
- Never paste authorization codes, ID tokens, session values, raw Google profiles, or secret configuration into logs or issue comments.
