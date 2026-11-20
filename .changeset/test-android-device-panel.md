---
"@lazysh/client": patch
---

test(android): cover the Device panel against the owned emulator over owned OpenSSH

Adds an owned Android runtime case for the Device panel (#1730, #19): through the real UI over owned OpenSSH with the current `lazysh-agent` and the job's Android SDK, it finds the owned emulator as running, checks the controls its capabilities offer and shows a decoded capture of the emulator's own screen. It never presses reboot, shutdown or boot, since the emulator under test runs the app; the lifecycle half stays a documented limit. Test infrastructure only; the app is unchanged.
