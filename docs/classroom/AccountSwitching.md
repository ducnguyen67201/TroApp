# Saved account switching

Click the sidebar avatar to switch accounts, add another Google account, or sign
out of the current account. Saved accounts are specific to this installation.
The login flow remains Google → backend → Electron deep link. There is no role
switch: teacher and student are separate real users with separate backend sessions.

## Session ownership

`AuthClient.ts` keeps one Better Auth Electron client for browser OAuth and protocol
registration. Its existing `AuthStorage` becomes a staging slot for incoming
Google logins. After verification through `/api/auth/get-session`, `AccountSessions.ts`
retains the account's cookie separately and selects it as active. An existing
single-account login migrates after its first successful verification.

`EncryptedAccountVault.ts` stores the registry in Electron's user-data directory as
`SavedAccounts`, encrypted with native `safeStorage`. It writes through a temporary
file with owner-only permissions and renames it into place. It fails closed when
native encryption is unavailable, including Linux's `basic_text` fallback. Corrupted
storage is preserved and reported instead of reset. Up to ten accounts are retained.
Cookies remain in main; only names, emails, roles, profile IDs and expiry hints
cross preload. Device storage is namespaced by Electron user-data, not the browser.

The SDK staging slot is never selected directly after migration. Cancellation
clears the pinned SDK's pending PKCE map through the main-only adapter; SDK fetch responses are fenced against
canceled attempts. Session-verification replies also carry a local generation
check so a delayed response cannot restore the previous identity. The cancellation adapter has a compatibility test against SDK 1.7.6 because its
runtime omits the state-map export advertised by its types. The browser flow
has a two-minute deadline. A later sign-in replaces the saved session for the same
user rather than duplicating that user.

## Switching and cleanup

```ts
// Main.ts: after validating the IPC command and its sending frame
return changeActiveAccount(() => auth.switchAccount(accountId));

// AuthClient → AccountSessions: verify the stored cookie with the backend
const result = await verifyCookie(account.cookie);
// Select the target only when the authenticated user matches the saved user.
// A failed check leaves the current account selected.
```

`AccountTransitionGate.ts` excludes account transitions from in-flight classroom
and material requests, including downloads. New requests are blocked while Google
sign-in is pending. Active tasks, voice capture/transcription and microphone tests
must finish before switching. Main then leaves the old classroom participation,
disables voice, clears narration and disposes the agent worker before selecting
new credentials. Account transitions also block new agent commands and voice setup.

`UseComputerUse.ts` clears task messages, drafts, teaching state and capture/session
references. `App.tsx` resets navigation on identity changes, suspends voice hooks and
unmounts the classroom view during a transition so it reloads for the active user.
`AccountMenu.tsx` provides the avatar popover and Google sign-in dialog with English
and Vietnamese copy. Named bridge operations validate both commands and responses.

Switching does **not** call backend sign-out for the old account. The teacher's
live classroom session and class materials remain in PostgreSQL. Leaving desktop
participation is different from ending the class. Students join the running
session again when returning to their account. Expired saved sessions require a
new Google login; role and membership checks remain authoritative on the backend.

Sign-out posts to `/api/auth/sign-out` with the **selected account's cookie**, then
removes that account from the vault. Other accounts remain available, even on the
signed-out screen. A failed revocation keeps the saved account so the user can retry.
The SDK's staging sign-out is not used because staging may belong to a different user.

## Test on one machine

1. Sign in as the teacher. Create a class, invite the student and start a session.
2. Click the avatar → **Add account** → **Continue with Google**, then select the
   student Google account. Join the class and its live session.
3. Click the avatar and select the saved teacher. Change the class stage or section.
4. Switch back to the saved student, join the live session again and start a new
   task. Confirm the active section/stage is reflected in teaching guidance.
5. Sign out of one account. Confirm the other saved account still opens without
   Google authentication while its backend session remains valid.

One device can check sequential teacher/student flows. It cannot prove simultaneous
student presence or real-time propagation across two devices. Unit tests cover
credential isolation, migration, cancellation, expiry, identity mismatch, restart,
revocation failures, request exclusion, preload validation and renderer switching.
The Google callback and OS keychain still require an interactive native-app
smoke test; unit tests use synthetic sessions and native-encryption doubles.

## Development callback ownership

The account picker reuses the running Tro instance. Before opening Google,
`DesktopAuthCallback.ts` registers the protocol and verifies the macOS application
path. This prevents a stale worktree's Tro bundle from receiving the new account's
callback. The development launcher supplies a checkout-specific identity, an
`Info.plist` URL declaration and an entry module for launches without CLI arguments.
See [development host setup](../Development.md#desktop-packaging).

An Electron welcome window after browser sign-in indicates a misconfigured host,
not successful sign-in to that second app. Close that window and restart the
correct desktop launcher after updating. Start a fresh Google flow because the
original pending proof is tied to the original process. Existing encrypted saved
accounts stay in the same user-data directory; their cookies are not copied into
that second window.
