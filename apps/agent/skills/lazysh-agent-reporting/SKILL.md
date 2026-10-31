---
name: lazysh-agent-reporting
description: Configure or diagnose lazysh companion lifecycle reporting from Claude Code, Codex or OpenCode hooks, or the explicit generic event protocol; distinguish reports from live panes and transcripts.
---

# lazysh agent reporting

Use the companion on the same host and operating-system user as the agent.
First determine which evidence is missing: a lifecycle report, a live
multiplexer pane, or a recorded transcript. These are separate sources.
Finding a transcript does not prove that its agent is currently running or
authorize input into a terminal.

## Claude lifecycle integration

`lazysh-agent claude-config` prints a configuration fragment; it does not edit
Claude settings. For requested hook setup, review that fragment and merge only
its entries into the intended Claude profile, preserving existing hooks such as
Herdr's integrations. Verify the command resolves in the agent's environment.
Do not replace the whole settings file or configure a different profile because
the selected one is unavailable.

The ordinary adapter accepts Claude lifecycle events and records bounded
summaries. Its pane association comes from `TMUX_PANE` when present; do not
fabricate a tmux pane ID for Herdr or Zellij. The separate
`claude-config --reported-history` option opts into source hints for supported
Claude events. Do not enable it implicitly or install both forms together.

`approval-config` prints a separate permission-hook fragment. A notification
or `needs_attention` report is not an approval request and cannot authorize an
approval, command, prompt or keystroke. Do not install approval handling as a
side effect of ordinary lifecycle setup.

## Codex and OpenCode lifecycle integration

`lazysh-agent codex-config` prints a fragment for Codex `hooks.json`; it does
not install hooks or change trust. Review and merge it into the exact selected
Codex profile, preserving existing hooks, then complete Codex's normal hook
trust review. Never bypass trust or switch profiles because one is unavailable.

`lazysh-agent opencode-plugin` prints JSON with the plugin's `filename` and
`content`. Review the content before placing it in the selected OpenCode plugin
directory, preserving other plugins. Both integrations need the companion in
their hook environment. Lifecycle reports do not answer permission requests or
prove live pane ownership. The [event reference](https://github.com/mihazs/lazysh/blob/main/docs/agent-hooks.md)
describes the supported events.

## Explicit generic producers

`lazysh-agent ingest --agent generic` reads one event object from standard input.
Its schema has `schemaVersion: 1`, `sessionId`, `agent`, `project`, `state`,
`summary`, and optional `paneId`. Supported states are `working`,
`needs_attention`, and `done`. Keep a producer's session identity stable and its
agent label accurate; never impersonate another integration. Summaries should
describe activity without copying prompts, tool arguments or credentials.

Ingestion writes local lifecycle state. Only submit a real authorized event or
use an isolated `LAZYSH_STATE_DIR` for a synthetic test; do not pollute the user's
live reports with an example. Codex transcript support does not imply an
installed native Codex lifecycle adapter.

Inspect resulting reports with `lazysh-agent snapshot --limit 5`; opening the
store can create local state when absent. Match the intended agent and session,
then verify the app's selected host and live multiplexer independently. A stale
report is not live ownership, and an empty report list does not prove that the
host has no running agents. Report each source and its limits separately.
