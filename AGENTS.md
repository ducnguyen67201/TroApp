# Tro repository instructions

## Read first and preserve boundaries

Read README.md and docs/Architecture.md before changing code. This repository is a standalone pnpm root; never import sibling-repository source. Preserve others' edits and keep changes scoped. Read docs/CODEX-NAVIGATION-GUIDE.md for ownership and common change paths.

Use Node.js and strict TypeScript with public contracts at boundaries and explicit application ports. Domain code has no framework or I/O imports. Keep a modular monolith; introduce shared packages, services, or event infrastructure only for demonstrated needs.

Code must build and pass unit tests without private code, cloud credentials, or a live database. Integration checks may use a disposable local PostgreSQL database. Independent consumers use the versioned HTTP API or a published SDK, not sibling source. Do not automatically publish, push, deploy, or change licensing.

## File naming — PascalCase

Use PascalCase for hand-written source, component, hook, script, test and documentation filenames: `AccessRequestsPage.tsx`, `OwnerApi.ts`, `AccessService.ts`, `UseAccessRequests.ts`, `CheckBoundaries.mjs`, `BrokerUrl.test.ts`, and `Architecture.md`. Do not use kebab-case or snake_case for these filenames. Keep conventional suffixes such as `.test.ts` and `.d.ts` lowercase. Hook function names still start with `use`; changing a filename does not change exported identifiers.

Keep tool-discovered/configuration names and standard project files unchanged, including `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `*.config.*`, `vite-env.d.ts`, `index.html`, `schema.prisma`, dotfiles, `AGENTS.md`, `README.md`, `SECURITY.md` and `CONTRIBUTING.md`. Do not rename generated files, applied migrations, frozen fixtures or local runtime data. This preference governs filenames, not folder names, package names or public import paths.

When renaming, update exact-case imports, package export targets, CLI/bin and build paths, HTML entrypoints, tests and documentation together. Preserve public package specifiers and wire contracts. Use an intermediate filename for case-only renames so Git records them correctly on case-insensitive filesystems. The filename tests enforce this preference for owned code and docs.

## Plain-language names

Write names as short, natural phrases a human can understand at the call site without opening the implementation. Name the task in the reader's vocabulary, not an internal algorithm or an abbreviation they must decode.

### Functions: action first, then what it acts on

Start function and method names with a specific verb, followed by the thing being acted on. Add a source, destination, condition, or result only when it removes ambiguity:

`verb + subject + useful context`

- `loadAgentConfigFromFile`: load what, and from where?
- `fetchBrokerConnections`: fetch which data?
- `approveAccessRequest`: approve what?
- `revokeExpiredGrants`: revoke which grants?
- `validateAndFormatBrokerUrl`: check which value, and what transformation happens?

These are naming examples, not a claim that every example function already exists.

Choose a verb that describes the actual behavior: `read` for reading, `fetch` for a network request, `parse` for converting a representation, `validate` for checking rules, `format` for changing presentation, and `save`, `send`, `approve`, or `revoke` for those specific actions. Do not hide writes or state changes behind a read-like name.

Avoid vague verbs such as `process`, `handle`, `manage`, or `normalize` when a more concrete action is available. `processRequest` does not tell the reader whether it validates, saves, sends, or approves a request. An event callback may use `handle` when the event is explicit, such as `handleApproveButtonClick`; the underlying operation should still have a specific action name.

### Boolean checks: read like yes/no questions

Use `is`, `has`, `can`, or another natural predicate such as `uses`:

- `isBrokerUrlAllowed`: is this broker URL allowed by the configured rules?
- `hasOwnerToken`: is an owner token present? This does not imply that it is valid.
- `canApproveAccessRequest`: can this request be approved under the rules being checked?
- `usesHttpsOrLocalHttp`: does the address use one of these allowed transports?

Prefer positive wording so conditions read naturally. Distinguish a boolean check from a validator that throws or returns a parsed value; document the failure behavior.

### Values and types: name the thing, not an action

Use descriptive nouns for variables, parameters, and types: `brokerUrl`, `agentToken`, `accessRequest`, and `BrokerConfig`. Use plural nouns for collections and include units when they matter, such as `accessRequests`, `timeoutMs`, and `ttlSeconds`.

Avoid unexplained shorthand such as `cfg`, `req`, or `val` in application logic. Standard terms such as URL, HTTP, and ID are fine. Preserve framework conventions, such as React component names and `use...` hooks, rather than forcing every identifier to start with an action verb.

### Read the call aloud before keeping the name

Ask: “Can a new teammate tell what this does, to what, and whether it checks, returns, or changes something?” If not, choose a clearer name. A slightly longer name is worthwhile when it adds meaning; do not turn names into paragraphs or repeat context already obvious from the caller.

Comments explain reasons and constraints; they should not be needed to translate the name. Keep established domain terms consistent, update callers/tests/docs when renaming, and do not change public API fields or wire formats merely for style. Never promise more than the implementation does: a URL check is not proof that a destination is safe.

## Type safety — no `any`

Keep type safety end to end: contracts, database adapters, services, SDK, CLI/MCP, React state/props/hooks, scripts and tests. Do not introduce explicit or implicit `any`, including `any[]`, `Promise<any>`, generic defaults or untyped mock implementations.

- Keep TypeScript strict mode, `noImplicitAny`, `useUnknownInCatchVariables`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled. Do not weaken checks to make a change pass.
- Treat untrusted JSON, HTTP responses, configuration files and caught errors as `unknown`. Validate with the owning Zod schema or narrow with a real type guard before reading fields. A type assertion or a response generic is not runtime validation.
- Derive shared types from their canonical schemas/constants; use Prisma-generated types only inside persistence adapters. Do not duplicate shapes that already have an owner.
- Give exported hooks and boundary functions clear return contracts. Keep component props and state typed; let callbacks infer their types from those contracts. If a map callback becomes implicit `any`, fix its upstream data/import/return type rather than annotating just that callback.
- Type test doubles against the real API, for example `vi.fn<typeof fetch>()`. Tests must not bypass the same safety requirements as application code.
- Prefer inference when it is precise, `satisfies` for checked object shapes, and narrowing for unions. Do not use `as any`, `as unknown as T`, unchecked assertions, non-null assertions or TypeScript/ESLint suppression comments to hide a type error.
- Keep new application code in TypeScript. Existing JavaScript tooling should use concrete JSDoc contracts for inputs and outputs when changed; do not spread library-provided `any` into owned code.
- Do not edit dependency declarations or generated clients to remove their internal `any`. Contain untyped third-party values at the adapter boundary as `unknown` and validate before use.

`pnpm typecheck` rejects implicit `any` in owned TypeScript, and `pnpm lint` rejects explicit `any` and unsafe assignments, arguments, calls, member access and returns in TypeScript, including tests. These checks supplement runtime boundary validation; compile-time types alone do not validate external data.

## Named constants for fixed domain values

Represent fixed sets of decisions, statuses, policies and error codes with descriptive `as const` objects, not repeated magic strings or separately maintained string-union types. Use a PascalCase name for the group and UPPER_SNAKE_CASE member names so call sites read clearly: `AccessDecision.APPROVE`, `AccessStatus.PENDING`, and `ConnectionPolicy.ASK`.

```ts
export const AccessDecision = {
  APPROVE: 'approve',
  DENY: 'deny',
} as const;

