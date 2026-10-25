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
cannot make Preferences unreadable. This does not reproduce Moshi's light-mode
256-color ramp.

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

QR scanning and OS deep-link delivery are separate remaining issue #16 tasks.
No camera permission, native URI handler or outbound opener permission is added.

Validation uses project Vitest tests for input bounds, Unicode round trips,
legacy preference migration, preview consent and contrast; Playwright exercises
actual desktop/phone light and dark rendering, apply/reload/export/invalid-input/
reset behavior. Additional real-xterm tests cover bold policies, ANSI/indexed/RGB
colors, inverse/selection/decoration combinations, faint text, alternate buffers,
theme changes, contrast, wide/combined characters and unchanged buffer attributes.
A test-only proposed character joiner exercises joined cells; the application
keeps proposed APIs disabled. Native Cargo tests cover settings import validation.
Browser checks do not establish physical mobile WebView, clipboard or native
system-bar behavior, nor Moshi's vendor-specific 256-color inversion formula.
