# Desktop UI

Tro uses Mantine in Electron's React renderer. The sidebar opens Workspace, Classroom and a compact Settings dialog. Signed-in users open the microphone picker from the sidebar above Settings. The sidebar shows the current Google account and sign-out control. The existing preload bridge remains the only route to authentication and agent tasks.

The desktop opens at 1360 × 860 logical pixels, close to a 16:10 ratio. These defaults live in `src/desktop/main/Main.ts`. The window remains freely resizable down to 680 × 520.

The 52-pixel top bar shares the sidebar background, with no separate gray title strip or centered window title. Electron keeps native window controls: inset traffic lights on macOS and a matching controls overlay on Windows/Linux. The empty top bar is draggable; the workspace and dialogs remain outside that region. `src/desktop/DesktopAppearance.ts` shares the native background color and bar height with the renderer so controls and content stay aligned.

## Styling in one place

When a packaged app finds an update, a full-width action appears above the Settings group. It downloads on click, displays progress and becomes **Restart to update** when ready. Active tasks and voice operations defer restarting. See [AppUpdates.md](AppUpdates.md) for configuration, ownership and release checks.

`src/desktop/assets/TroIcon.png` owns the approved teacher-and-student artwork with native app padding. `TroMark.png` crops the transparent margin for the sidebar, welcome screens, permission onboarding and favicon. `TroIcon.tsx` displays the decorative mark beside accessible text. Action icons still describe their controls.

The committed `TroIcon.icns` and `TroIcon.ico` supply macOS app/permission identity and Windows app/installer identity. Run `pnpm generate:icons` on macOS after updating `TroIcon.png`. Packaging stages the complete artwork directory under `out/branding`; main imports the PNG as a build asset for the Dock and window. See [Development](Development.md) for the branded macOS development host.

Edit `src/desktop/DesktopAppearance.ts` to change the shared palette and window appearance, and `src/desktop/renderer/Theme.ts` for typography, default radius, semantic tokens, or Mantine component defaults. The palette is:

| Color    | Value     | Use                                         |
| -------- | --------- | ------------------------------------------- |
| Cream    | `#FFFCF2` | Main surface                                |
| Gray     | `#CCC5B9` | Derived sidebar, borders and selected items |
| Charcoal | `#403D39` | Secondary text                              |
| Black    | `#252422` | Main text and primary controls              |
| Orange   | `#EB5E28` | Small accents and send action               |

The theme's CSS variable resolver exposes semantic `--tro-*` tokens and aligns Mantine defaults with the same palette. `App.css` consumes those tokens for layout. Add new colors in the theme rather than embedding hex values in individual screens. Light appearance is fixed for this scaffold; Settings displays the current appearance and account, without a theme switch. Language selection is independent of appearance.

`Render.tsx` imports Mantine's core stylesheet before application CSS and wraps the app in one `MantineProvider`. No additional CSS framework or styling runtime is needed. This scaffold uses ordinary CSS rather than Mantine's optional PostCSS mixins.

## Ownership and behavior

- `Render.tsx` installs the one `LocaleProvider` around the complete desktop interface.
- `App.tsx` owns the Mantine AppShell, sidebar and Settings/microphone dialog stack and reads all interface copy through `useLocale`.
- `UseComputerUse.ts` owns authentication and the in-memory task state. The workspace stays mounted behind Settings, so opening or closing it does not clear a draft, restart voice input or interrupt an active task.
- `ComputerUsePage.tsx` renders the workspace and composer. Voice capture and task progress use the companion HUD, with no duplicate voice panel above the workspace.
- `App.tsx` keeps `UseVoiceInput.ts` mounted while dialogs are open for shortcut capture, audio delivery and voice task replies.
- `SettingsDialog.tsx` renders General and Account tabs. General shows the actual talk shortcut, selected microphone, language and fixed appearance as compact rows. Account shows the signed-in name and email. Microphone selection, sound tests and ranking open in the existing picker above Settings; closing it returns to Settings. Mantine Modal.Stack owns focus trapping and top-dialog Escape dismissal. App restores focus to each opener after the exit transition, so closing the picker returns to its Settings button and closing Settings returns to its sidebar button. The panel scrolls at small window sizes, and the language remains available before sign-in.
- `localization/LocaleProvider.tsx` owns locale state and persistence for the renderer root.
- `localization/UseLocale.ts` is the typed hook components use to read messages and change the language.

Google still opens in the system browser. No credentials or database access move into the renderer. Sign-out stays unavailable while a task is running; a successful sign-out clears local messages and draft text. Each submitted message still starts a fresh agent context, and messages are not saved as conversation history.

## Languages

Vietnamese (`vi`) is the default. Settings → General → Ngôn ngữ / Language offers Tiếng Việt and English (`en`), including before sign-in. Switching updates the interface, accessibility labels, current alerts and the document's `lang` immediately. It preserves task state and drafts. The renderer stores only the locale under `tro.desktop.locale` in local storage; the choice survives app restarts on the same device. An absent, unsupported or unreadable preference falls back to Vietnamese. If saving fails, switching still works for the current window and Settings explains that the preference was not saved.

`localization/English.ts` owns the canonical translation keys and parameter contracts. `Vietnamese.ts` implements the same `TranslationCatalog`. Import `useLocale` from `localization/UseLocale.ts` and use its `messages` in screens and hooks instead of embedding UI copy. Keep whole sentences in the catalog and use typed functions for interpolation, such as `messages.welcome(name)`, so translators can change word order. User names, email addresses, task messages and model answers are content and are displayed as received; the UI language does not set the model's response language.

