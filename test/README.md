# Tests

Test folders mirror `src/` so a production module and its tests share the same relative location. For example, `src/server/auth/FetchModelResponse.ts` is covered by `test/server/auth/FetchModelResponse.test.ts`.

- `pnpm test` discovers `test/**/*.test.ts`, excluding integration tests.
- `pnpm test:integration` discovers `test/**/*.integration.test.ts` against a disposable local PostgreSQL database.
- `pnpm test:teaching` builds the production desktop boundary and runs the fixtures in [desktop/worker/teaching/flow](desktop/worker/teaching/flow/TeachingFlowApp.ts).
- `pnpm test:teaching:native` adds the real macOS capture boundary check.

Tests import production modules directly, and mocks use those same source paths. TypeScript, ESLint, filename rules and ownership checks cover this tree. Production modules cannot import test code.
