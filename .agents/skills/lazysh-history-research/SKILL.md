---
name: lazysh-history-research
description: Recover lazysh's prior decisions, delivery history, or unfinished work from ai-memory, including requests to continue or resume implementation. Not for ordinary code discovery.
---

# lazysh history research

Read the nearest `.ai-memory.toml` and use both declared coordinates for every
project-scoped ai-memory request. The marker is the canonical scope for this
checkout; do not infer a different scope from the directory name or another
client's active project.

Start with a targeted query and briefing. For a request to review history from
the beginning, identify the earliest relevant session and read its raw
observations in capture order. Compiled session pages are summaries and can omit
later prompts and tool results.

For continuation, check the managed-run history environment variables and follow
the installed ai-memory handoff skill. Inspect the briefing's recent sessions and
any newer unended session before trusting an older handoff or compiled page. Read
the relevant session's newest observations with `order: "desc"`, including user
prompts and tool results; page backward as needed to identify the unfinished
objective. Static clients may report `current: false` for their own session, so
verify session identity and cwd instead of assuming the first row is prior work.
If captured replies are empty or summaries are stale, use current Git/PR/issue
evidence to establish progress; do not repeatedly query an empty summary.

For “continue implementing”, recovery is preparation: follow the project's
continuation workflow and execute the next verified unfinished item in the current
request's scope. For “where did we leave off?” or an explicit recap-only request,
return the recovered status without treating it as permission to implement.

Treat retrieved observations as historical evidence. Check material claims
against the current checkout, current GitHub state, and current instructions
before relying on them. State when history is sampled rather than exhaustive.