To add a language:

1. Add a PascalCase catalog file under `src/desktop/renderer/localization` implementing `TranslationCatalog` with `satisfies`. Typechecking catches missing keys and incompatible interpolation parameters.
2. Add its language tag to `DesktopLocale` and its native label and catalog to `desktopLocales` in `Locale.ts`. Settings builds its options from that registry.
3. Cover the language in renderer tests. When dates, numbers or plural messages are introduced, format them with `Intl` using the selected locale and keep grammatical variants in the owning catalog.

The existing IPC protocol reports English error text. `BridgeErrors.ts` maps known messages to translation keys at the presentation boundary; unknown errors use a translated operation fallback. Update this map when adding a bridge failure, until stable error codes are available. Backend logs and wire formats stay independent of UI language.

## Develop and verify

The packages are already included in `package.json`: `@mantine/core`, matching `@mantine/hooks`, and `@tabler/icons-react` for icons. Run `pnpm install`, then use the desktop startup commands in [Development.md](Development.md). The same renderer is bundled for installed apps.

Renderer tests use a typed fake preload bridge and require no Google account, model calls, or database. They cover the sidebar account, dialog and tab navigation preserving the mounted workspace and conversation/draft/task state, nested microphone dismissal and current selection summaries, successful sign-out clearing local state, disabled sign-out during a task, authentication failures, default/saved locales, switching without clearing content, inaccessible storage, and localized errors. Follow the repository's final validation commands after completing edits.

References: [Mantine with Vite](https://mantine.dev/guides/vite/), [Mantine theme](https://mantine.dev/theming/theme-object/), [AppShell](https://mantine.dev/core/app-shell/).

## Content space

The main panel begins directly with page content. It has no separate page-name or
“Your desktop” header strip; the active sidebar item identifies the current page.
Microphone selection is a sidebar action using the same dialog stack and focus
return behavior as the former header button. The native draggable title bar and
window controls remain in their existing position.

## Classroom experience

The signed-in sidebar is a compact 96px charcoal rail with labeled actions, an
account avatar and the actual Teacher/Student role. Microphone, Settings, updates
and sign-out keep their existing controllers. Signed-out screens retain the wider
sidebar. Classroom uses a white canvas with pastel details and original decorative
inline artwork from the approved
[prototype](classroom/ClassroomExperienceDemo.html).

Class cards select local details; selecting a student card does not join a session.
The student explicitly joins using the existing command. Sections, original
materials, project links and submission confirmation use the existing data and
bridges. The teacher view puts owned classes and sections beside session controls,
with a Create class button beside the class-list tabs, a class-name dialog, expandable invite
forms and the existing full-width materials editor.
Class cards now open a dedicated `#/classroom/<classId>` page inside Tro. Overview,
Materials and Settings share the right-hand illustration. Back to All classes and
browser Back/Forward use renderer hash navigation, compatible with Electron's
installed file entry point. Routes select only classes present in the authorized
home snapshot; a deleted or inaccessible class returns to the class list.
Settings contains direct enrollment by an existing verified account's email,
optional shared invitation codes and class deletion. Adding by email uses the
existing backend enrollment command; it neither sends an email nor joins a session.
The class page puts the Back control, class name and Refresh on one row, with
24 px top padding and tighter tabs. Create class remains on the class list.
The class-list title, search and refresh share a compact toolbar. Materials use a
short preparation heading rather than repeating the page introduction, keeping
upload and review panels visible higher on the screen. Narrow windows wrap the
toolbar controls without squeezing their labels. Material preparation shows a
spinner and a live status in the review panel from the Prepare click through queued
and running work; success or failure replaces that loading state.
There is no demo role switch, sample class, fabricated duration or completion score
in the production interface. Class search is local to already-authorized data.

`classroom/ClassArtwork.tsx` owns decorative SVG art; `StudentClassroomPanel.tsx`
owns student browsing, `StudentMaterials.tsx` presents authorized downloads, and
`StudentActivityPanel.tsx` retains project/progress/submission actions.
`TeacherClassroomPanel.tsx` retains teacher commands. `ClassroomPage.tsx` keeps
its existing command dispatcher and polling. Theme tokens and responsive CSS
control the design. No backend contracts, persistence or authorization changed
for this visual update.

Teacher session controls separate the current section, student pacing and session stages.
Each stage has a short explanation and the saved stage is marked as current. Selecting
a different section or pacing shows a pending-change hint: the existing stage buttons
apply those selections. Ending a session sits in a separate footer. This presentation
uses the existing start/update/end commands and preserves their session versions.

`desktop/localization/ClassroomMessages.ts` owns classroom task failure copy shared by
Electron main and the renderer catalogs. Main selects the task locale without React
hooks; the bridge error map retains the message key so visible errors also follow
later UI language changes.

## Account menu

The signed-in sidebar avatar opens `accounts/AccountMenu.tsx`: saved identities,
Google account addition and current-account sign-out. `UseComputerUse.ts` owns
the selected renderer identity and clears local task state during transitions.
Cookies stay in main and encrypted device storage; see
[account switching](classroom/AccountSwitching.md) for lifecycle and verification.
