---
"@lazysh/client": patch
---

feat(multiplexers): run the guarded Herdr input in local terminals

Run the guarded Herdr input in local terminals: a local `herdr` that admits the guard is attached with `--guarded-attach`, its private first frame is taken off the PTY before any byte reaches the terminal, the ticket is claimed through a one-shot `herdr api guarded` child, and the same guard actor then serves `herdr_chat` for `local:` ids over the same receipts, budgets and access leases as SSH. A claim that fails closes the terminal and never falls back to an ordinary attach. The interface does not offer the local attach yet, and SSH Herdr behaves as before.
