---
"@lazysh/agent": minor
"@lazysh/client": minor
---

feat(hooks): install, update and remove Kimi Code 2.4 approval hooks from Agent hook setup

**Agent hook setup** lists Kimi Code (`KIMI_CODE_HOME`, otherwise `~/.kimi-code`) and installs three `[[hooks]]` entries (`PermissionRequest`, `PermissionResult`, `SessionEnd`, five seconds) as an owned block at the very end of the profile's existing `config.toml`. Every earlier byte, including comments, secrets, CRLF line endings, foreign hooks and the file mode, is kept; a UTF-8 BOM is refused unchanged because Kimi Code 2.4.1 rejects it. The result is validated as TOML before it is written, a missing `config.toml` is refused instead of created, and update or remove act only on that exact end-of-file block (an edit after it, a moved block or an inline `hooks` setting is a conflict, never a rewrite). It needs the updated host companion: the app asks for discovery schema 4 first and falls back to 3 and 2 for older companions, which keep Kimi manual, as do the legacy Kimi CLI 1.52 profile and custom config paths. No default changes. A one-off run of the official Kimi Code 2.4.1 `kimi doctor` accepted the result; macOS, Windows and a real authenticated Kimi session were not exercised.
