# KM Code brand icons

The three Icon Composer projects are the source of truth for the full application
icon family:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `Assets/text.svg` for the geometric KM monogram. The
development and preview projects also use the graphite/copper vector layers in
`Assets/background.svg` and their accent layer files. Keep these SVGs as the
editable sources; the PNG and ICO files are generated exports.

Run `vp run icons:export` from the repository root to regenerate the tracked
iOS, Linux, Windows, and web assets. Development web exports are copied to
`apps/web/public` for the browser favicon and splash screen. Run
`vp run icons:check` to verify generated assets and public copies match their
sources without changing files.

Icon export prefers Icon Composer 2 or newer on macOS. The script selects the
newest compatible exporter from Xcode or a standalone Icon Composer and pins
design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of
`Icon Composer.app/Contents/Executables/ictool` to override automatic
discovery.

When Icon Composer is unavailable, `icons:export` uses the pinned
`@resvg/resvg-js` renderer to render the same SVG layers deterministically,
including the classic macOS safe area. This fallback keeps source edits
exportable without Xcode; it does not reproduce Icon Composer's native shadow.

## macOS exports

The portable fallback writes the macOS PNG with the classic safe area: the
opaque icon body is 824×824, inset 100 pixels on every side, with transparent
space outside the body. Do not edit generated PNG or ICO files directly.

## Android adaptive and monochrome marks

`apps/mobile/assets/android-icon-foreground.svg` is the source of truth for
the normal Android adaptive launcher foreground. Its paired PNG is generated
with:

```sh
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-foreground.png \
  apps/mobile/assets/android-icon-foreground.svg
```

`apps/mobile/assets/android-icon-mark.svg` is the source of truth for the
flat monochrome and notification silhouette. Generate both tracked PNGs with:

```sh
rsvg-convert -w 432 -h 432 \
  -o apps/mobile/assets/android-icon-mark.png \
  apps/mobile/assets/android-icon-mark.svg
rsvg-convert -w 96 -h 96 \
  -o apps/mobile/assets/android-notification-icon.png \
  apps/mobile/assets/android-icon-mark.svg
```

Both source marks are transparent, use the same KM geometry, and keep their
strokes within Android's adaptive safe zone.

## Pending generated outputs

The source edits above intentionally do not modify generated rasters. The next
export pass must regenerate:

- `assets/dev/{blueprint-ios-1024.png,blueprint-universal-1024.png,blueprint-macos-1024.png,blueprint-windows.ico,blueprint-web-favicon.ico,blueprint-web-favicon-16x16.png,blueprint-web-favicon-32x32.png,blueprint-web-apple-touch-180.png}`
- `assets/nightly/{nightly-ios-1024.png,nightly-universal-1024.png,nightly-macos-1024.png,nightly-windows.ico,nightly-web-favicon.ico,nightly-web-favicon-16x16.png,nightly-web-favicon-32x32.png,nightly-web-apple-touch-180.png}`
- `assets/prod/{black-ios-1024.png,black-universal-1024.png,black-macos-1024.png,t3-black-windows.ico,t3-black-web-favicon.ico,t3-black-web-favicon-16x16.png,t3-black-web-favicon-32x32.png,t3-black-web-apple-touch-180.png}`
- `apps/mobile/assets/{android-icon-foreground.png,android-icon-mark.png,android-notification-icon.png}`
- `apps/web/public/{favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png}`

The existing filenames remain stable for package, URL, and native consumers.
