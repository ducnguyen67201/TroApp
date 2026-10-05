# Student pet engineering specification

Status: design specification. The initial bundled-pet runtime is implemented in [StudentPetEngineering](StudentPetEngineering.md); generated pets and later collection/customization phases remain planned. Signed platform acceptance remains pending.

## Product outcome

Give students a playful desktop pet they can choose, name, move, pet, or playfully slap. The pet occasionally encourages them and can show real Tro task status. Students can collect multiple pets and later generate their own appearance. Start with one active pet so the feature remains compatible with focused work.

The pet is a separate presentation feature from the teaching cursor. It consumes bounded application events; it does not inspect the screen, judge attention, control the computer, or run an agent. No idle behavior requires a model request.

## Scope and defaults

- First delivery: three bundled pets, chooser and preview, naming, adoption, saved preferences, idle animation, pet/slap/drag interactions, hide and quiet controls.
- Next delivery: actual voice/task status and curated encouragement in English and Vietnamese.
- Creation: names and palettes first, then prompt-generated transparent character images with shared procedural animation.
- Defer full generated sprite animation, public sharing, trading, multiplayer, classroom administration, and simultaneous active pets.
- Proposed defaults: disabled until adoption, parked near a screen edge, one active pet, silent, no cursor following, encouragement enabled with a long cooldown, reduced motion inherited from the OS with an explicit override.
- Cursor following is optional later. Use a supported read-only pointer source; do not start Cua or request desktop permissions solely for the pet.
- Do not infer distraction from pointer inactivity. Any future focus timer must be explicitly started by the student.

## Student flows

### Choose and interact

Settings gains a Pets entry opening a gallery. Selecting a pet shows an animated preview, editable name, and Adopt action. Adoption saves the choice and shows the overlay. Switching pets preserves each owned pet's name and appearance.

A primary click triggers a happy reaction. A contextual Slap action triggers a short squash/bounce reaction without health loss or punishment. Dragging moves the overlay and saves a bounded display-relative position on release. A context menu offers Pet, Slap, Quiet mode, Choose pet, and Hide. Settings provides keyboard-accessible equivalents and an accessible preview; the overlay must not steal typing focus.

### Generate

Create pet accepts a short appearance prompt and preset style. The student sees the applicable allowance before submitting. A job produces one normalized transparent character image. The student previews its idle and reaction animation, chooses a name, and explicitly adopts it. Regeneration is a new admitted job, not an automatic retry loop.

A completed generation adds a pet to the collection without replacing the active pet. Leaving the creation dialog does not cancel a durable job. Errors retain the current pet and any completed previews. A deleted pet disappears from its owner's gallery; deleting the active pet selects a bundled fallback or hides the overlay.

## Architecture and ownership

