---
"@lazysh/client": patch
---

ci(checks): skip the OSC 52 clipboard step when its Playwright install was skipped

In the `native-linux-runtimes` job the OSC 52 clipboard step ran after any earlier failure, but the Playwright install steps before it did not, so it failed with "Executable doesn't exist" and added a misleading second failure to the job. It now runs only when the Chromium install succeeded. An earlier failure still fails the job. CI only; the app is unchanged.
