# Theme rendering reference

## Light terminal indexed colors

Paper and custom themes explicitly marked `mode: "light"` now use a tuned
extended palette. This changes their previous default rendering of indexed
colors 16–255, including text already in scrollback. Dark themes and flat legacy
palettes without reviewed mode metadata keep xterm's standard extended palette.
Changing back to those themes removes the light mapping. Supplied ANSI colors
0–15 and literal RGB escape sequences remain unchanged.

The 216-color cube starts with channel levels `[0, 95, 135, 175, 215, 255]`.
When `0.299R + 0.587G + 0.114B > 200`, each channel becomes
`floor(0.6 * channel + 0.5)`; otherwise it is unchanged. Grayscale index `232+i`
uses `max(8, min(238, 238 - 10*i))` for each channel, for `i=0..23`.
Thus index 250 becomes `#3a3a3a` and 237 becomes `#bcbcbc`, making a common
light-on-dark indexed status line dark-on-light. This policy does not guarantee
a minimum contrast for every color combination or arbitrary imported palette.

The mapping uses public xterm 5.5.0 `ITheme.extendedAnsi`, affecting the same
indices in foregrounds and backgrounds. xterm swaps logical foreground/background
for inverse video before resolving their palette entries; selection and decoration
overrides keep their existing precedence. No additional private renderer seam,
buffer rewrite or minimum-contrast override is involved.

### Evidence and limits

The reference client personalization documentation (source URL omitted)
describes an inverted light-mode ramp for built-in and imported light themes,
without specifying a formula. The formula above was independently recovered by
read-only static analysis of the pinned Linux desktop Go alpha 0.5.28 executable
recorded in [reference client evidence](../reference-evidence.md), SHA-256
`c3043607369f45f8e57fc0aed7ab20e9570b9b6175a4e1291dceebc47a3601b0`.

Its `.gopclntab` starts at file offset `0x188f5a0`. Decoding the Go function
table using the installed Go `debug/gosym` layout matched all 26,661 entry
offsets to their function records. This identified
the light extended-ANSI palette function (symbol path omitted) at virtual addresses
`0xaed0c0..0xaed740` (end exclusive) and `DeriveXtermTheme` at
`0xaed740..0xaed9a0`. Binutils disassembly of these bounded ranges established
the arithmetic, cube loop order, rounding and exact `light` dispatch. Referenced
read-only constants include the cube levels at `0x1c34010`, brightness weights
at `0x1c2b2b0/0x1c2b2c8/0x1c2b288`, threshold at `0x1c2b328`, scale at
`0x1c2b2d0`, and grayscale endpoint at `0x1c2b330`. No target code was executed,
and no proprietary source or assets were copied. REA native decompilers were
unavailable; GoReSym did not parse this artifact, so neither supplied this result.

This establishes the pinned desktop artifact's palette math, not byte-identical
current reference client mobile rendering. Browser tests verify lazysh's actual xterm
foreground/background, inverse, selection, decoration, bold/faint, scrollback,
alternate-buffer and theme-change behavior; physical Android/iOS WebView pixels
and vendor mobile inverse/selection details remain unverified.

## Terminal bold colors

The documented v1 `colors.bold` field (source URL omitted)
is optional. Omit it to keep the normal text color while using a bold font;
`"bright"` brightens the first eight ANSI foreground colors without changing the
default foreground. A `#rgb` or `#rrggbb` value supplies the default bold
foreground and enables the same ANSI brightening. Explicit RGB colors and
extended palette indices retain xterm's existing behavior. Bold colors survive
JSON/share-code export, reload and settings sync. Alpha bold colors are rejected.
Existing bundled themes and saved flat palettes without metadata retain their
previous bright-bold default; explicitly reviewing a palette adopts v1 semantics.

The hex color is a logical foreground: inverse video moves it to the background.
Selection and decoration overrides retain xterm's ordering. Default bold text
keeps faint opacity, and xterm's minimum-contrast option evaluates the actual
custom foreground/background, including inverse and selected text. This logical
SGR policy is tested; the reference client's exact custom-bold/inverse pixel behavior is not
documented and is not claimed to match.

Hex rendering uses a narrow adapter in `terminalBold.ts` against the pinned
xterm 5.5.0 DOM renderer's foreground/contrast method. It does not rewrite escape
sequences, modify buffer/work-cell attributes, or enable proposed APIs in the app.
Changing a theme updates already rendered text; disposal restores the original
method without overwriting another owner's replacement. An incompatible renderer
reports an error rather than silently ignoring the accepted hex color. Upgrading
xterm or introducing another renderer requires reviewing this seam and its real
rendering tests together.

Flat legacy palettes remain supported. Existing saved palettes retain their
terminal colors and existing app theme. To use one throughout the app, choose a
name/mode, select Review saved palette and explicitly apply it. New reviewed
imports remain available in the App theme and Terminal theme selectors, so either
surface can return to a bundled choice independently. Reset preferences clears
the stored palette/metadata and removes custom app CSS overrides. Settings sync
validates metadata and palette fields; older binaries may reject newer settings
fields rather than silently interpreting them.

For setup and usage, see [themes](../themes.md). Return to the [documentation map](../README.md).
