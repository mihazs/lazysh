---
"@lazysh/client": minor
---

Let the host companion update itself to this app's version. Every command the app runs on a Linux or macOS host now carries the app's version in `LAZYSH_APP_VERSION` (companions that do not know it ignore it). When a companion that is older than the app updates itself, the Agents panel shows one non-blocking line, "Updating the host companion to X…", then the new version, and views that were waiting for a newer companion (the live conversation stream) ask again at once. Host companion settings gain **Companion updates** (Update automatically, Only tell me, Never) for a companion that has `lazysh-agent auto-update`. English, Brazilian Portuguese and Spanish.
