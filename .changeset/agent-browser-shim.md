---
"@lazysh/agent": minor
---

Add the opt-in host browser shim: `lazysh-agent browser-shim install|status|uninstall` and the `browser-open` and `browser-watch --protocol 1` commands, so a link a host program opens (`xdg-open`, `open`, `$BROWSER`, Python `webbrowser`) can be handed to the lazysh app over a companion channel and otherwise goes to the real opener unchanged. Off until installed; with the shim installed, tools that fall back to a device code when the host has no browser launcher start their browser flow instead.
