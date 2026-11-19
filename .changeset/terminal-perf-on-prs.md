---
"@lazysh/client": patch
---

Run the native terminal core's performance gate (`terminal-perf`) on pull requests that touch `packages/terminal-runtime`, `packages/terminal-renderer-wgpu` or the vendored ghostty-vt binding, not only on pushes to `main`, so a regression in parse-to-frame cost, allocations, scrollback rows, memory per session or renderer upload volume shows on the pull request that causes it (#2141, part of #1302). The job keeps its injected-slowdown and injected-allocation self-checks and stays report-only, because making it a required check is a repository ruleset change. CI only; the app, its terminal engine and its defaults are unchanged.
