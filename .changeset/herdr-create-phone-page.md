---
"@lazysh/client": patch
---

fix(client): show the Herdr New workspace and New worktree flow as a full-screen page on phones

Issue #588. The flow is a long form with a command review and a result, but it opened as a bottom sheet that left the form and its **Cancel** / **Review commands** buttons squeezed under a partial-height card. On a phone window (up to 600 px wide) it now fills the screen under a header whose Close button stays visible while the form scrolls, including at short heights and with the keyboard open; Back, Escape, the explicit command review and the wait for the host to finish are unchanged. Larger windows keep the same centred dialog. No default changes.
