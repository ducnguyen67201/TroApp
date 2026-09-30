# Foundation verification

Verified locally on macOS ARM64 on September 30, 2026.

| Check                            | Result                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                      | Passed, including owned filenames and core import boundaries                                                                          |
| `pnpm format:check`              | Passed                                                                                                                                |
| `pnpm typecheck`                 | Passed with strict settings                                                                                                           |
| `pnpm test`                      | Eight tests passed                                                                                                                    |
| `pnpm test:integration`          | Two tests passed against disposable PostgreSQL                                                                                        |
| `pnpm build`                     | API and desktop bundles built                                                                                                         |
| Backend Docker image             | Built; migrated disposable PostgreSQL and returned ready through HTTP                                                                 |
| macOS desktop                    | Launched; connection button reached a local API and displayed unavailable database state correctly                                    |
| Unsigned macOS directory package | Built and launched; connection button reached the local API; archive contains only desktop main/preload/renderer and package metadata |

The packaged archive contains no backend code, migrations, Prisma, or backend dependencies. Explicit packaging exclusions enforce this even when the dependency collector traverses the root package.

The backend container ran as its non-root runtime user. Temporary database/API containers and their private test network were removed after verification.

Windows execution and installers, code signing/notarization, Railway/AWS deployment, identity, actual agent runs, model gateway, try-on generation, and real desktop automation have not been verified or implemented. The foundation does not claim those capabilities.
