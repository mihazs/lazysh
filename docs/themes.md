# Imported themes

Open Preferences → Import and share theme. Paste JSON or a `lazysh-theme:` code,
then select Preview theme. Review the name, mode and sample before choosing
Apply to app and terminal. Reading the clipboard is a separate explicit action;
the app never reads or writes it automatically. Export produces selectable JSON
or a share code for the saved imported palette. Neither import nor export fetches
URLs or uploads anything.

Versioned JSON contains `v: 1`, a nonempty `name` of at most 40 Unicode code points,
`mode: "light"` or `"dark"`, and a `colors` object:

```json
{"v":1,"name":"Evening","mode":"dark","colors":{"background":"#101311","foreground":"#d9e0d6","cursor":"#c4eb89"}}
```

Canonical imports fill omitted ANSI base colors from foreground and bright colors
from their matching base; cursor defaults to foreground and selection background
is a 30% foreground blend over background. These fallbacks apply to reviewed or
metadata-backed themes, while unreviewed legacy palettes keep xterm defaults.
Theme names must contain well-formed Unicode (no unpaired UTF-16 surrogates).

Colors support background/foreground, cursor/cursorAccent, the three selection
colors, and the sixteen ANSI colors accepted by xterm. Values are hexadecimal
`#rgb`, `#rrggbb` or `#rrggbbaa`; shorthand is normalized. Whole-app background and
foreground must be opaque. Unknown fields and CSS expressions are rejected.
JSON is bounded to 8 KiB, encoded input to 16 KiB, and
share codes contain UTF-8 JSON encoded as base64url. Compatible `moshi-theme:`
payloads can be pasted as data; lazysh does not register Moshi's URL scheme.

The terminal honors supplied colors. App surfaces derive opaque colors from the
palette and choose readable text/accent colors, so low-contrast terminal colors
cannot make Preferences unreadable.

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

The [Moshi personalization documentation](https://getmoshi.app/docs/personalization)
describes an inverted light-mode ramp for built-in and imported light themes,
without specifying a formula. The formula above was independently recovered by
read-only static analysis of the pinned Linux desktop Go alpha 0.5.28 executable
recorded in [Moshi evidence](moshi-evidence.md), SHA-256
`c3043607369f45f8e57fc0aed7ab20e9570b9b6175a4e1291dceebc47a3601b0`.

Its `.gopclntab` starts at file offset `0x188f5a0`. Decoding the Go function
table using the installed Go `debug/gosym` layout matched all 26,661 entry
offsets to their function records. This identified
`moshi-go/internal/theme.lightExtendedAnsi` at virtual addresses
`0xaed0c0..0xaed740` (end exclusive) and `DeriveXtermTheme` at
`0xaed740..0xaed9a0`. Binutils disassembly of these bounded ranges established
the arithmetic, cube loop order, rounding and exact `light` dispatch. Referenced
read-only constants include the cube levels at `0x1c34010`, brightness weights
at `0x1c2b2b0/0x1c2b2c8/0x1c2b288`, threshold at `0x1c2b328`, scale at
`0x1c2b2d0`, and grayscale endpoint at `0x1c2b330`. No target code was executed,
and no proprietary source or assets were copied. REA native decompilers were
unavailable; GoReSym did not parse this artifact, so neither supplied this result.

This establishes the pinned desktop artifact's palette math, not byte-identical
current Moshi mobile rendering. Browser tests verify lazysh's actual xterm
foreground/background, inverse, selection, decoration, bold/faint, scrollback,
alternate-buffer and theme-change behavior; physical Android/iOS WebView pixels
and vendor mobile inverse/selection details remain unverified.

## Terminal bold colors

The [documented v1 `colors.bold` field](https://getmoshi.app/docs/personalization)
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
SGR policy is tested; Moshi's exact custom-bold/inverse pixel behavior is not
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

## Installed-app theme links

Export theme link produces selectable `lazysh://theme?data=BASE64URL` text. It
contains the same bounded UTF-8 theme document as a share code; no service is
contacted, URL fetched or clipboard changed. The unpadded base64url alphabet is
required, and the canonical URI is limited to 16 KiB. Actual credentials, ports,
fragments, extra paths, duplicate `data` keys and unknown authorities are rejected.
CLI and Android string ingress also enforce a 16 KiB raw input bound. Apple OS
callbacks already contain parsed URLs: equivalent spelling such as empty userinfo
or outer whitespace may have normalized away before lazysh receives the URI.

An installed native app receives cold and warm OS opens. A second desktop
invocation delivers to the existing app instance. Native storage retains one
pending candidate in memory while locked; the latest syntactically valid link replaces an
unreviewed candidate. URLs and theme data are never broadcast to webviews.
After the native access-ready acknowledgement, a metadata notice offers Review
linked theme. Reviewing does not apply or acknowledge the candidate. Apply linked
theme saves the reviewed app/terminal theme; Discard theme link keeps the current
theme. If another link arrives during review, acknowledging the old receipt
cannot discard the new candidate. Manual import drafts stay in their existing
form, including while Preferences is open. Resume locking still clears transient
renderer drafts as documented for app protection.

The official deep-link plugin is pinned with a small, licensed
[native-event patch](../packages/deep-link-vendor/LAZYSH_PATCH.md). Rust owns its
current URL cache and per-listener generations; forged metadata events cannot
replay an acknowledged URL, while a genuine second OS open of the same URL is
delivered. Three application commands require the original native access lease
and guarded serialization. The review panel retains its original mount's lease
through dispatch, completion and cleanup; an obsolete renderer cannot freshen
that lease after a lock/unlock. No deep-link plugin JavaScript permission is granted.
The existing `lazysh://agents/...` iOS status route remains independent.

OS registration is installed-bundle behavior. Browser tests use a synthetic native
bridge and cannot establish desktop OS association, Android intent, iOS URL-open
or physical resume behavior. Native Cargo tests exercise the actual patched
plugin's CLI delivery, `get_current`, `on_open_url`, unlisten, metadata replay and
same-URL reopening, plus route bounds and stale lease/read/ack behavior. Mobile
and packaged desktop cold/warm OS delivery remain platform acceptance checks.

QR scanning remains a separate issue #16 task. No camera permission or barcode
scanner is added by this change.

Validation uses project Vitest tests for input bounds, Unicode round trips,
legacy preference migration, preview consent and contrast; Playwright exercises
actual desktop/phone light and dark rendering, apply/reload/export/invalid-input/
reset behavior. Additional real-xterm tests cover bold policies, ANSI/indexed/RGB
colors, inverse/selection/decoration combinations, faint text, alternate buffers,
theme changes, contrast, wide/combined characters and unchanged buffer attributes.
A test-only proposed character joiner exercises joined cells; the application
keeps proposed APIs disabled. Native Cargo tests cover settings import validation.
Browser checks do not establish physical mobile WebView, clipboard or native
system-bar behavior or Moshi's mobile rendering.
