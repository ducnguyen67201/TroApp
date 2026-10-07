# Startup memory and package size

Measured October 7, 2026 on macOS arm64, Node 24 and Electron 44. The running
application was started with `pnpm dev`. These observations describe one local
run, not a production benchmark or evidence of an unbounded memory leak.

## Where the cost comes from

`pnpm dev` runs the API, TypeScript loader/watch processes, pnpm launchers,
electron-vite, esbuild and the desktop together. electron-vite reached roughly
1,175 MiB RSS during initial compilation, then declined as the process collected
its build allocations. Those development processes do not ship with the app.

The desktop also has Chromium renderer/GPU/utility processes, a pet renderer
when enabled, the native Cua daemon and two utility workers. The task worker and
presentation worker deliberately share one daemon: the presentation connection
must survive task cancellation and worker replacement. An enabled pet renderer
used approximately 100–115 MiB RSS in this run. Its hidden window remains warm
during temporary task suspension so showing it again does not require loading a
new renderer.

Do not sum process RSS and call it total physical memory. Chromium and native
libraries share mapped pages. macOS `sample` and `vmmap -summary` report physical
footprint separately; Activity Monitor's CPU and Memory views distinguish
processing cost from memory. Large virtual address-space reservations are not
resident memory consumption.

## Changes implemented

`PracticeEvidence.ts` previously constructed an o200k tokenizer at API module
load. `MaterialTokenBudget.ts` constructed a separate one on first use. The root
`js-tiktoken` entry also carries dictionaries for encodings Tro does not use.

`src/server/application/TextTokenCounter.ts` now imports the supported lite API
and only the o200k ranks, and constructs one shared encoding on first use.
Materials and practice retain their existing token counts, special-token
handling and protocol-overhead allowances. Desktop material-history counting
also imports only o200k, with its existing lazy initialization. The desktop and
backend remain separate processes and do not import each other's implementation.

Fresh, isolated Node probes after an explicit GC showed these approximate values:

| Probe                             | RSS MiB | Used JS heap MiB |
| --------------------------------- | ------: | ---------------: |
| Empty Node process                |      40 |                3 |
| Import root tokenizer entry       |      71 |                8 |
| Construct one root o200k encoder  |     243 |               74 |
| Construct two root o200k encoders |     341 |              139 |
| Import lite API and o200k ranks   |      59 |                6 |
| Construct one lite o200k encoder  |     231 |               72 |

The main saving is avoiding construction until needed and avoiding a second
backend instance; the dictionary remains necessary when actual token counting
begins. This does not reduce model context limits or change grading behavior.

After the API watcher restarted with the change, its observed RSS went from
about 483 to 374 MiB. `vmmap` reported physical footprint about 309 to 265 MiB and
peak footprint about 497 to 286 MiB. Different runtime ages and GC/compression
timing affect these observations; they are not a guarantee of constant savings.

The generated `out/node_modules` directory contained obsolete copies of the Cua
SDK/native libraries, while the same SDK already lived in `out/cua-sdk`. The old
directory was about 58 MiB, including approximately 56 MiB of redundant files.
`PrepareDesktopRuntime.ts` now validates its inputs and replaces that generated
dependency directory with only the shortcut addon and native loader on every
build. The physical Cua resource tree is preserved. This reduces staging size
and prevents stale dependencies from surviving rebuilds; the exact signed
installer saving depends on electron-builder's dependency filtering/compression.

## Remaining native CPU hotspot

A two-second sample of the embedded daemon showed repeated cursor-overlay
pixmap allocation and Core Animation/Core Graphics image conversion. The daemon
was using roughly 33–35% CPU while following, with about 85 MiB physical footprint
and 142 MiB peak footprint in that sample. This is rendering activity, not model
inference. Message polling exists too, but this sample points to image redraws
as the principal busy stack.

In `driver-patches/CursorCompanion.patch`, `start_following` sends visibility and
guidance frames every 33 ms, including when the pointer is stationary. The render
loop allocates a full display-sized pixmap for changed frames. Native HUD ticks
also keep frames active while the HUD is visible. These paths explain avoidable
idle redraw work; they have not been changed in this optimization.

The next native change should suppress unchanged idle-follow frames, while
still refreshing expiring presentation leases and immediately rendering pointer
movement, display changes, HUD transitions and teaching receipts. A subsequent
rendering change can restrict the layer/image to the actual painted bounds and
reuse buffers. Both need native tests, a rebuilt pinned companion and interactive
checks of movement, display boundaries, live voice levels and teaching animation.
Reducing an unrelated message timer or disabling process isolation would not
resolve this full-image rendering cost.

## Repeating the measurement

1. Start Tro, let initial compilation finish, then leave it idle for one minute.
   Record the API, compiler, main window, pet, native daemon and utility workers
   separately. Repeat after opening a class and after one finished teaching task.
2. On macOS, use `vmmap -summary PID` for physical/peak footprint and
   `sample PID 2 1 -file /tmp/TroStartupSample.txt` for a short CPU stack sample.
   Keep reports local; they contain local paths and thread information.
3. Compare an installed build, or run `pnpm build` then `pnpm start:desktop`
   against the same backend. Preview removes the compiler/watch workload but
   still uses a development launcher; a signed installed build is the release
   acceptance measurement. Quit the existing desktop first to avoid two copies.
4. Inspect generated sizes with `du -sh out/main out/renderer out/node_modules
out/cua-sdk`. Compare the same build mode and architecture. Electron's
   approximately 290 MiB development host is a separate runtime baseline, not
   evidence that Tro's own JavaScript or backend is packaged at that size.

Unit checks cover lazy allocation, sharing across API features, legacy token
counts, reserved-token behavior, and repeated staging without obsolete packages
or damage to the separate SDK tree. No model requests, credentials, database
changes or user preference changes are required for those checks.
