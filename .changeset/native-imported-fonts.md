---
"@lazysh/client": patch
---

feat(terminal): draw the fonts you imported in Preferences with the native terminal engine

A font imported in Preferences, as the terminal font or as the CJK fallback, is now drawn by the native terminal engine as it is by xterm.js: the app receives the font's bytes once, draws with them ahead of the device's fonts, and a CJK font draws only the CJK characters, so Latin text keeps your terminal font. Choosing another font, or removing one, redraws open native sessions. Native stays off by default, so nothing changes unless Settings, Terminal engine is set to Native.
