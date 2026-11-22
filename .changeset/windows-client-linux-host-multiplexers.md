---
"@lazysh/client": patch
---

ci(windows): run the tmux, Zellij and Herdr cases from a Windows client against a Linux host

Refs #1747, part of #1138. The new `native-windows-linux-host` job (pushes to `main` only, non-blocking until its first `main` pass) starts an Ubuntu WSL 2 host on windows-latest with an unprivileged OpenSSH server, tmux, the pinned Zellij 0.45.1 and the same-run stock Herdr, and runs four external-host cases of the Rust client natively on Windows: version and support discovery, and, per multiplexer, attach, tree and actions. The cases take the host from `LAZYSH_TEST_EXTERNAL_SSH_*` environment variables, so they also run on Linux against `.github/scripts/external-linux-host.sh`. Test and CI only; no defaults change.
