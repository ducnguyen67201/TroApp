# Student pet implementation plan

Status: phased plan. The initial local implementation is recorded in [StudentPetEngineering](StudentPetEngineering.md); signed platform checks and later phases remain pending. This plan accompanies [StudentPetSpec](StudentPetSpec.md); it does not authorize publishing, deployment, or paid provider calls.

## Delivery strategy

Ship the local bundled-pet experience first. Keep the asset interface compatible with generated single-image pets, but defer cloud jobs and persistence until the interaction works on target platforms. Each phase is a complete implementation slice with its own final validation; do not run checks between intermediate edits within a slice.

## Phase 0 — Prove desktop interaction

Implement a minimal packaged overlay experiment with one local raster pet, click reaction, drag, hide and display clamping. Load only app content through a dedicated restricted preload. Establish whether the overlay can receive deliberate clicks while preserving the underlying app's typing focus and passing through transparent padding.

Check macOS and Windows at different display scales, monitor removal, app switching, OS menus and fullscreen transitions. Measure visible clipping and safe placement geometry if behavior is uncertain. Do not change the Cua driver during this experiment.

Exit: a documented platform decision and verified interaction behavior. If a platform fails, choose an in-app first release and state the limitation before implementing the full desktop adapter.

## Phase 1 — Bundled catalog and local pet

### Implementation

1. Define canonical constants/schemas in `src/contracts/Pet.ts`: manifest, preferences, bounded commands and snapshots. Keep appearance, ownership and active selection distinct.
2. Add three licensed bundled raster asset packs and a catalog. Implement manifest validation, immutable ID resolution, fallback states and build resource staging.
3. Implement `PetController`, `PetWindow`, `PetPreferences` and `PetAssets` under desktop main. Main owns timers, position, persistence and lifecycle; the overlay owns animation rendering.
4. Add a dedicated overlay preload and named gallery operations to the appropriate bridge. Restrict operations by sender and resolve assets through a fixed allowlisted scheme.
5. Add `PetOverlay`, `PetGallery` and `UsePets`; connect the gallery to Settings. Include preview, name, adopt/switch, pet/slap, drag, hide, quiet and reduced motion controls in both supported locales.
6. Compose startup/cleanup in `Main.ts`. Do not start an agent, driver, model session or OS permission request for the pet. Fence asynchronous loads across account change/disposal.
7. Stage assets in Electron builds and update feature/navigation documentation.

### Acceptance and verification

Cover invalid manifests, missing animations/assets, preference recovery, account separation, placement after display removal, rapid reactions, sender restrictions and late callbacks after disposal. Test gallery adoption and accessible controls. Use fixtures for screen/display geometry.

Run final lint, formatting, types, unit tests, build and integration checks. Perform packaged platform smoke checks, including resource loading offline, repeated sign-in/out and typing into another app while interacting with the pet.

Exit: three selectable pets, one active pet, saved preferences, reliable interaction and no model/provider dependency. Any unsupported platform behavior is explicitly documented.

## Phase 2 — Status and encouragement

### Implementation

1. Add read-only event adapters from existing voice/task controllers. Reuse canonical statuses; do not invent success from elapsed time.
2. Add guidance presentation suppression at the owning teaching boundary if required. Keep pet visibility separate from teaching outcome/evidence.
3. Implement deterministic message priority, task/session deduplication, stale-event fencing and bounded cooldowns with an injected clock.
4. Add curated English/Vietnamese encouragement and neutral outcome messages. Quiet mode suppresses optional bubbles; guidance and voice capture suppress movement/encouragement.
5. Add bounded diagnostics for rejected/stale events and presentation failure; document the event meanings.

### Acceptance and verification

Test success versus partial/blocked/unverified/canceled messages, cooldown limits, rapid progress, suppression/resume, locale changes and disposal. Check that no event causes a model request. Run the required final checks plus build/integration for new runtime wiring; run teaching flow checks when teaching presentation wiring changes.

Exit: useful messages reflect actual state and do not obstruct guidance or capture.

## Phase 3 — Customization and collection model

### Implementation

1. Add validated palette/accessory options for compatible bundled packs. Do not recolor arbitrary generated images unless explicitly supported.
2. Introduce owned pet instances separate from catalog definitions; each instance has an opaque ID, source, name and appearance options.
3. Provide collection sorting, rename, switch and delete flows. Treat bundled packs as reusable templates; deleting an instance does not delete packaged assets.
4. Version the local preference/collection format and preserve earlier selections through an explicit migration.

### Acceptance and verification

Test multiple instances from one template, migration, deleting an active instance, incompatible options and persistence across restart. Run final code checks; include build/integration if storage/startup wiring changes.

Exit: students can make distinct personal pets and maintain a collection while one remains active.

## Phase 4 — Prompt-generated pets

### Prerequisites

Choose the image provider and private storage, verify current APIs and pricing, and define generation allowance, retention and moderation rules. Prepare a concrete provider integration before requesting any necessary approval for paid live calls. Use fake adapters for local development and automated verification.

### Implementation

1. Define `PetGeneration.ts` contracts and versioned routes with authentication and owner checks.
2. Add reviewed Prisma migrations for generation jobs, owned generated pets, allowance reservations, idempotency and cleanup records. Keep Prisma types inside adapters.
3. Implement transactional admission and one-active-job enforcement behind ports. Configure provider/storage/allowance values in backend `Env.ts` with lazy startup validation.
4. Implement a durable lease-based runner with bounded concurrency, deadlines, provider ID persistence and restart recovery. Separate safe retrieval retries from paid submission reconciliation.
5. Implement the chosen provider adapter and normalization pipeline. Validate format, decoded pixels, alpha, dimensions and size; strip metadata; checksum immutable results before publication.
6. Publish the owned pet and succeeded job transactionally after storage succeeds. Recover orphaned uploads and deletion failures without exposing invalid assets.
7. Add main-owned authenticated API access, bounded job polling, verified asset download/cache, and account-change fencing. Preserve offline access to verified pets.
8. Add Create pet UI: appearance prompt, style, allowance, progress, error/retry explanation, animation preview, name and explicit adoption. New generation output never silently replaces the active pet.
9. Add owner-scoped deletion and recoverable storage cleanup. Document retention and whether cancellation may still incur usage.

### Acceptance and verification

Use fake provider/storage and disposable PostgreSQL to test concurrent admission, duplicate keys, mismatched replay inputs, quota exhaustion, cross-account access, leases after restart, ambiguous submission, validation failure, orphan cleanup, deletion and stale account responses. Test desktop download corruption/offline fallback and preview-before-adoption.

Run lint, formatting, types, unit tests, build and integration checks as the final automated step. Live provider generation and signed installed-app smoke tests are separate acceptance evidence; do not claim they passed from fixture tests.

Exit: a student can generate, preview, save, adopt and delete a personal pet with bounded cost and durable recovery.

## Phase 5 — Optional full animation packs

Proceed only after students use generated pets and request richer motion. Evaluate character consistency, frame alignment, transparent edges, cost and generation latency using an explicit acceptance set. Extend the existing manifest compatibly, preserving single-image fallbacks. Preview all generated animations before adoption.

Exit: accepted consistent animation packs; otherwise retain procedural single-image pets.

## Handoff requirements

For each delivered slice, list implementation files, behavior, public contract changes, migrations, completed checks and remaining platform/provider evidence. Required final commands for code changes are `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`; runtime wiring/packaging also requires `pnpm build` and `pnpm test:integration`. Finish fixes before rerunning affected checks.

Use scoped formatting on edited files to preserve unrelated work. No push, publish, deployment, licensing change or paid job follows automatically from completing this plan.
