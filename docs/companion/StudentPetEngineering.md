# Student pet implementation

The first local release is implemented: three bundled pixel pets (cat, fox and slime), a Settings → Pets gallery, names saved per pet/account, one active desktop pet, click and playful slap reactions, drag placement, hide, quiet mode and reduced motion. Prompt-generated pets and cloud collections remain planned in [StudentPetPlan](StudentPetPlan.md).

## Ownership

`contracts/Pet.ts` owns canonical IDs, command/snapshot schemas, bounded placement and preferences. `main/pets/PetController.ts` owns state, timers and account epochs through injected persistence, presentation and clock ports. `PetPreferences.ts` writes validated local JSON with atomic replacement and opaque hashed account filenames. Failed saves do not update active selection.

`PetWindow.ts` adapts a small transparent, unfocusable Electron window. Main computes a fixed circular interaction region from OS pointer coordinates. Transparent padding passes clicks through using Electron's forwarding API; the bubble is passive. The adapter uses `showInactive`, does not start Cua or request OS permissions, and clamps placement to a display work area. During a deliberate drag, pointer sampling runs locally for at most ten seconds and ends on pointer-up, cancellation or hide. Saved display-relative ratios recover after monitor removal/scaling changes.

The workspace and overlay use one self-contained preload bundle to avoid shared CommonJS chunks that Electron's sandbox cannot load. Main supplies `--tro-pet-overlay`; that window receives only `readPet`, `subscribePet` and `interactWithPet`. The workspace receives named read/control/subscription methods. Main verifies the sending window, exact main frame and document URL for both surfaces. The overlay uses a separate nonpersistent session partition with all permission requests denied.

`renderer/pets/PetSprite.tsx` shares raster assets and animation between preview and overlay. The three project-authored PNGs under `desktop/assets/pets` are bundled by Vite; no external pack, image upload, remote URL or generated asset is admitted in this release. The closed catalog is smaller than the proposed general asset-pack format. Per-pet names are saved; creating multiple instances of one template remains phase three.

## Behavior and lifecycle

Petting produces an 800 ms bounce; right-click produces an 800 ms squash. Rapid reactions replace the previous timer. Settings includes keyboard-accessible Pet and Playful slap actions. No health/punishment mechanic exists. Quiet mode disables encouragement. Otherwise one curated localized message appears after ten visible idle minutes for five seconds. Hide, suppression and sign-out cancel timers. Reduced motion disables animation; system reduced-motion preferences are honored by CSS.

Main hides the pet while the chat controller is busy or voice capture is preparing, recording or finalizing. Teaching and voice HUD ownership/evidence remain unchanged. The pet consumes no screen images and makes no model requests. Sign-out and workspace closure invalidate pending reads/saves and destroy the overlay. An overlay load/crash failure is reported and stays hidden until an explicit preference/adoption action retries it.

The pet's encouragement language is saved with the adoption/preferences command from the gallery. Changing the app language takes effect on the pet when its next preference or adoption is saved.

## Diagnostics

`pet.preferences.failed` reports `stage: read`, `save` or `placement`, without identifiers, paths, names or raw data. A missing preference file defaults silently; corrupt/unreadable files default with a warning and remain intact until a later explicit save. `pet.presentation.failed` reports `stage: overlay`. The gallery displays a save or presentation failure and allows retry. No prompt, image, screen capture, credential or raw configuration enters these events.

## Verification and remaining acceptance

Tests cover account changes during loads/saves, serialized changes, failed saves, reactions/cooldowns, suppression, disposal, corrupt preference recovery, display placement, hit geometry, narrow preload validation and gallery/overlay interaction. Build output must include `Pet.html`, the self-contained preload and bundled raster assets. After `pnpm build`, run `pnpm check:pet-presentation` to load the actual built renderer/preload in an isolated offscreen Electron profile, verify all three images load under CSP and confirm the overlay has only pet capabilities. The check writes local pet previews under `.tro-development/pets`; it does not open Tro or use sign-in, model keys or the desktop driver.

Automated tests do not prove native focus, pointer capture or transparent hit testing. Signed installed-app acceptance remains required on macOS and Windows: type into another app while interacting with the pet; verify outside padding clicks, drag/release/cancel, fullscreen/OS menus, scale changes, monitor removal, hide, account changes and restart. This implementation does not claim those manual checks passed. If the adapter fails those checks, follow the specification's in-app fallback decision before release.