export type AccessDecision = (typeof AccessDecision)[keyof typeof AccessDecision];
```

Derive the TypeScript union from the constant object and use that type in function signatures. Build Zod enum schemas from the same object, such as `z.enum(AccessDecision)`. Keep decisions, lifecycle states and audit events separate even when some string values happen to match. Prefer this pattern over introducing TypeScript `enum` or `const enum` for new hand-written domain value sets.

Place values with their owner, not in a global constants dumping ground. Public vocabulary shared by desktop and API belongs in src/contracts; local-only actions/errors stay in their feature. Domain code may import framework-free contract values but must not import Prisma-generated enums. Independent consumers must not deep-import sibling source to share constants.

Preserve existing serialized strings and database values when applying this pattern. Do not rewrite applied migrations or generated Prisma code; use compatibility tests to keep database enums and public values aligned. Literal strings remain appropriate in the canonical declarations, independent wire-contract/legacy fixtures, user-facing text and third-party protocol values. Do not extract every string indiscriminately. `as const` gives compile-time readonly literal types; it is not runtime freezing or a security boundary.

## Small functions and discoverable helpers

Extract non-obvious validation or a distinct reusable responsibility into a small, clearly named function. Avoid dense inline conditions and deeply nested expressions when a named helper makes the caller easier to read. Do not split obvious statements into unnecessary layers.

Keep helpers with their owning feature/package in descriptive files, such as `validation/BrokerUrl.ts`. Do not create catch-all `utils.ts`, `helpers.ts`, or generic common packages. Keep local implementation helpers unexported. Promote code into a focused shared package only after multiple real consumers need the same semantics; use explicit package exports. See docs/Architecture.md for the ownership map.

## Readable formatting

Keep blank lines between functions, class methods, exported declarations, and logical blocks. Group closely related short variable declarations together. Always use braces for conditionals and loops. Do not compress blocks or remove meaningful spacing to save lines.

Prettier handles layout; ESLint handles the additional spacing and braces rules. Run `pnpm format` to apply both. `pnpm lint` and `pnpm format:check` enforce the result. Preserve repository-local format-on-save settings.

## Useful block comments

Use `/** ... */` above important APIs/classes for responsibilities and contracts, and `/* ... */` for non-obvious implementation decisions. Explain why, ownership/trust boundaries, invariants, units, side effects, and limitations where useful. Editors show JSDoc on hover.

Keep comments next to the code they explain and update them when behavior changes. Do not narrate obvious statements, require boilerplate on every function, or leave commented-out code. Comments supplement clear names and tests; they must not claim unimplemented security guarantees.

## Supported APIs and validated configuration

Do not use deprecated APIs or suppress deprecation warnings. Typed ESLint enforces `@typescript-eslint/no-deprecated` across TypeScript and JavaScript tooling. Use Zod's supported top-level `z.url()`, `z.uuid()`, and `z.strictObject()` APIs; preserve validation semantics when migrating dependencies.

Environment settings belong in each process's `Env.ts` module using `@t3-oss/env-core`. Application logic consumes validated values rather than reading `process.env` directly. Do not bypass validation, log validation inputs, or import server env modules into the browser console.

Load environment validation lazily inside startup error handling. Tests inject environment objects instead of changing global `process.env`. Integration harnesses may forward the process environment to child processes. T3 Env validates supplied values; it does not inject secrets or automatically load `.env` files. Validate JSON file contents separately in the owning configuration module.

## Typed database access

Use Prisma models and generated types for database access, not handwritten SQL queries or direct SQLite driver calls in application code. Keep Prisma inside persistence adapters; application/domain layers depend on their own ports. Await database operations and use the transaction-scoped client for every write that must commit together, including audit records.

Keep schema changes in reviewed, versioned Prisma migrations. SQL migration artifacts and frozen legacy test fixtures are allowed; raw application queries are not. Do not edit generated clients, rewrite applied migrations, reset existing databases, or silently discard data. Document and test any legacy-data upgrade. Prisma and database credentials belong on the backend, never in Electron.

## Security and current product limits

Keep signed-in user authorization separate from permission for an agent to act. Do not add secrets, real browser profiles, or credentials. The initial starter only reports service readiness; it does not implement authentication, agent runs, try-on, or protected browser execution. Never claim a planned capability exists.

The React interface runs in Electron's sandboxed renderer. Expose narrow, validated methods through preload; do not expose generic IPC, shell execution, arbitrary URLs, filesystem paths, or database access. Verify the IPC sender. Run future local agent orchestration in a separate worker, not the renderer or UI event loop. Local orchestration still requires a remote model API or a separately supported local model.

Keep shared OpenAI and try-on provider keys on the backend. A future local Agents SDK uses an authenticated model gateway or an explicitly supported user-owned key stored in OS-protected storage. Screenshots and user photographs must not enter ordinary logs. Hosted agents and paid model gateways require authentication, usage limits, and action-specific approval before public release.

Never log credentials, raw configuration, or sensitive validation details. Formatting and helper refactors must preserve existing authorization and validation behavior.

## Diagnose uncertainty with targeted logs

When a failure's cause is unknown or uncertain, add a bounded structured log at the owning boundary before guessing at a fix. Record the operation/stage, safe input fields, validated output, rejection reason, timing and relevant correlation IDs. For visual guidance, include cue geometry and local comparison measurements so a rejected drawing can be traced to the failing region. Distinguish facts from hypotheses and missing diagnostics from proof that nothing happened.

Use the existing development exchange logger for content traces and concise warning/error events for failures. Never log screenshots, raw pixels, typed key contents, credentials, raw configuration or hidden model reasoning. Keep logs event-driven; do not dump repeated observer polls. Test the diagnostics and document how to read the new event. Logging adds evidence; do not silently change behavior while instrumenting a failure.

## Verification — final step only

Finish the entire requested implementation before running validation. Complete all related code, imports, tests, and documentation edits first, including updates required by helper renames. Do not run lint, formatting checks, type checks, tests, builds, or integration checks between intermediate implementation edits.

As the final step before handoff, run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test` for code changes. Also run `pnpm build` and `pnpm test:integration` when runtime wiring, packaging, or end-to-end behavior changes.

If final validation reveals failures, finish the necessary fixes, then rerun the affected checks before handoff. Report the results and any checks not run; never claim validation passed without running it.
