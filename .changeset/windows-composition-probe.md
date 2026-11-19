---
"@lazysh/client": patch
---

Add a Windows composition probe for the native terminal engine (#1332, part of #1302): a standalone tao and wry program under `packages/terminal-runtime/prototypes/windows-surface` and a `windows-surface-probe` workflow that opens the real window and WebView2 page on a `windows-latest` runner, stacks a child window below the transparent web view (GDI-painted and as a Direct3D 12 swapchain) and above it with the page's overlay cut out of it, reads its own window back with `PrintWindow` and a screen copy, and writes what it saw. On the hosted runner a Direct3D 12 child below the transparent WebView2 shows through exactly, with an opaque or a transparent tao window; the job fails if that stops holding. Nothing in the app, its terminal engine or its defaults changes: Windows keeps xterm.js and Auto resolves to xterm.js there.
