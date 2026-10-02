# Foundation verification

The earlier foundation and Cua native-library prototype were checked on macOS ARM64 on September 30, 2026. Those historical results do not validate the new signed-in lifecycle or the current bundled Cua MCP process.

The current automated checks cover strict TypeScript, contracts, backend login/credential issuance and gateway forwarding against a disposable migrated PostgreSQL instance, and API/desktop builds. Tests use synthetic credentials and a fake provider response; they do not call OpenAI or operate the desktop. The latest validation results are reported with the implementation handoff.

A full live flow still needs validation with a real backend provider key, macOS Screen Recording and Accessibility permission for Tro and its private embedded daemon, actual screenshot/action calls, cancellation, token refresh after expiry, and packaged signed builds. Windows execution and installers, code signing/notarization, Railway/AWS deployment, production account recovery, and try-on generation are also unverified.
