---
"@lazysh/client": patch
---

Make the installed Windows GUI check blocking. It passed in a `main` run (run 43790076928, push of `b5668f94`, `native-desktop (windows-latest)`: the identity, `--host` and `--dir` scenarios, `3 pass`, `0 fail`), which was the condition for removing `continue-on-error` from its workflow step, so a failure of the installed application's window, saved-host dialog or singleton delivery on Windows now fails the job instead of being reported as a success. Test-only; the application is unchanged.
