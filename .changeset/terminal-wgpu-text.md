---
"@lazysh/client": patch
---

feat(terminal): Draw real text in the native terminal renderer, with font fallback and correct cell widths

Closes #1325, part of #1302. The wgpu renderer of the native terminal engine now draws glyphs from fonts instead of placeholder patterns: each grapheme cluster is shaped on its own with `swash` (pure Rust), takes the first family of the font list that covers it (a color face for emoji) and is fitted to the one or two cells the terminal core gave it, so CJK, combining marks, ZWJ emoji, flags and keycaps do not move the grid. Bold and italic use the family's own faces and are synthesized when it has none; color emoji have their own atlas. With the optional `native-terminal` feature the renderer host draws with the fonts installed on the machine for the Preferences font list and size (Android and Linux font directories), the platform's monospace font for `monospace`, one CJK and one emoji font, and a bundled subset of DejaVu Sans Mono when nothing else is installed. Fonts imported in Preferences are not drawn by the native engine yet (#2223). Nothing attaches the host and no released build enables the feature, so terminal behaviour and defaults do not change and xterm.js stays the only engine a user can run.
