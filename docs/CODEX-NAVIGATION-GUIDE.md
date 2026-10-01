# Codex navigation guide

Read README.md, AGENTS.md, and Architecture.md first. Tro is one pnpm root. Use exact-case imports and do not import sibling-repository source.

| Change             | Start here                                            | Verify                                       |
| ------------------ | ----------------------------------------------------- | -------------------------------------------- |
| UI                 | `src/desktop/renderer/App.tsx`                        | Renderer types and interaction               |
| Desktop capability | `Preload.ts`, `Main.ts`                               | IPC validation and sender restrictions       |
| Public response    | `src/contracts/SystemStatus.ts`                       | API/client/contract checks                   |
| HTTP               | `src/server/CreateApi.ts`                             | Versioned paths and route tests              |
| Workflow           | `src/server/application` or owning feature            | Port-based unit tests                        |
| Database           | `prisma`, `src/server/persistence`                    | Migration and adapter checks                 |
| Hosting            | `Dockerfile`, `railway.json`, `Deployment.md`         | Container/readiness; no automatic deployment |
| Local agent        | `src/desktop/worker`, `src/contracts/AgentSession.ts` | Worker startup, cancellation, IPC validation |

Renderer/preload cannot import backend or main-process implementation. Contracts cannot import desktop/server implementation. Domain code cannot import frameworks, I/O, or persistence. Prisma belongs in backend persistence adapters and Prisma config. Environment modules are per process.

For desktop styling, edit `src/desktop/renderer/Theme.ts`; it owns Mantine defaults and the shared palette. `App.css` owns layout using those tokens. See [DesktopUi.md](DesktopUi.md) for the scaffold and state ownership.

Import shared contracts as `#contracts/SystemStatus.js` from either process. Keep imports within a feature relative; the alias is deliberately limited to contracts.

`scripts/CheckBoundaries.ts` checks core ownership and filenames. Describe behavior, contract changes, migrations, and verification in review notes. State what is planned versus implemented. Do not publish, push, deploy, or start paid work without authorization.
