# Mobile appearance

T3 Code Mobile includes the T3 Code, T3 Chat, Grove, Ocean, Ember, and Iris themes. Each theme has
light and dark colors that apply throughout the app, including code reviews, file previews, the
terminal, native headers, and sheets.

On supported iOS versions, the new-task and thread composers, working timer, and scroll-to-end
button use the system glass material. Other platforms use a themed background.

To change themes:

1. Open **Settings**.
2. Select **Appearance**.
3. Choose a theme.
4. Select **System**, **Light**, or **Dark**.

Tap a theme card to use it for both light and dark appearance. To mix themes, tap the light or dark
preview circle inside a card to change only that appearance.

**System** follows the device appearance automatically. Theme, text, code, and terminal appearance
preferences are stored on the device.

## Portable appearance profiles

Mobile stores a normalized portable profile on the device and maps its colors,
typography, metrics, terminal, review, preview, navigation, sheet, menu,
composer/editor, file-preview, and control roles into native adapters. Package
CSS, CSS snippets, web WOFF2 assets, and web motion effects never execute on
mobile. Installed or bundled font families are used when available; otherwise
the platform fallback applies.

Native renderer limits are explicit. The Ghostty terminal bridge consumes the
profile's family, size, ligature, feature, and variable-axis settings; its
configuration has no portable weight, line-height, or letter-spacing keys. The
text fallback applies those three metrics using React Native's supported
nearest font weights and text styles. Arbitrary OpenType feature tags and
variable axes remain available to Ghostty but are not silently represented by
native text styles.

## Recovery links

Open `t3code://appearance/safe` to bypass the stored portable profile for that
launch. The built-in recovery screen mounts before the appearance provider, so
custom profile values cannot hide it.

Open `t3code://appearance/reset` to request a reset. The app requires an
explicit tap before it moves the active portable profile to quarantine and
continues with the built-in profile. Similar URLs with added paths, query
parameters, fragments, or development schemes are ignored.

When a quarantined profile exists, open the safe link and choose
**Restore quarantined appearance**, then confirm. The restored profile becomes
active on the next normal launch; the profile it replaced is retained in
quarantine.

Permission prompts, file/share sheets, system menus, native material internals,
and surrounding operating-system chrome remain platform-owned.
