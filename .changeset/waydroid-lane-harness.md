---
"@lazysh/client": patch
---

Add the Waydroid lane harness for the native terminal engine's Android acceptance (`apps/client/bench/waydroid-lane.sh` and its runbook): it starts or attaches to a headless Waydroid session, installs APKs, runs named instrumentation classes and benchmark commands, tears down and writes an evidence JSON with the guest's environment and the accepted-risk block, and it refuses to run, or to skip, with its own exit code. Test and documentation only; no behaviour changes.
