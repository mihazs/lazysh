---
"@lazysh/client": patch
---

Make the installed Windows GUI check able to pass on a hosted runner. Its composite action carried a `timeout-minutes` key the runner refuses, so the action failed to load on `main` and the `continue-on-error` step reported success without executing a case; the bound now sits on the workflow step and a test rejects any composite step key the runner does not accept. Once it ran, every session failed with `DevToolsActivePort file doesn't exist`: the runner is elevated, and an elevated WebView2 host ignores the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable EdgeDriver uses to open the debugging port, so the case now adds, and afterwards removes, the one machine policy entry that reaches `lazysh.exe`. Test-only; the application is unchanged.
