---
"@lazysh/client": patch
---

Add the host browser's address bar, tab list, back, forward, reload and stop, page dialogs and denied-download and file-chooser notices as client components, driven in the developer-only prototype viewer and covered by a real-Chromium test. Typed addresses open only `http`, `https` and `about:blank`; the controls are not in the app until the host browser view ships and change no default.
