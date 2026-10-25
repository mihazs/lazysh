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
foreground must be opaque. Unknown fields, CSS expressions and custom bold-color
overrides are rejected. JSON is bounded to 8 KiB, encoded input to 16 KiB, and
share codes contain UTF-8 JSON encoded as base64url. Compatible `moshi-theme:`
payloads can be pasted as data; lazysh does not register Moshi's URL scheme.

The terminal honors supplied colors. App surfaces derive opaque colors from the
palette and choose readable text/accent colors, so low-contrast terminal colors
cannot make Preferences unreadable. This does not reproduce Moshi's light-mode
256-color ramp or its unsupported custom bold-color renderer behavior.

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
reset behavior. Native Cargo tests cover settings import validation. Browser
checks do not establish physical mobile clipboard or native system-bar behavior.
