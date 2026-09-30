# Development workflow

## Start locally

Use Node.js 24 LTS and pnpm 11. The repository is its own pnpm root and does not consume sibling projects.

```sh
pnpm install
cp .env.example .env
pnpm db:start
pnpm db:migrate
pnpm dev
```

The API binds to `127.0.0.1:3000` locally. PostgreSQL binds to `127.0.0.1:54329`. The desktop main process calls the API; the React renderer has no generic network or database bridge. Development reload is handled by electron-vite and Node's watch mode with tsx.

The local `.env` needs only `DATABASE_URL`. Optional `APP_ENV=dev|stage|prod` selects the backend application mode; it defaults to `dev`. Pino emits debug records only in `dev`, while operational info and errors remain available in all modes. The API defaults to the local host and port, and the desktop defaults to the local API. `ELECTRON_RENDERER_URL` is supplied by electron-vite during development; you do not set it yourself.

The database can be unavailable without preventing the app from starting. Click **Check connection** to see backend and database status. This does not exercise authentication, paid AI, images, or automation.

## Make one feature easy to follow

1. Define its request/response schemas in `src/contracts`.
2. Implement the application workflow using small ports.
3. Put Prisma and providers behind adapters in the owning feature.
4. Add an HTTP route with runtime input validation and backend authorization.
5. Expose a narrow desktop bridge method and update the screen.
6. Finish meaningful tests, migrations, and documentation before final validation.

Prefer `createTryOnJob` over `processRequest`, `canRunAgent` over vague flags, and `TryOnJob.ts` over catch-all helpers. Use your exact naming and spacing rules in AGENTS.md.

## Validation

```sh
pnpm format
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
```

Unit tests need no credentials or database. Integration checks create, migrate, test, and remove a disposable PostgreSQL container, without using `.env` or its database target. Docker must be running. Do not weaken checks or claim tests passed without executing them.

`pnpm db:stop` stops the local development database and preserves its volume. Do not run reset commands against a database containing real data.

## Desktop packaging

Set `MAIN_VITE_API_BASE_URL` to the public HTTPS backend URL before building, then run `pnpm package:desktop` on the target operating system. This is the only desktop API URL setting; Vite embeds it in the build, so changing it requires a new build. The desktop defaults to `dev` during development and `prod` when packaged; set public `MAIN_VITE_APP_ENV=stage` for a staging build. This command does not publish artifacts. Windows and macOS signing, macOS notarization, installer smoke tests, and updater configuration remain release work. Desktop builds contain public settings, never database credentials or shared provider keys.

`build:desktop` bundles the main/preload dependencies and writes a minimal generated `out/package.json`. The packager uses `out` as its application root, so backend code, Prisma, and backend dependencies are excluded from the desktop artifact.
