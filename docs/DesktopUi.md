# Desktop UI

Tro uses Mantine in Electron's React renderer. It has two destinations: Workspace and Settings. The sidebar shows the current Google account and sign-out control. The existing preload bridge remains the only route to authentication and agent tasks.

The desktop opens at 1360 × 860 logical pixels, close to a 16:10 ratio. These defaults live in `src/desktop/main/Main.ts`. The window remains freely resizable down to 680 × 520.

## Styling in one place

Edit `src/desktop/renderer/Theme.ts` to change the application palette, typography, default radius, or Mantine component defaults. The palette is:

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
- `App.tsx` owns the Mantine AppShell, sidebar and selected destination and reads all interface copy through `useLocale`.
- `UseComputerUse.ts` owns authentication and the in-memory task state. It stays mounted when changing destinations, so Settings does not clear a draft or an active task.
- `ComputerUsePage.tsx` renders the workspace and composer.
- `SettingsPage.tsx` renders account details, language selection and the current appearance.
- `localization/LocaleProvider.tsx` owns locale state and persistence for the renderer root.
- `localization/UseLocale.ts` is the typed hook components use to read messages and change the language.

Google still opens in the system browser. No credentials or database access move into the renderer. Sign-out stays unavailable while a task is running; a successful sign-out clears local messages and draft text. Each submitted message still starts a fresh agent context, and messages are not saved as conversation history.

## Languages

Vietnamese (`vi`) is the default. Settings → Ngôn ngữ / Language offers Tiếng Việt and English (`en`), including before sign-in. Switching updates the interface, accessibility labels, current alerts and the document's `lang` immediately. It preserves task state and drafts. The renderer stores only the locale under `tro.desktop.locale` in local storage; the choice survives app restarts on the same device. An absent, unsupported or unreadable preference falls back to Vietnamese. If saving fails, switching still works for the current window and Settings explains that the preference was not saved.

`localization/English.ts` owns the canonical translation keys and parameter contracts. `Vietnamese.ts` implements the same `TranslationCatalog`. Import `useLocale` from `localization/UseLocale.ts` and use its `messages` in screens and hooks instead of embedding UI copy. Keep whole sentences in the catalog and use typed functions for interpolation, such as `messages.welcome(name)`, so translators can change word order. User names, email addresses, task messages and model answers are content and are displayed as received; the UI language does not set the model's response language.

To add a language:

1. Add a PascalCase catalog file under `src/desktop/renderer/localization` implementing `TranslationCatalog` with `satisfies`. Typechecking catches missing keys and incompatible interpolation parameters.
2. Add its language tag to `DesktopLocale` and its native label and catalog to `desktopLocales` in `Locale.ts`. Settings builds its options from that registry.
3. Cover the language in renderer tests. When dates, numbers or plural messages are introduced, format them with `Intl` using the selected locale and keep grammatical variants in the owning catalog.

The existing IPC protocol reports English error text. `BridgeErrors.ts` maps known messages to translation keys at the presentation boundary; unknown errors use a translated operation fallback. Update this map when adding a bridge failure, until stable error codes are available. Backend logs and wire formats stay independent of UI language.

## Develop and verify

The packages are already included in `package.json`: `@mantine/core`, matching `@mantine/hooks`, and `@tabler/icons-react` for icons. Run `pnpm install`, then use the desktop startup commands in [Development.md](Development.md). The same renderer is bundled for installed apps.

Renderer tests use a typed fake preload bridge and require no Google account, model calls, or database. They cover the sidebar account, navigation preserving conversation/draft/task state, successful sign-out clearing local state, disabled sign-out during a task, authentication failures, default/saved locales, switching without clearing content, inaccessible storage, and localized errors. Follow the repository's final validation commands after completing edits.

References: [Mantine with Vite](https://mantine.dev/guides/vite/), [Mantine theme](https://mantine.dev/theming/theme-object/), [AppShell](https://mantine.dev/core/app-shell/).
