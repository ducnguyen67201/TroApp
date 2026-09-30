# Development workflow

## Start locally

The repository is its own pnpm root and does not consume sibling projects. Local development
requires:

- Node.js 24 and pnpm 11 (the versions declared by `.nvmrc` and `package.json`)
- Docker Desktop, including the Docker Compose v2 plugin
- the Doppler CLI, authenticated with access to the Tro development config

The expected Doppler target is project `tro`, config `dev_local`. A workspace administrator must
create and manage that config; this repository never creates or changes hosted Doppler values. It
must contain:

- `APP_ENV=dev`
- `DATABASE_URL=postgresql://tro:<local-password>@127.0.0.1:54329/tro`
- any backend-only provider settings required by the feature being developed

The credentials must match the Compose service. The PostgreSQL scheme, loopback host, port `54329`,
and database `tro` are enforced before development migrations can run. Do not put Doppler tokens
or resolved secrets in `.env` or commit them.

For first-time setup:

```sh
node --version
pnpm --version
docker --version
doppler --version
doppler login
pnpm install
pnpm dev
```

`pnpm dev` performs these operations in order:

1. Validate Node, pnpm, Docker/Compose, the Docker daemon, and Doppler authentication.
2. Resolve `tro/dev_local` only inside a backend validation child; no secret values are printed.
3. Run `docker compose up --detach --wait postgres` and wait for the declared health check.
4. Run the guarded `prisma migrate dev` through Doppler, then generate the Prisma client.
5. Supervise the Doppler-backed API and secret-free desktop processes together.

The Compose startup and Prisma migration are idempotent. Ctrl-C terminates both application
processes; it does not stop PostgreSQL or remove the `tro-postgres` volume. Use `pnpm db:stop` when
you want to stop PostgreSQL while retaining its data.

The API binds to `127.0.0.1:3000` locally. PostgreSQL binds to `127.0.0.1:54329`. The desktop main process calls the API; the React renderer has no generic network or database bridge. Development reload is handled by electron-vite and Node's watch mode with tsx.

Pino emits debug records only in `dev`, while operational info and errors remain available in all modes. The API defaults to the local host and port, and the desktop defaults to the local API. `ELECTRON_RENDERER_URL` is supplied by electron-vite during development; you do not set it yourself.

Backend settings, including `DATABASE_URL`, Doppler authentication, and provider keys, are removed
from the desktop child environment. Only `MAIN_VITE_API_BASE_URL` and `MAIN_VITE_APP_ENV` are
accepted as public build settings; arbitrary `MAIN_VITE_*` or `VITE_*` values are not forwarded.
Copy `.env.example` to `.env.local` only when overriding those public desktop defaults.

Teams using a different Doppler project or a per-developer branch config may set
`TRO_DOPPLER_PROJECT` and `TRO_DOPPLER_CONFIG` before `pnpm dev`. Config overrides must be `dev` or
start with `dev_`/`dev-`; staging and production names are rejected. Explicit CLI flags ensure an
ambient Doppler scope cannot silently select another environment.

## Startup recovery

The bootstrap fails before launching either application and prints the relevant recovery action:

| Failure                         | Recovery                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Unsupported Node or pnpm        | Select Node 24 and pnpm 11, then rerun the command.                           |
| Missing Docker/Compose          | Install or enable Docker Desktop and Compose v2.                              |
| Docker daemon unavailable       | Start Docker Desktop.                                                         |
| Missing Doppler CLI             | Install the CLI from Doppler's official installation guide.                   |
| Doppler authentication rejected | Run `doppler login`.                                                          |
| Project/config unavailable      | Confirm access to `tro/dev_local`, or set the documented overrides.           |
| Unsafe database target          | Correct `APP_ENV` and `DATABASE_URL`; never bypass the guard for hosted data. |
| PostgreSQL unhealthy            | Run `docker compose logs postgres`, correct the problem, and retry.           |

## Manual startup fallback

If orchestration itself needs debugging, run the same guarded sequence in separate terminals. This
fallback still uses Doppler only around commands that require backend settings:

```sh
docker compose up --detach --wait postgres
doppler run --project tro --config dev_local -- pnpm db:migrate
pnpm db:generate
```

Then start the API in one terminal and the desktop in another:

```sh
doppler run --project tro --config dev_local -- pnpm dev:api
```

```sh
pnpm dev:desktop
```

For an overridden development project/config, substitute the same names in each Doppler command.
The migration wrapper performs the local-target check again. Never replace it with a direct
`prisma migrate dev` against staging or production.

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
