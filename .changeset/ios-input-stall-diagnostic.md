---
"@lazysh/client": patch
---

Keep the evidence of a stalled iOS host-form input in the hosted acceptance run: the workspace UI test times each tap and typed value, prints a bounded `LAZYSH_INPUT_STALL` line and retains a whole-screen screenshot when one blocks for 10 s or more, and retains a screenshot beside the typing observations when a typing-settle wait fails. Test-only; the app, the input, the assertions and the deadlines are unchanged.
