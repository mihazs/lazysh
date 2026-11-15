# Remote decisions for a waiting Claude hook

lazysh supports opt-in decisions for the `PermissionRequest` hooks of Claude Code and [Codex](#codex). Each decision returns to the originating waiting hook's stdout. It never types into a terminal, chooses a pane by its current title, starts another agent, or changes permission rules.

Print the configuration fragment:

```sh
lazysh-agent approval-config
```

Merge the printed `PermissionRequest` entry with your existing Claude settings yourself. Keep the ordinary lifecycle hooks from `lazysh-agent claude-config` as well. No command edits settings automatically. The fragment gives the hook a 300-second decision deadline and a slightly longer Claude timeout.

The protocol follows the [official Claude hooks reference](https://code.claude.com/docs/en/hooks#permissionrequest). This event runs when a tool needs permission. Its response uses `hookSpecificOutput.decision.behavior` with `allow` or `deny`. A deny may carry a `message` that Claude reads (at most 500 characters, one line). An allow may carry exactly one of the request's own `permission_suggestions` as `updatedPermissions`; lazysh never sets updated inputs, never builds a rule of its own, and never edits a settings file (Claude Code applies the update where its `destination` says). Other configured policies still apply. PreToolUse, sandbox-network prompts, interactive questions and agent CLIs other than Claude Code and Codex are not claimed as supported approval paths.

An immutable request binds a random UUID, SHA-256 content hash, Claude session, project, inherited tmux pane when present, exact tool name/input, creation time and expiration. Plain terminal hooks can also use the direct response path: the originating hook process supplies the identity, so a multiplexer is not required. The UI must display the complete tool input before an explicit decision.

The hook holds an exclusive OS file lock on its private request lease. Listing hides expired requests and removes requests whose originating process has exited. Resolution requires the exact UUID, hash, session and pane and atomically updates a still-pending, unexpired row. Concurrent decisions have one winner. A cancelled hook releases its lease, and its token cannot target another hook even if session, pane and tool input repeat. Timeout returns a denial. A decision accepted immediately before process cancellation may never reach Claude; acceptance is not proof of tool execution.

The companion emits a bounded `PermissionRequest` summary to the normal event store for the agent board and notifications. It does not infer that a tool started from an approval: normal subsequent lifecycle events establish working/done state.

The separate private state directory `approvals/` contains the approval SQLite database and lease files. Unlike lifecycle summaries, pending approvals intentionally contain exact tool arguments, which can include sensitive data. Directory/database permissions are restricted on Unix; SQLite secure-delete is enabled and consumed, expired or cancelled rows are removed. This is not a promise of forensic erasure from storage or filesystem snapshots. The local user's account remains the trust boundary.

Bounds are 32 simultaneous hooks, 16 KiB of encoded tool arguments per request, 20 requests per list, and 1–600 seconds per hook. Oversized or malformed hooks fail with sanitized diagnostics and no decision output; inspect Claude's normal permission surface. Each list entry contains enough identity to resolve. When Claude suggested permission updates, the entry also lists them as `options`, rebuilt field by field from the payload and covered by the request hash: allow rules (`addRules` with `behavior` allow), a mode other than `bypassPermissions` (`setMode`) and added directories (`addDirectories`), at most 8 each bounded in size. Deny and ask rules, removals, unknown types, unknown destinations and `bypassPermissions` are dropped, so they are never offered. An older companion omits `options` (an empty list is always listed), so the client offers it no message form:

```sh
lazysh-agent approval-list --limit 20
lazysh-agent approval-resolve --id REQUEST_UUID --expected-hash HASH --session-id SESSION_ID --pane-id '%7' --decision deny
```

Omit `--pane-id` only when the listed pane is null. `--option N` (an index into the listed `options`, allow only) allows with that suggestion; `--message TEXT` (deny only) denies with a message. An out-of-range index, an option with a deny, a message with an allow and a message that is blank, longer than 500 characters or has a control character are refused with no output and leave the request pending. A stale or mismatched resolution exits unsuccessfully with no success JSON. Integration tests use fixture hook subprocesses to verify exact identity, concurrent resolution, cancellation, timeout, replay refusal and payload removal. No real Claude session was used to certify host-version behavior.

## Codex

Codex has the same `PermissionRequest` hook, and a Codex prompt is answered the same way: through the hook's own decision, never by typing into the pane.

```sh
lazysh-agent approval-config --agent codex
```

Merge the printed entry into Codex's `hooks.json` yourself (keep the lifecycle hooks from `lazysh-agent codex-config` too) and review it in Codex's own hook trust prompt; lazysh never accepts hook trust. The decision follows the [Codex hooks reference](https://learn.chatgpt.com/docs/hooks): `hookSpecificOutput.decision.behavior` is `allow` or `deny`, and a deny may carry a message Codex shows. Codex fails closed on `updatedInput` and `updatedPermissions`, so lazysh never sends them. The request is the same immutable record as Claude Code's (random UUID, hash over agent, session, project, pane, tool name and input, expiry), listed by `approval-list` with `"agent":"codex"` and answered by `approval-resolve` with the same identity, so one agent's hash never answers another agent's request.

Codex differs from Claude Code in two ways that change what a person at the terminal sees:

- Codex draws its own approval prompt only after the hook returns. While a request is pending the terminal shows "Running hook" and no prompt, so the terminal cannot answer it first. **Esc** in the terminal interrupts the turn, which ends the hook and removes the request; nothing runs.
- A request nobody answers before its deadline gives **no decision**, and Codex then shows its normal prompt in the terminal. The fragment waits 120 seconds (`--timeout-seconds` changes it; keep Codex's own `timeout` longer). Claude Code's expired requests are denied, but a denial here would hide a prompt the person at the keyboard can still answer. A hook that fails, or whose tool input is not a JSON object or is larger than 16 KiB, likewise leaves Codex to ask in the terminal.

Checked with the real Codex CLI 0.167.0 driving the real `lazysh-agent` hook against a local stand-in model server in a private tmux: the pasted fragment loads after trust, the request carries Codex's session id and tmux pane, an allow runs the command, a deny with a message shows "Blocked by hook" with that message and runs nothing, a wrong pane is refused, Esc removes the request, and an expired request shows Codex's own prompt. That run is manual: CI has no Codex CLI, so CI runs the hook subprocess tests only. Codex's other approval requests (MCP tools, `apply_patch`, network access) and a Codex on another host or in Herdr or Zellij were not exercised. The Agent view dock still lists Claude Code's requests only; a Codex request is answered from the Agents board.

## Choosing an option

The approval card and the Agent view dock show Allow and Deny, then each suggested update as its own button and **Deny with a message**. A suggestion is never a default and never one tap: it opens a confirmation that names where Claude Code will keep it (this session only, the project's local settings, the shared project settings or the user settings) and shows the exact rule, mode or folders; **Cancel** sends nothing. The message of a denial is a single line the agent reads as the reason. A Codex request lists no suggestions (Codex takes none), so its card offers Allow, Deny and **Deny with a message**. The other agents have no approval hook here, so their prompts stay in the terminal.

## In the Agent view

On a native tmux session, the Agent view shows the pending requests of the Claude Code session whose hook report names its pane (and no other) above the conversation. A decision is the same hash-bound `resolve_agent_approval` call as on the Agents board, sent only after the pane and the single reported session are checked again, and the buttons ignore taps for 400 ms after a card appears. Nothing is typed into the terminal, so switching to the terminal shows the prompt already answered through the hook. Before it sends, the view lists the host's pending requests once more: a request answered in the terminal first (or on another device) is no longer listed, so nothing is sent and the view says it was already answered. A conversation chosen from the session list, and any pane without exactly one matching report, shows no requests there; the Agents board still lists them.