| Proposed owner                             | Responsibility                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/contracts/Pet.ts`                     | Versioned asset definition, preferences, commands, snapshots and fixed value constants |
| `src/contracts/PetGeneration.ts`           | Generation request, job lifecycle and safe public errors                               |
| `src/desktop/main/pets/PetController.ts`   | Active pet, event reduction, timers, presentation and cleanup                          |
| `src/desktop/main/pets/PetWindow.ts`       | Small transparent Electron window, placement, interaction regions and display changes  |
| `src/desktop/main/pets/PetPreferences.ts`  | Validated atomic local preference storage                                              |
| `src/desktop/main/pets/PetAssets.ts`       | Bundled catalog and verified generated asset cache                                     |
| `src/desktop/renderer/pets/PetGallery.tsx` | Collection, preview, customization and adoption                                        |
| `src/desktop/renderer/pets/PetOverlay.tsx` | Asset rendering and local animation                                                    |
| `src/desktop/renderer/pets/UsePets.ts`     | Typed bridge view for gallery and controls                                             |
| `src/server/features/pets`                 | Generation admission, jobs, asset ownership and provider/storage ports                 |
| `src/server/persistence`                   | Prisma job, collection and allowance adapters                                          |

Names are proposed, not existing APIs. Mirror production ownership under `test/`. Keep feature-local helpers local and shared runtime contracts framework-free. Use derived constant unions and owning Zod schemas; no `any` or unchecked external data.

Electron main owns the pet independently of `AgentChatController` and its utility worker. Main composes pet lifecycle with sign-in, sign-out, application window closure, and shutdown. Disposing the pet never disposes a task worker, HUD transport, or embedded driver. `DesktopCompanion` remains the cursor/HUD composition owner; do not couple pet startup to its permission gate.

Read-only adapters forward existing voice/task state to the pet. Add a narrow presentation suppression signal at the teaching owner if existing events do not expose guidance visibility. Never modify teaching completion evidence to accommodate the pet.

## Overlay decision and platform gate

Use a dedicated sandboxed Electron renderer loaded from packaged app content, with context isolation and Node integration disabled. Expose only the pet-specific preload surface to this renderer. Render a small window around the pet and bubble instead of a desktop-sized transparent window.

Electron supports transparent windows, always-on-top placement and mouse-event pass-through. These APIs do not prove correct focus, fullscreen, or hit testing on each target platform. Complete an early macOS/Windows packaged spike before committing to this adapter. Reference: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window).

Requirements:

- Showing, reacting, or moving the pet never activates it or interrupts typing in another app.
- Only intended pet/menu interactions consume clicks. Transparent padding does not block underlying content.
- OS-owned menus/fullscreen behavior is respected; do not use extreme window levels.
- Dragging is initiated inside the pet; main clamps placement to a valid display work area.
- Display removal, scaling changes and stale saved positions return the pet to a visible edge.
- Hide pauses animation and timers. Renderer crash hides the pet and reports a bounded error; avoid repeated restart loops.
- Sign-out, window closure and shutdown destroy the pet window and clear subscriptions/timers.

If platform behavior fails the spike, ship an in-app pet first and record the desktop limitation. A native adapter is a separate decision, not an implicit Cua patch.

## Asset format and animation

All appearances use one engine. A version-one manifest contains an opaque pet ID, catalog version, display name, image dimensions, anchor, bounded hit region, asset references and available animation states. Generated assets also carry provenance and owner-visible creation metadata. Runtime references use asset IDs resolved by main; manifests cannot supply filesystem paths, scripts, HTML, SVG or arbitrary network URLs.

Bundled packs can contain approved raster sprite sheets. Generated version-one pets contain a single transparent PNG or WebP. Shared transforms implement breathe, bob, tilt, bounce, squash and sleep without generating separate inconsistent character poses. Missing optional animations fall back to idle. Full generated animation packs require a later format-compatible extension and consistency validation.

Proposed ingestion limits: 512 × 512 normalized character image, 2 MiB per normalized image, 16 MiB total per pack, 16 supported frames per animation, and 2,048 pixels per sprite-sheet dimension. Bound dimensions and decoded pixels before allocation; reject unsupported types and oversized inputs. These are initial engineering limits to tune during the asset spike.

Normalize orientation, remove metadata, verify transparency, compute a checksum and publish only the validated immutable artifact. Bounds/anchors must match the normalized image. Avoid clipping reactions by reserving bounded padding. A single-image pet does not promise articulated walking.

## Behavior and useful information

Keep animation and message selection deterministic and local. Separate lifecycle (hidden, visible, disposed), reaction (idle, happy, startled, sleeping) and application status (idle, listening, working, needs input, settled). Switching pets cancels old reactions; generation counters fence late callbacks after hide/disposal.

Proposed timing defaults:

- Click reaction: at most one second; repeated clicks coalesce rather than queue.
- Encouragement: at least ten minutes between messages, maximum three per hour, bubble visible at most five seconds.
- Application transitions take precedence over encouragement; repeated progress events do not restart bubbles.
- Quiet mode disables optional messages. Reduced motion uses static poses and brief opacity transitions.
- Guidance and voice capture suppress optional bubbles and movement. The existing HUD retains voice/task detail; do not duplicate its meter or long guidance.

Use only actual application events. Success-specific praise requires a succeeded result. Partial, blocked, canceled and unverified outcomes receive accurate neutral language. Curated encouragement is supportive, not an attention diagnosis. Deduplicate task IDs and fence stale session events.

## Narrow bridge and local state

Proposed named operations: `readPets`, `adoptPet`, `savePetPreferences`, `reactToPet`, `hidePet`, and `subscribePet`. Generation later adds `createPetGeneration`, `readPetGeneration`, `deletePet`, and a collection refresh operation. The overlay receives only its current asset and snapshot plus bounded interaction commands; it does not receive auth cookies or the full desktop bridge.

Validate requests and responses with canonical schemas. Verify the sender against the exact authorized main/overlay frame for each operation; loading app content alone does not grant every IPC permission. Main resolves asset IDs through a fixed local scheme with an explicit allowlist. No arbitrary URL navigation, filesystem reads, shell operations or database access is exposed.

Preferences are local per signed-in account: enabled, active pet ID, display-relative placement, quiet mode, reduced motion override and optional following mode. Never use raw email as a filename. Persist on explicit changes/drag end using atomic replacement. Validate on read; corrupt preferences fall back safely without overwriting a valid generated collection. Generated collection metadata belongs on the backend; desktop caches verified assets for offline use. Bundled pets remain usable without provider credentials or backend availability after normal app access.

## Backend generation design

Use versioned authenticated HTTP endpoints under `/v1/pets`: list collection, create/read generation job, adopt/save generated metadata where needed, delete owned pet, and obtain short-lived asset access. Final route spelling must match current API conventions. Local pet adoption/preferences do not require a backend write.

`CreatePetGeneration` depends on explicit allowance, repository, provider and private storage ports. Desktop accesses the backend through main; provider credentials live in backend `Env.ts`. Image generation is a separate provider capability, not an assumption that the existing Responses gateway supports it.

Proposed job states: queued, running, validating, succeeded, failed, canceled. Cancellation is best effort and does not promise reversing provider charges. A success transaction creates exactly one owned pet and links it to its job. Use reviewed Prisma migrations; no raw application SQL.

Admission transaction enforces ownership, a unique account/idempotency-key pair, one active generation per account, and configurable daily allowance/cost limits. Reusing a key with different input is rejected. Replaying the same request returns the original job and does not reserve allowance twice. Provider limits and price must be verified when selecting the adapter; no paid generation is run as part of this plan.

Start with a durable database-backed job runner in the backend deployment and bounded polling in the desktop. Claim work with transaction-protected leases, record provider IDs, and recover expired leases. Multiple instances must not process one job concurrently. Do not hold database transactions across provider or storage calls.

For uncertain provider submission outcomes, reconcile with the provider when supported; otherwise fail with an actionable ambiguous outcome and prohibit blind automatic resubmission. Poll/retrieval retries can be bounded separately from paid submission. A lease alone does not guarantee exactly-once provider billing.

Prompts describe appearance only and have bounded length. Apply the chosen provider's moderation and product content rules before publishing an asset. Avoid photographs/student identifiers in the initial creation flow. Keep prompt/image contents out of ordinary logs. Storage is private with short-lived authorized retrieval. Stream bounded downloads, validate bytes/checksums in main, and atomically cache immutable assets. Never load remote HTML into the overlay.

Delete access immediately in the database, then remove storage asynchronously with recoverable cleanup. Generation outputs not adopted are still owned collection items; define a documented retention policy before public release. Sharing or a community catalog requires a separate moderation and consent design.

## Diagnostics and failure handling

Log safe event names, stage, job/task correlation IDs, timings, error categories and asset format validation outcomes. Never log raw prompts, images, screenshots, user names, credentials or raw configuration. Overlay diagnostics include safe placement geometry and display scaling when investigating hit testing or clipping.

Missing assets select a bundled fallback with a visible gallery message. Download failures preserve the previous verified cache. Backend/generation outages do not remove the active pet. Collection requests are account-scoped; sign-out fences pending responses so another account cannot adopt stale output.

## Acceptance criteria

- Three distinct bundled pets can be adopted, renamed and switched without code changes to the animation engine.
- One active pet and multiple collected pets are represented separately.
- Clicking/slapping/dragging works without typing-focus theft or accidental underlying clicks.
- Hide, quiet mode, reduced motion, account changes and display removal behave predictably.
- Teaching previews, voice capture, task cancellation and completion evidence remain unchanged.
- Idle animation and encouragement produce no model calls and require no new screen/input monitoring.
- Generated single-image pets use the same engine, survive restart, and can be previewed before adoption.
- Duplicate admission does not create duplicate jobs or allowance reservations; ambiguous provider outcomes never trigger blind resubmission.
- Sender restrictions, invalid assets and cross-account reads/deletes are rejected.
- Signed macOS and Windows smoke tests cover overlay interaction and packaging before claiming desktop support.

## Decisions deferred to delivery

Select the image provider and verify capability, moderation, pricing and recovery semantics. Select private object storage and define retention/deletion windows. Validate the proposed limits and encouragement cadence with students. Class-specific information remains out of scope until Tro has an authoritative classroom context source.
