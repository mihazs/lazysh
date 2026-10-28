# lazysh — Bed Mode brand kit

The **Bed Mode** identity combines a relaxed, closed-eye character and a tilted
mobile terminal. The single continuous base represents persistent sessions;
the device represents SSH access and AI-agent workflows from anywhere.

## Asset inventory

All SVGs are actual vectors with **transparent outer canvases**, not embedded
raster images. The `icon-wrapped-*` SVGs contain a designed rounded-square
tile; pixels **outside** that tile remain transparent. Solid-background exports
are supplied only where native app-icon formats require them (notably iOS).

| Application | Source SVGs |
| --- | --- |
| Standalone symbol, no tile | `svg/icon-{gradient,dark,white}.svg` |
| Symbol with tile/wrapper | `svg/icon-wrapped-{gradient,dark,white}.svg` |
| Wordmark only (outlined lettering) | `svg/wordmark-{gradient,dark,white}.svg` |
| Horizontal symbol + wordmark | `svg/lockup-horizontal-{gradient,dark,white}.svg` |
| Stacked symbol + wordmark | `svg/lockup-stacked-{gradient,dark,white}.svg` |
| Compact favicon | `svg/favicon-{gradient,dark,white}.svg` |
| Android 108dp adaptive foreground | `svg/android-adaptive-foreground.svg` |
| Android themed icon source | `svg/android-adaptive-monochrome.svg` |

The `dark` mark is **ink-colored for light backgrounds**; the `white` mark
is **light-colored for dark backgrounds**. The `gradient` mark can be used on
either background provided legibility is checked. The canonical gradients and
color tokens are stored in `tokens.json`.

## Native application assets

- Tauri desktop (Linux/macOS/Windows): `apps/client/src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.ico,icon.icns}`.
- Android: `apps/client/src-tauri/gen/android/app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/`, with standard (48/72/96/144/192 px), round and 108/162/216/324/432 px adaptive foreground exports; Android 13+ monochrome is a native vector drawable.
- iOS/iPadOS: `apps/client/src-tauri/icons/ios/AppIcon-*.png`, including an opaque 1024px original, with all existing size slots kept. Apple applies its own icon mask. The existing opt-in Amber alternate icon remains unchanged.
- Web/favicon: `apps/client/public/favicon.svg`, consumed by `apps/client/index.html`.

**Transparent source is intentional; opaque iOS icons are mandatory.** Do not
apply a pre-rounded mask to iOS app icons or put device/user data in the mark.

## Usage and accessibility

Use the unwrapped mark on compatible application surfaces and the wrapped
mark for launcher-style presentations. Keep the sloth eyes visible at small
sizes; use the simplified 64-unit favicon for browser tabs. Avoid shadows,
gloss, thick outlines, extra decoration or edits to the proportions.

Recommended clear space: at least 12.5% of the mark's width. On dark surfaces,
prefer `white` or `gradient`; on light surfaces use `dark`. Check WCAG
contrast for accompanying interface text separately from decorative symbols.

The wordmark letters are native SVG paths derived from an Inter SemiBold
outline, so the SVGs do not require installing or distributing font files.

## Updating platform exports

Use the checked-in artwork with the Tauri icon tooling and platform asset
requirements when updating launcher icons. Review the resulting Android and
iOS assets, and preserve the independent Amber alternate icon.

## Verification

The icons are versioned alongside the application so installers do not depend
on a post-checkout design tool. Confirm actual native launcher rendering on
Android devices and iPhone/iPad after building; SVG previews and PNG dimensions
alone do not establish device acceptance.

All brand files are original project artwork, under the repository's license.
