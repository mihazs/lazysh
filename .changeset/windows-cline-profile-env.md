---
"@lazysh/agent": minor
---

feat(account-usage): follow Cline profile environment overrides on Windows

Follow the Cline CLI's profile environment variables (`CLINE_PROVIDER_SETTINGS_PATH`, `CLINE_DATA_DIR`, `CLINE_DIR`) on Windows hosts, with the same precedence as Linux and macOS, so a Windows user who points the Cline CLI at another profile gets quota from that store. The selected store uses the bounded Windows read, and a missing, malformed or nonregular store still reports not signed in without falling back to the home-directory login. Changed default: a Windows host with one of the variables set used to report the store unavailable and now reads it.
