---
name: lazysh-agent-reporting
description: Configure or diagnose lazysh companion lifecycle reporting for supported agent CLIs; distinguish native reports, live multiplexer panes, recorded transcripts and callback health.
---

# lazysh agent reporting

Use the companion on the agent's host and operating-system user. First identify
whether the missing evidence is a lifecycle report, live pane, transcript or hook
health. These sources are separate; a report or transcript never authorizes
terminal input or proves live ownership.

Read the relevant [agent hook reference](https://github.com/mihazs/lazysh/blob/main/docs/agent-hooks.md)
for the selected CLI and installed companion version before configuring it.

## Explicit setup

Managed setup supports Claude Code, Codex, OpenCode, Gemini CLI and Cursor CLI on
qualified platforms. Inspect the exact selected existing profile with
`lazysh-agent hooks status`; install/update or remove only after reviewing its
returned plan, using the corresponding expected plan hash. Preserve foreign
hooks, profile ownership and the user's normal trust/approval policy. Do not
change profiles because the intended one is unavailable. Installed configuration
is not proof that hooks are trusted, enabled, loaded or reporting.

Native print-only paths also include `claude-config`, `codex-config`,
`opencode-plugin`, `gemini-config`, `cursor-config`, `droid-config`, `kimi-config`,
`copilot-config`, `amp-plugin` and `cline-plugin`. Review the printed fragment or
asset and use the selected provider's ordinary setup without overwriting foreign
entries. Cline uses an awaited runtime plugin for **root runs only**; child
working-directory attribution, permission waits and managed Cline setup are
unsupported. Aider's `aider-config`/`aider-hook-status` provide callback health,
never inferred agent session or completion state.

The companion must resolve in the hook's environment. Never bypass provider
trust, enable plugins implicitly, answer permission requests or install separate
`approval-config` handling as a side effect of lifecycle setup. Claude's optional
`--reported-history` is separate and must not be enabled implicitly. Do not
fabricate tmux pane IDs for Herdr or Zellij.

## Diagnose the result

`lazysh-agent snapshot --limit 5` reads reports and can create local state when
absent. Match the exact agent/session, then independently check the app's selected
host and live multiplexer. Stale reports are observations; an empty list does not
prove that no agents are running.

Explicit custom producers may use `ingest --agent generic`; follow the referenced
schema, keep identity accurate and exclude prompts, arguments and credentials.
Never impersonate another integration or inject examples into live reports; use
an isolated `LAZYSH_STATE_DIR` for synthetic tests.
