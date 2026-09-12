# Appearance customization

Appearance settings are local to each client. Connecting to another environment does not install, enable, or grant trust to that environment's CSS.

## Themes and variants

Open **Settings → Appearance** to choose the system, light, or dark appearance mode and the active theme. A package can provide separate light and dark variants. Previewing a package does not install or activate it; clear the preview to return to the exact saved appearance. Full-app and light/dark previews retain enabled snippets, while theme-alone preview temporarily isolates the package from snippets.

The package list shows its source, version, app/platform compatibility, active variant, asset count, and latest diagnostics. Imported packages remain disabled until explicitly activated. Re-importing the same package reloads its files without changing its enabled state.

## Fonts

A package can set interface, composer, code, terminal, markdown, label, and heading typography. Explicit client font preferences take precedence over package defaults. T3 reports each failed family/style/weight descriptor separately and falls back through the declared family list. Use **Retry failed fonts** after correcting an installed or package font.

Web and desktop packages may contain declared WOFF2 assets. Mobile uses installed or bundled font families and does not load package WOFF2 files.

## CSS snippets

Advanced snippets are ordered, client-local CSS files with full control over T3-owned renderer content. They can hide controls, change focus or contrast, and override ordinary appearance preferences. Importing a snippet bundle does not enable its snippets; review and enable each snippet explicitly.

Use the snippet controls to edit, reload, reorder, enable, disable, export, or delete a snippet. On desktop, **Open appearance folder** reveals the watched local appearance directory. Browser imports are copied into IndexedDB and have no live source path.

Supported custom CSS must use the documented variables and selectors in [the appearance selector contract](../internals/appearance-selectors.md). Internal classes and DOM depth are not compatibility promises. Package CSS cannot load remote resources, JavaScript, HTML, SVG, undeclared assets, or paths outside the package.

## Import and export

Theme packages use the strict version 2 appearance manifest. Existing version 1 T3 theme files are migrated during import. Invalid, incompatible, oversized, or capability-mismatched packages are rejected with diagnostics rather than partially applied.

Export packages and snippet bundles before moving appearance settings between clients. There is no cloud appearance sync. Environment-published themes are bounded palette data only; an environment cannot cause local CSS to execute.

## Recovery

Safe mode skips custom packages, snippets, assets, watchers, and the synchronous boot snapshot before custom appearance can be injected.

- Desktop: launch with `--safe-appearance` or `T3CODE_APPEARANCE_SAFE_MODE=1`.
- Browser: open the app with `?t3-appearance=safe`.
- Mobile: open `t3code://appearance/safe`.

Reset entry points open the same built-in recovery surface and require confirmation before quarantining appearance state:

- Desktop: `--reset-appearance`.
- Browser: `?t3-appearance=reset`.
- Mobile: `t3code://appearance/reset`.

Recovery can export current or quarantined state, disable a package or snippet, restore the last good state, or reset to the built-in appearance. A startup compile/apply failure quarantines the suspect state and restores last-good or built-in safe state without repeatedly loading the failed package.

## Platform coverage

Web and desktop apply portable colors, typography, metrics, motion, terminal, syntax, diff, artwork, and supported package CSS. Desktop also maps mode, window background, and supported titlebar colors.

Mobile applies the portable manifest's colors, typography, metrics, terminal, review, preview, navigation, sheet, menu, composer/editor, file-preview, and control roles. Mobile never executes package CSS or snippets and ignores web-only package assets and motion effects.

T3 cannot theme operating-system permission prompts, file pickers, share sheets, native menu bars, compositor decorations, provider-hosted pages, provider CLI output beyond the configured terminal palette, or the remote page inside browser preview. T3-owned wrappers and preview annotation chrome remain themed.
