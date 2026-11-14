---
"@lazysh/client": patch
---

Teach the wgpu renderer of the native terminal engine to draw real text: glyphs from the user's fonts with the CJK and emoji fallback order the font settings give, combining marks, ZWJ emoji, flags and wide characters kept inside the cells the core assigned them, bold and italic from the font's own faces (synthesized when it has none), and color emoji in a second atlas. It is not wired into the app yet and xterm.js stays the only engine and the default, so nothing changes for users; this is groundwork for trying the native engine behind an explicit opt-in.
